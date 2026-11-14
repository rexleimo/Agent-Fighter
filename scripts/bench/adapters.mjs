// ============================================================================
// Model adapters — the plug-in layer that makes the harness model-agnostic.
//
// An adapter exposes two capabilities, one per benchmark mode:
//   authorStrategy(context) -> strategy JSON   (hosted mode: reasoning)
//   decide(obs) -> { action, modelCalls }       (realtime mode: agency)
//
// `openaiAdapter` talks to any OpenAI-compatible /chat/completions endpoint, so
// you can benchmark GPT / Claude / Qwen / local models behind one interface.
// The `reference*` adapters are deterministic and need NO network or API key:
// they exist so the harness itself can be self-tested and so a report can carry
// a known baseline. The harness never trusts an adapter's self-reported
// modelCalls for scoring — latency and budget are measured by the runner.
// ============================================================================
import { ACTIONS } from '../../src/rules.js';
import { validateAction } from '../../src/protocol.js';
import { describeDsl, strategyTemplate, validateStrategy } from '../../src/strategy-dsl.js';
import { getBuiltinAgent } from '../../src/agents.js';

const ACTION_LIST = ACTIONS.join(', ');

/** Compact observation for the realtime prompt (mirrors examples/llm-agent). */
export function compactObservation(obs) {
  return {
    tick: obs.tick,
    hp: [obs.self.hp, obs.opponent.hp],
    meter: [obs.self.meter, obs.opponent.meter],
    distanceX: obs.derived.distanceX,
    frameAdvantage: obs.derived.frameAdvantage,
    threat: obs.derived.threat,
    inRange: obs.derived.inRange,
    projectileIncoming: obs.derived.projectileIncoming,
    self: { state: obs.self.state, moveId: obs.self.moveId, hitstun: obs.self.hitstun, blockstun: obs.self.blockstun, canCancel: obs.self.canCancel, actionable: obs.self.actionable },
    opponent: { state: obs.opponent.state, moveId: obs.opponent.moveId, hitstun: obs.opponent.hitstun, airborne: obs.derived.opponentAirborne },
    history: (obs.history || []).slice(-4),
  };
}

async function chat(cfg, messages, { maxTokens, timeoutMs }) {
  const res = await fetch(cfg.base.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature, seed: cfg.seed, max_tokens: maxTokens, messages }),
  });
  if (!res.ok) throw new Error('llm http ' + res.status);
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

/** Pull a JSON object out of a model reply that may be wrapped in code fences. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON object in model reply');
  return JSON.parse(body.slice(start, end + 1));
}

const AUTHOR_SYSTEM = `You are a fighting-game strategy engineer for the Agent Fighting League.
You output ONLY a single JSON object: a declarative strategy in the AFL DSL. No prose, no code fences.
The strategy is DATA interpreted by a deterministic server — never code. First matching rule wins;
end with a safe fallback rule. Use the observation field paths and comparators exactly as documented.`;

const DECIDE_SYSTEM = `You are a fighting game AI. Reply with EXACTLY ONE action id, nothing else.
Allowed: ${ACTION_LIST}.
dp is an anti-air (invulnerable startup, long recovery) — only when the opponent jumps in and is in range.
fireball is for long distance. Check derived.inRange before attacking. Block when projectileIncoming or in hitstun.
Prefer hp at close range, mp at mid range. Manage meter (ex costs 50, super costs 100).`;

/**
 * OpenAI-compatible adapter. cfg: { base, key, model, temperature, authorTimeoutMs,
 * decideTimeoutMs, maxRetries }. temperature defaults to 0 for reproducibility.
 */
