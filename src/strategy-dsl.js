import { ACTIONS } from './rules.js';
import { hashObject } from './replay.js';
import { runMatch } from './engine.js';
import { BUILTIN_AGENTS } from './agents.js';

/**
 * Hosted strategy DSL.
 *
 * A hosted strategy is DATA, not code: an ordered list of
 * `when -> action` rules over the public observation. The server interprets
 * it with no eval, no vm, no user-supplied functions. This lets an MCP-only
 * agent client (Claude Code / CodeBuddy / Cursor / OpenCode / ...) author and
 * submit a strategy and have the league run it 24/7, without the user running
 * a long-lived WebSocket process.
 */

const PATH_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/;
const BLOCKED_KEYS = new Set(['constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']);
const COMPARATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in']);
const MAX_RULES = 64;
const MAX_TEXT = 120;

export const DSL_VERSION = 'afl-strategy/1';

function readPath(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (BLOCKED_KEYS.has(key) || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function testValue(actual, spec) {
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    const keys = Object.keys(spec);
    if (!keys.length || !keys.every((k) => COMPARATORS.has(k))) {
      throw new Error('a condition value may only use gt/gte/lt/lte/eq/ne/in');
    }
    if ('eq' in spec && actual !== spec.eq) return false;
    if ('ne' in spec && actual === spec.ne) return false;
    if ('in' in spec) {
      if (!Array.isArray(spec.in) || !spec.in.includes(actual)) return false;
    }
    for (const [op, bound] of Object.entries(spec)) {
      if (!['gt', 'gte', 'lt', 'lte'].includes(op)) continue;
      if (typeof actual !== 'number' || typeof bound !== 'number') return false;
      if (op === 'gt' && !(actual > bound)) return false;
      if (op === 'gte' && !(actual >= bound)) return false;
      if (op === 'lt' && !(actual < bound)) return false;
      if (op === 'lte' && !(actual <= bound)) return false;
    }
    return true;
  }
  return actual === spec;
}

function validateCondition(when, label) {
  if (when === undefined || when === null) return {};
  if (typeof when !== 'object' || Array.isArray(when)) throw new Error(label + ' must be an object of field paths');
  const out = {};
  for (const [path, spec] of Object.entries(when)) {
    if (!PATH_RE.test(path) || path.split('.').some((k) => BLOCKED_KEYS.has(k))) {
      throw new Error('invalid field path: ' + path);
    }
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) testValue(0, spec); // validates comparator names
    out[path] = spec;
  }
  return out;
}

function conditionMatches(when, obs) {
  for (const [path, spec] of Object.entries(when)) {
    if (!testValue(readPath(obs, path), spec)) return false;
  }
  return true;
}

/**
 * Every rule index whose condition matches this observation, in declaration
 * order. `decide` only ever returns the first one, so the difference between
 * this list and the fired index is a shadowed rule - the single most common
 * reason a hand-written strategy "has the rule but never uses it".
 */
export function matchingRules(input, obs) {
  const s = input.version === DSL_VERSION ? input : validateStrategy(input);
  const hits = [];
  for (let i = 0; i < s.rules.length; i += 1) {
    const r = s.rules[i];
    if (!conditionMatches(r.when, obs)) continue;
    if (r.whenAny && !r.whenAny.some((w) => conditionMatches(w, obs))) continue;
    hits.push(i);
  }
  return hits;
}

export function validateStrategy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('strategy must be a JSON object');
  const name = String(input.name || 'unnamed').slice(0, MAX_TEXT);
  const defaultAction = input.defaultAction || 'block';
  if (!ACTIONS.includes(defaultAction)) throw new Error('defaultAction must be one of: ' + ACTIONS.join(', '));
  if (!Array.isArray(input.rules) || input.rules.length === 0 || input.rules.length > MAX_RULES) {
    throw new Error('rules must be a non-empty array (max ' + MAX_RULES + ')');
  }
  const rules = input.rules.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error('rule ' + i + ' must be an object');
    if (!ACTIONS.includes(r.action)) throw new Error('rule ' + i + ': action must be one of: ' + ACTIONS.join(', '));
    const when = validateCondition(r.when, 'rule ' + i + '.when');
    let whenAny = null;
    if (r.whenAny !== undefined) {
      if (!Array.isArray(r.whenAny) || r.whenAny.length === 0 || r.whenAny.length > 8) {
        throw new Error('rule ' + i + '.whenAny must be an array of 1-8 condition objects');
      }
      whenAny = r.whenAny.map((w, j) => validateCondition(w, 'rule ' + i + '.whenAny[' + j + ']'));
    }
    return {
      action: r.action,
      when,
      ...(whenAny ? { whenAny } : {}),
      note: String(r.note || '').slice(0, MAX_TEXT),
    };
  });
  return { version: DSL_VERSION, name, defaultAction, rules };
}

export function strategyHash(input) {
  return hashObject(validateStrategy(input)).slice(0, 16);
}

export function decide(strategy, obs) {
  const s = strategy.version === DSL_VERSION ? strategy : validateStrategy(strategy);
  for (let i = 0; i < s.rules.length; i += 1) {
    const r = s.rules[i];
    if (!conditionMatches(r.when, obs)) continue;
    if (r.whenAny && !r.whenAny.some((w) => conditionMatches(w, obs))) continue;
    return { action: r.action, ruleIndex: i, note: r.note, name: s.name };
  }
  return { action: s.defaultAction, ruleIndex: -1, note: 'fallback', name: s.name };
}

export function policyFromStrategy(input) {
  const s = validateStrategy(input);
  return { strategy: s, policy: (obs) => decide(s, obs).action };
}

