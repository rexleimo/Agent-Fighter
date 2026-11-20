import { ACTIONS } from './rules.js';
import { lockedActions } from './kits/index.js';
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
const COMPARATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in', 'includes']);
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
      throw new Error('a condition value may only use gt/gte/lt/lte/eq/ne/in/includes');
    }
    if ('eq' in spec && actual !== spec.eq) return false;
    if ('ne' in spec && actual === spec.ne) return false;
    if ('in' in spec) {
      if (!Array.isArray(spec.in) || !spec.in.includes(actual)) return false;
    }
    if ('includes' in spec) {
      if (!Array.isArray(actual) || !actual.includes(spec.includes)) return false;
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
  const defaultAction = input.defaultAction || 'walk_f';
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

/**
 * Non-throwing lint: returns structured warnings/errors after a strategy has
 * passed hard validation. `fighterId` enables the archetype-lock check; a
 * strategy an agent explicitly wrote is never rewritten, only advised on.
 */
const KNOWN_FIELD_PATHS = new Set([
  'tick', 'frame', 'timer', 'deadlineMs',
  'self.hp', 'self.meter', 'self.x', 'self.y', 'self.vx', 'self.vy', 'self.facing',
  'self.state', 'self.fighterId', 'self.moveId', 'self.moveFrame', 'self.moveFrames',
  'self.recovery', 'self.hitstun', 'self.blockstun', 'self.combo', 'self.comboDamage',
  'self.invuln', 'self.wakeup', 'self.armorLeft', 'self.dodgeCd', 'self.parrying',
  'self.phase', 'self.canCancel', 'self.cancelInto', 'self.cancelIn', 'self.buffered',
  'self.canEx', 'self.canSuper', 'self.inCorner', 'self.actionable',
  'self.availableActions', 'self.lockedActions', 'self.counterWindow',
  'opponent.hp', 'opponent.meter', 'opponent.x', 'opponent.y', 'opponent.state',
  'opponent.moveId', 'opponent.moveFrame', 'opponent.recovery', 'opponent.hitstun',
  'opponent.blockstun', 'opponent.invuln', 'opponent.dodgeCd', 'opponent.fighterId',
  'derived.distanceX', 'derived.frameAdvantage', 'derived.punishable',
  'derived.opponentAirborne', 'derived.opponentAttacking', 'derived.opponentBlocking',
  'derived.opponentDodging', 'derived.opponentEvading', 'derived.opponentParrying',
  'derived.threat', 'derived.inRange', 'derived.projectileIncoming',
  'derived.opponentActiveHitboxes', 'derived.boxOverlap', 'derived.inHitstun',
  'derived.canCancelInto', 'derived.meterBars',
  'derived.opponentStartupLeft', 'derived.opponentRecoveryLeft', 'derived.opponentMoveReach',
  'derived.incomingHit', 'derived.incomingProjectileIn',
  'derived.passiveFrames', 'derived.stallLevel', 'derived.opponentStallLevel',
  'derived.framesLeft', 'derived.hpLead', 'derived.damageLead',
  'derived.lastDecision', 'derived.fallbackTicks', 'derived.ruleFires',
  'frameData.phase', 'frameData.frame', 'frameData.cancelable', 'frameData.hitLanded',
  'frameData.cancelInto', 'frameData.startup', 'frameData.active', 'frameData.recovery',
]);

function pathsInRule(r) {
  const out = [];
  const walk = (w) => { if (w && typeof w === 'object') out.push(...Object.keys(w)); };
  walk(r.when);
  if (Array.isArray(r.whenAny)) r.whenAny.forEach(walk);
  return out;
}

export function lintStrategy(input, fighterId = null) {
  const warnings = [];
  const errors = [];
  let s;
  try {
    s = validateStrategy(input);
  } catch (e) {
    return { warnings, errors: [String(e.message || e)] };
  }
  const passiveFallback = new Set(['idle', 'block', 'walk_b']);
  if (passiveFallback.has(s.defaultAction)) {
    warnings.push({ code: 'passive_fallback', message: `defaultAction "${s.defaultAction}" 是消极兜底：规则全不匹配时会站防/后退，规则 2.2 下会被判消极判罚。建议 walk_f 或 walk_f 接近。` });
  }
  const locked = fighterId ? lockedActions(fighterId) : [];
  for (let i = 0; i < s.rules.length; i += 1) {
    const r = s.rules[i];
    if (locked.includes(r.action)) {
      errors.push({ code: 'action_locked', ruleIndex: i, message: `rules[${i}] 的 ${r.action} 被本角色锁定：改用 dash/walk_f 接近。` });
    }
    for (const p of pathsInRule(r)) {
      if (!KNOWN_FIELD_PATHS.has(p) && !/^derived\.inRange\./.test(p)) {
        warnings.push({ code: 'unknown_path', ruleIndex: i, message: `rules[${i}] 引用了未知字段路径 ${p}：读不到值，这条规则可能永不触发。` });
      }
    }
  }
  const last = s.rules[s.rules.length - 1];
  if (last && (last.when && Object.keys(last.when).length || last.whenAny)) {
    warnings.push({ code: 'unconditional_fallback', message: '最后一条规则必须无条件（无 when/whenAny），否则规则全不匹配时会走 defaultAction。' });
  }
  return { warnings, errors };
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

// The defensive layer every template shares: read the startup, not the hit.
// Reading `incomingHit` during opponent startup is what makes dodge/parry a
// decision instead of a guess; `opponentRecoveryLeft` is the punish window.
const DEFENSE_LAYER = [
  { whenAny: [{ 'self.hitstun': { gt: 0 } }, { 'self.blockstun': { gt: 0 } }], action: 'block', note: '硬直中站防，不浪费输入' },
  { when: { 'derived.incomingHit': true, 'self.dodgeCd': { lte: 0 }, 'self.actionable': true }, action: 'dodge', note: '读到起手就闪（读不准用 parry）' },
  { when: { 'derived.incomingProjectileIn': { lte: 3 } }, action: 'parry', note: '招架吃弹道且回气' },
  { when: { 'derived.opponentRecoveryLeft': { gte: 6 }, 'derived.inRange.lp': true }, action: 'lp', note: '确反' },
];

// A single unconditional advancing fallback closes every template. A passive
// fallback (block/idle/walk_b) is lint-warned and loses to anti-stall.
const ADVANCING_FALLBACK = { action: 'walk_f', note: '兜底：接近对手，拒绝站桩' };

/**
 * Three archetype-layered templates. Anyone who copies one gets a playbook
 * that fits the fighter, including the read-driven defensive layer. The old
 * generic template is gone: it taught every kit to zone at range.
 */
export function strategyTemplates() {
  return {
    melee: {
      name: 'melee-pressure',
      defaultAction: 'walk_f',
      rules: [
        ...DEFENSE_LAYER,
        { when: { 'derived.opponentBlocking': true, 'derived.inRange.throw': true }, action: 'throw', note: '贴身投技破防（也破闪避/招架）' },
        { when: { 'derived.inRange.hp': true, 'derived.frameAdvantage': { gte: -3 } }, action: 'hp' },
        { when: { 'derived.inRange.special': true }, action: 'special', note: '中距用本角色 special' },
        { when: { 'derived.inRange.mk': true }, action: 'mk' },
        // Far range: NEVER fireball - close with walk_f / dash.
        { when: { 'derived.distanceX': { gt: 220 }, 'self.actionable': true }, action: 'dash', note: '远距用 dash 接近，不发波' },
        ADVANCING_FALLBACK,
      ],
    },
    zoner: {
      name: 'zoner-space',
      defaultAction: 'walk_f',
      rules: [
        ...DEFENSE_LAYER,
        { when: { 'derived.inRange.fireball': true, 'self.availableActions': { includes: 'fireball' } }, action: 'fireball', note: '先查 availableActions 再发波' },
        { when: { 'derived.distanceX': { lt: 120 }, 'derived.inRange.throw': true }, action: 'throw', note: '贴身别发波，投技破防' },
        { when: { 'derived.distanceX': { lt: 130 } }, action: 'walk_b', note: '对手贴身改后撤穿身' },
        { when: { 'derived.inRange.hp': true }, action: 'hp' },
        ADVANCING_FALLBACK,
      ],
    },
    balanced: {
      name: 'balanced-counter',
      defaultAction: 'walk_f',
      rules: [
        ...DEFENSE_LAYER,
        { when: { 'derived.distanceX': { gt: 360 }, 'derived.inRange.fireball': true, 'self.availableActions': { includes: 'fireball' } }, action: 'fireball', note: '只在远距发波' },
        { when: { 'derived.inRange.hp': true, 'derived.frameAdvantage': { gte: -3 } }, action: 'hp' },
        { when: { 'derived.inRange.special': true }, action: 'special' },
        { when: { 'derived.inRange.mp': true }, action: 'mp' },
        ADVANCING_FALLBACK,
      ],
    },
  };
}

// Backwards compatible: get_strategy_template / describeDsl keep returning the
// melee template as the safe default.
export function strategyTemplate() {
  return strategyTemplates().melee;
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
    'Predictions (rules 2.2): `derived.opponentStartupLeft`, `derived.opponentRecoveryLeft`,',
    '`derived.incomingHit`, `derived.incomingProjectileIn`, plus the anti-stall readout',
    '`derived.passiveFrames`, `derived.stallLevel`, `derived.hpLead`, `derived.damageLead`.',
    '`self.availableActions` is an array: test it with `{ "includes": "fireball" }`.',
    'Paths are read with own-property lookup only; prototype keys are rejected.',
    '',
    '## Hard checklist',
    '- Use `derived.inRange.*` for reach; never re-derive reach from `distanceX`.',
    '- The last rule must be unconditional (no `when`/`whenAny`).',
    '- Check `self.availableActions` before ever using `fireball`.',
    '- Do not fall back to `block`/`idle`/`walk_b`: anti-stall punishes passivity.',
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