export function openaiAdapter(cfg = {}) {
  const conf = {
    base: cfg.base || process.env.AFL_LLM_BASE || 'https://api.openai.com/v1',
    key: cfg.key || process.env.AFL_LLM_KEY || '',
    model: cfg.model || process.env.AFL_LLM_MODEL || 'gpt-4o-mini',
    temperature: Number(cfg.temperature ?? 0),
    // Best-effort reproducibility: OpenAI-compatible APIs accept a seed. Providers
    // do not guarantee determinism even with it, so reports record it as metadata
    // and rigorous comparisons still average over many seeds/games.
    seed: Number(cfg.seed ?? process.env.AFL_LLM_SEED ?? 42),
    authorTimeoutMs: Number(cfg.authorTimeoutMs || 60000),
    decideTimeoutMs: Number(cfg.decideTimeoutMs || 30000),
    maxRetries: Number(cfg.maxRetries ?? 2),
  };
  if (!conf.key) throw new Error('openaiAdapter needs an API key (AFL_LLM_KEY or cfg.key); use a reference adapter for offline self-test');

  return {
    id: `openai:${conf.model}`,
    kind: 'model',
    config: { base: conf.base, model: conf.model, temperature: conf.temperature, seed: conf.seed },

    async authorStrategy(context) {
      const user = [
        'Design a strong 1v1 strategy for fighter "' + context.fighter + '".',
        '',
        context.dsl,
        '',
        'Legal actions: ' + ACTION_LIST + '.',
        'Return ONLY the JSON strategy object (name, defaultAction, rules). Aim to beat aggressive, zoning and defensive opponents.',
      ].join('\n');
      let lastErr = null;
      for (let attempt = 0; attempt <= conf.maxRetries; attempt += 1) {
        try {
          const text = await chat(conf, [
            { role: 'system', content: AUTHOR_SYSTEM },
            { role: 'user', content: user },
            ...(lastErr ? [{ role: 'user', content: 'Previous attempt was invalid: ' + lastErr.message + '. Return a corrected JSON strategy only.' }] : []),
          ], { maxTokens: 2000, timeoutMs: conf.authorTimeoutMs });
          return validateStrategy(extractJson(text));
        } catch (e) { lastErr = e; }
      }
      throw new Error('authorStrategy failed after retries: ' + (lastErr && lastErr.message));
    },

    async decide(obs) {
      const text = await chat(conf, [
        { role: 'system', content: DECIDE_SYSTEM },
        { role: 'user', content: JSON.stringify(compactObservation(obs)) },
      ], { maxTokens: 8, timeoutMs: conf.decideTimeoutMs });
      const action = text.toLowerCase().replace(/[^a-z_]/g, '');
      if (!validateAction(action)) throw new Error('invalid action: ' + text);
      return { action, modelCalls: 1 };
    },
  };
}

/** Deterministic reference author: the canonical template strategy. No network. */
export function referenceAuthorAdapter() {
  return {
    id: 'reference:template',
    kind: 'reference',
    config: { strategy: 'strategyTemplate()' },
    async authorStrategy() { return validateStrategy(strategyTemplate()); },
    async decide(obs) { return { action: getBuiltinAgent('brawler').policy(obs), modelCalls: 0 }; },
  };
}

/** Deterministic reference author that only blocks — a weak floor used by the
 *  self-test to prove the harness discriminates skill (template must beat it). */
export function passiveAuthorAdapter() {
  return {
    id: 'reference:passive',
    kind: 'reference',
    config: { strategy: 'block-only' },
    async authorStrategy() { return validateStrategy({ name: 'passive', defaultAction: 'block', rules: [{ action: 'block' }] }); },
    async decide() { return { action: 'block', modelCalls: 0 }; },
  };
}

/** Deterministic reference decision policy (a builtin rule agent). No network. */
export function referenceDecideAdapter(id = 'brawler') {
  const agent = getBuiltinAgent(id);
  if (!agent) throw new Error('unknown reference agent ' + id);
  return {
    id: `reference:${id}`,
    kind: 'reference',
    config: { policy: id, versionHash: agent.versionHash },
    async authorStrategy() { return validateStrategy(strategyTemplate()); },
    async decide(obs) { return { action: agent.policy(obs), modelCalls: 0 }; },
  };
}

/** Resolve an adapter from CLI flags. Default: reference (offline, no key needed). */
export function adapterFromArgs(args) {
  const kind = args.adapter || (process.env.AFL_LLM_KEY ? 'openai' : 'reference');
  if (kind === 'openai') return openaiAdapter({ model: args.model, temperature: args.temperature });
  if (kind === 'passive') return passiveAuthorAdapter();
  if (kind === 'reference') {
    return args.mode === 'realtime' ? referenceDecideAdapter(args['ref-agent'] || 'brawler') : referenceAuthorAdapter();
  }
  throw new Error(`unknown adapter "${kind}" (use openai | reference | passive)`);
}

export { describeDsl, ACTION_LIST };