export function strategyTemplate() {
  return {
    name: 'anti-air-zoner',
    defaultAction: 'block',
    rules: [
      { whenAny: [{ 'self.hitstun': { gt: 0 } }, { 'self.blockstun': { gt: 0 } }], action: 'block', note: '硬直期间不浪费输入' },
      { when: { 'derived.threat': 'jump_in', 'derived.inRange.dp': true }, action: 'dp', note: '跳入必升龙' },
      { when: { 'derived.opponentBlocking': true, 'derived.distanceX': { lt: 52 }, 'derived.inRange.throw': true }, action: 'throw', note: '贴身破防' },
      { when: { 'derived.projectileIncoming': true, 'derived.distanceX': { lt: 160 } }, action: 'block', note: '挡波' },
      { when: { 'derived.distanceX': { lt: 100 }, 'self.inCorner': true, 'derived.inRange.mk': true }, action: 'mk', note: '被逼版边改反击' },
      { when: { 'derived.distanceX': { lt: 100 } }, action: 'walk_b', note: '拉开距离' },
      { when: { 'derived.distanceX': { gte: 130 }, 'self.actionable': true }, action: 'fireball', note: '远距发波' },
      { when: { 'derived.inRange.hp': true, 'derived.frameAdvantage': { gte: -3 } }, action: 'hp' },
      { when: { 'derived.inRange.mp': true }, action: 'mp' },
      { action: 'block', note: '兜底防御' },
    ],
  };
}

export function describeDsl() {
  return [
    '# Hosted strategy DSL ' + DSL_VERSION,
    '',
    'A strategy is a JSON object. It is DATA: the server interprets it, never executes your code.',
    '',
    '```json',
    JSON.stringify(strategyTemplate(), null, 2),
    '```',
    '',
    '## Shape',
    '- `name`: short label, recorded with the version hash.',
    '- `defaultAction`: fallback when no rule matches or a tick times out. One of: ' + ACTIONS.join(', '),
    '- `rules`: ordered list, max 64. First matching rule wins.',
    '  - `when`: object of `field.path -> condition`, all must match (AND).',
    '  - `whenAny`: array of condition objects, any one must match (OR). Optional.',
    '  - `action`: exactly one legal action string.',
    '  - `note`: optional, shown in the decision event stream.',
    '',
    '## Condition values',
    '- Literal string / number / boolean: strict equality, e.g. `"derived.threat": "jump_in"`.',
    '- Comparator object: `{ "gt": 0 }`, `{ "gte": -3 }`, `{ "lt": 52 }`, `{ "lte": 100 }`,',
    '  `{ "eq": true }`, `{ "ne": "neutral" }`, `{ "in": ["jump_in", "projectile"] }`.',
    '',
    '## Field paths',
    'Any public observation path, for example:',
    '`self.hp`, `self.meter`, `self.x`, `self.moveFrame`, `self.hitstun`, `self.actionable`,',
    '`self.canCancel`, `self.inCorner`, `opponent.hp`, `opponent.state`, `opponent.moveId`,',
    '`derived.distanceX`, `derived.frameAdvantage`, `derived.punishable`, `derived.threat`,',
    '`derived.opponentAirborne`, `derived.opponentBlocking`, `derived.projectileIncoming`,',
    '`derived.inRange.hp`, `derived.inRange.dp`, `derived.inRange.fireball`, `timer`, `tick`.',
    'Paths are read with own-property lookup only; prototype keys are rejected.',
    '',
    '## Guarantees',
    '- No eval, no functions, no network, no filesystem. Pure synchronous interpretation.',
    '- Deterministic: the same strategy JSON always produces the same hash and the same actions.',
    '- Replayed and auditable: every tick records which rule index fired.',
  ].join('\n');
}

/**
 * Offline evaluation against built-in baselines. Runs real kernel matches,
 * no network and no WebSocket. Used by MCP `simulate_strategy`.
 */
export function simulateStrategy(input, { opponents = ['brawler', 'zoner', 'turtle'], seeds = [101, 202, 303] } = {}) {
  const s = validateStrategy(input);
  const { policy } = policyFromStrategy(s);
  const rows = [];
  for (const id of opponents.slice(0, 4)) {
    const opp = BUILTIN_AGENTS.find((a) => a.id === id);
    if (!opp) continue;
    let wins = 0; let losses = 0; let draws = 0; let hp = 0; let ticks = 0;
    for (const seed of seeds.slice(0, 5)) {
      const r = runMatch({
        seed,
        matchId: 'sim_' + id + '_' + seed,
        policyA: policy,
        policyB: opp.policy,
        defaultActionA: s.defaultAction,
        defaultActionB: 'block',
        agents: [{ id: 'hosted-sim' }, { id: opp.id }],
      });
      if (r.result.winner === 'a') wins += 1;
      else if (r.result.winner === 'b') losses += 1;
      else draws += 1;
      hp += r.result.hpA;
      ticks += r.result.ticks;
    }
    const n = Math.min(seeds.length, 5);
    rows.push({
      opponent: id,
      wins, losses, draws,
      winRate: Math.round((wins / n) * 100),
      avgHpLeft: Math.round(hp / n),
      avgTicks: Math.round(ticks / n),
    });
  }
  const total = rows.reduce((acc, r) => acc + r.wins, 0);
  const games = rows.length * Math.min(seeds.length, 5);
  return {
    versionHash: hashObject(s).slice(0, 16),
    games,
    wins: total,
    overallWinRate: games ? Math.round((total / games) * 100) : 0,
    rows,
    note: 'These are offline deterministic matches against built-in baselines, not ranked matches. Ranked results depend on the opponent pool.',
  };
}
