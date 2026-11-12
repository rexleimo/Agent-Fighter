/**
 * 训练场 (training ground).
 *
 * What this is: a place where a player drives their own strategy against the
 * league's own bot algorithms and reads back *why* it won or lost. Nothing here
 * touches the ladder - no wins, no rating, no board row, no queue slot - and
 * nothing here calls a model. Every opponent is a deterministic policy written
 * in this repo (`DRILLS` + the official baselines), so a training run costs the
 * player exactly nothing and reproduces tick-for-tick on the same seeds.
 *
 * What the report answers, in order:
 *   1. 能不能变得更强 - win rate per drill tier, and a same-seed A/B delta
 *      between two strategy versions (`compareStrategies`).
 *   2. 该怎么写 - rule-level diagnostics: which rule fired, which rule never
 *      fires because an earlier one shadows it, which conditions are dead, how
 *      often the fallback answered, and which moves whiff.
 *
 * Metrics are computed from engine events (`hit` / `block` / `cancel`) and the
 * observation's own `frameData`, never invented. Anything derived by a stated
 * heuristic publishes that heuristic under `methodology`.
 */
import { runMatch } from './engine.js';
import { decide, matchingRules, validateStrategy, strategyHash } from './strategy-dsl.js';
import { getBuiltinAgent, BUILTIN_AGENTS } from './agents.js';
import { ACTIONS } from './rules.js';
import { CONFIG } from './config.js';
import { COST_CLASSES, MAX_MODEL_CALLS_PER_MATCH } from './costs.js';

const ATTACK_ACTIONS = new Set(ACTIONS.filter((a) => !['idle', 'walk_f', 'walk_b', 'crouch', 'jump', 'block', 'dash'].includes(a)));
/** How many ticks after a whiff still counts as "the opponent countered this mistake". */
const PUNISH_WINDOW_TICKS = 8;
const METER_MOVES = new Set(['special', 'ex', 'super']);
/**
 * A training run is synchronous and shares the event loop with the live room
 * clocks, so it is bounded: roughly a second of kernel work per call. Raise it
 * with maxGames up to the hard ceiling, or split into several runs.
 */
export const MAX_TRAINING_GAMES = Number((typeof process !== 'undefined' && process.env.AFL_MAX_TRAINING_GAMES) || 60);

// ---------------------------------------------------------------- bot 靶机库

function dummy() {
  // 木人桩：不还手、不走位，只站着挨打。用来把连段打完、把取消阶梯练熟。
  return 'idle';
}

function blockwall(o) {
  // 铁壁靶：永远防御，被压制也不反击，只有倒地起身后走一步。用来练破防、投技、压起身。
  if (o.self.hitstun > 0 || o.self.blockstun > 0) return 'block';
  if (o.self.actionable && o.self.wakeup) return 'walk_b';
  return 'block';
}

function pressure(o) {
  // 压制靶：一路压上来出招，但节奏固定、不看距离，会留下确定的空挥破绽。用来练防守与确反。
  const s = o.self;
  const d = o.derived;
  if (s.hitstun > 0 || s.blockstun > 0) return 'block';
  if (d.distanceX > 150) return 'walk_f';
  const cycle = o.tick % 4;
  if (cycle === 0) return 'lp';
  if (cycle === 1) return 'mp';
  if (cycle === 2) return 'lk';
  return 'hp';
}

function whiffbait(o) {
  // 破绽诱敌：故意在你面前空挥长收招招式。你不进场确反，就抓不到教学点。
  const d = o.derived;
  if (o.self.hitstun > 0 || o.self.blockstun > 0) return 'block';
  if (d.distanceX > 210) return 'walk_f';
  if (d.distanceX < 96) return 'walk_b';
  return o.tick % 6 === 0 ? 'hk' : 'idle';
}

function antiair(o) {
  // 对空靶：专 punish 跳入。想练 jump-in 压制，先过这一关。
  const d = o.derived;
  if (o.self.hitstun > 0 || o.self.blockstun > 0) return 'block';
  if (d.threat === 'jump_in' && d.inRange.dp) return 'dp';
  if (d.distanceX > 170) return 'walk_f';
  if (d.inRange.mp) return 'mp';
  return 'block';
}

function punisher(o) {
  // 确反靶：只在你收招硬直里打你，其余时间站桩。用来暴露"空挥习惯"。
  const d = o.derived;
  if (o.self.hitstun > 0 || o.self.blockstun > 0) return 'block';
  if (d.frameAdvantage < 0 && d.inRange.hp) return 'hp';
  if (d.opponentAttacking) return 'block';
  return 'idle';
}

function chaos(o) {
  // 混沌靶：按种子伪随机出招，练不稳定局面下的兜底规则。
  const pool = ['walk_f', 'walk_b', 'block', 'lp', 'mp', 'hp', 'lk', 'mk', 'hk', 'fireball', 'dp', 'jump', 'throw', 'crouch', 'dash', 'special', 'ex', 'super'];
  const h = (Math.imul(o.seed >>> 0, 2654435761) ^ Math.imul(o.tick + 1, 40503) ^ 0x9e3779b9) >>> 0;
  return pool[h % pool.length];
}

/**
 * The drill roster. Each entry says what it is for, so a player who does not
 * know what to practise yet can pick by goal instead of guessing.
 */
export const DRILLS = Object.freeze([
  { id: 'dummy', name: '木人桩', goal: '把连段打完：命中取消 → 下一段 → 专属技/超必收尾', skill: 'offense', policy: dummy, defaultAction: 'idle' },
  { id: 'blockwall', name: '铁壁靶', goal: '破防：投技拆防、压起身、气槽管理', skill: 'offense', policy: blockwall, defaultAction: 'block' },
  { id: 'whiffbait', name: '破绽诱敌', goal: '确反：对手空挥后的长收招帧就是你的进攻窗口', skill: 'punish', policy: whiffbait, defaultAction: 'idle' },
  { id: 'pressure', name: '压制靶', goal: '防守与格挡：固定节奏压进来，练挡与拆', skill: 'defense', policy: pressure, defaultAction: 'block' },
  { id: 'antiair', name: '对空靶', goal: '跳入风险：升龙 punish，练距离控制而不是无脑跳', skill: 'defense', policy: antiair, defaultAction: 'block' },
  { id: 'punisher', name: '确反靶', goal: '戒掉空挥：只在你收招硬直里打你', skill: 'discipline', policy: punisher, defaultAction: 'idle' },
  { id: 'chaos', name: '混沌靶', goal: '兜底规则：随机局面下你的 defaultAction 撑不撑得住', skill: 'robustness', policy: chaos, defaultAction: 'block' },
]);

export function listDrills() {
  return {
    drills: DRILLS.map((d) => ({ id: d.id, name: d.name, goal: d.goal, skill: d.skill, source: 'bot', llm: false })),
    mirror: { id: 'mirror', name: '镜像你自己', goal: '照镜子：同策略镜像由先后手决定，不计入强度指数', source: 'self', llm: false },
    baselines: BUILTIN_AGENTS.map((a) => ({ id: a.id, name: a.name, goal: a.description, skill: 'baseline', source: 'builtin', llm: false })),
    note: '训练对手全部是联赛自己的机器人算法（脚本策略 + 伪随机 bot），实时逐拍计算，不调用 LLM：练习零成本。',
    freeClass: COST_CLASSES.free.title,
    ladderImpact: 'none',
  };
}

function resolveOpponents(ids) {
  const list = (ids && ids.length ? ids : ['dummy', 'blockwall', 'chaos']).slice(0, 8);
  const out = [];
  for (const id of list) {
    const drill = DRILLS.find((d) => d.id === id);
    if (drill) { out.push({ id: drill.id, name: drill.name, goal: drill.goal, policy: drill.policy, defaultAction: drill.defaultAction, kind: 'drill' }); continue; }
    const builtin = getBuiltinAgent(id);
    if (builtin) { out.push({ id: builtin.id, name: builtin.name, policy: builtin.policy, defaultAction: builtin.defaultAction || 'block', kind: 'baseline' }); continue; }
    if (id === 'mirror') { out.push({ id: 'mirror', name: '镜像你自己', goal: '照镜子：同策略镜像由先后手决定，不计入强度指数', policy: null, defaultAction: 'block', kind: 'mirror' }); }
  }
  if (!out.length) throw new Error('no such drill: ' + list.join(', '));
  return out;
}

// ---------------------------------------------------------------- 逐拍采集

/** Turn one raw match into per-rule, per-move, per-situation counters. */
function playOne(strategy, opponent, { seed, fighterA, fighterB, matchId }) {
  const s = strategy;
  const ruleFires = new Map();
  const actionOutcomes = new Map();
  const situations = new Map();
  const trace = [];
  let fallbackTicks = 0;
  let decisionTicks = 0;
  let meterSpent = 0;
  let superUsed = 0;
  let lastMoveId = null;
  let lastMeter = null;
  let meterFinal = 0;
  const openAttacks = [];
  const threatByTick = new Map();
  const hitsOnA = [];
  let pendingIssue = null;

  const policyA = (obs) => {
    const d = decide(s, obs);
    decisionTicks += 1;
    if (d.ruleIndex === -1) fallbackTicks += 1;
    const fire = ruleFires.get(d.ruleIndex) || { fires: 0, hits: 0, whiffs: 0, punished: 0, action: d.action, note: d.note, distances: [] };
    fire.fires += 1;
    if (Number.isFinite(obs.derived.distanceX)) fire.distances.push(obs.derived.distanceX);
    ruleFires.set(d.ruleIndex, fire);
    // Shadowed rules: everything else that would have matched at this tick.
    const alsoMatches = matchingRules(s, obs).filter((i) => i !== d.ruleIndex);
    for (const i of alsoMatches) {
      const shadowed = ruleFires.get(i) || { fires: 0, hits: 0, whiffs: 0, punished: 0, action: s.rules[i].action, note: s.rules[i].note, distances: [], shadowedBy: new Set() };
      shadowed.shadowedBy = shadowed.shadowedBy || new Set();
      shadowed.shadowedBy.add(d.ruleIndex);
      ruleFires.set(i, shadowed);
    }
    const fd = obs.frameData || {};
    // A move starts when its id changes, or when the same move begins a fresh
    // startup frame back-to-back (the id alone would miss the second one).
    const startsMove = Boolean(fd.moveId)
      && (fd.moveId !== lastMoveId || (fd.phase === 'startup' && fd.frame === 0));
    if (startsMove) {
      if (lastMeter !== null && obs.self.meter < lastMeter) {
        meterSpent += lastMeter - obs.self.meter;
        if (fd.moveId === 'super') superUsed += 1;
      }
      // Credit the move to the decision that pressed the button, not to whatever
      // rule happened to be answering while the move was already in flight.
      const issued = pendingIssue && obs.tick - pendingIssue.tick <= 2 ? pendingIssue : null;
      openAttacks.push({
        tick: obs.tick, move: fd.moveId, hit: false, blocked: false, punished: false, resolved: false,
        ruleIndex: issued ? issued.ruleIndex : -2, distance: obs.derived.distanceX,
      });
      pendingIssue = null;
    }
    lastMoveId = fd.moveId || null;
    lastMeter = obs.self.meter;
    meterFinal = obs.self.meter;
    const threat = obs.derived.threat || 'none';
    threatByTick.set(obs.tick, threat);
    if (threat !== 'none') {
      const sit = situations.get(threat) || { seen: 0, gotHit: 0 };
      sit.seen += 1;
      situations.set(threat, sit);
    }
    if (ATTACK_ACTIONS.has(d.action)) pendingIssue = { tick: obs.tick, ruleIndex: d.ruleIndex, action: d.action };
    trace.push({ tick: obs.tick, ruleIndex: d.ruleIndex, action: d.action, note: d.note, distance: obs.derived.distanceX, hp: obs.self.hp, meter: obs.self.meter });
    return d.action;
  };

  /**
   * Attach a hit/block event to the attack that produced it. Moves are named in
   * the event, so match on the move first; a projectile lands long after it was
   * pressed, which is exactly when "most recent attack" would be the wrong one.
   */
  function attachEvent(t, patch, move) {
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = openAttacks.length - 1; i >= 0; i -= 1) {
        const atk = openAttacks[i];
        if (atk.resolved || atk.tick > t) continue;
        if (pass === 0 && move != null && atk.move !== move) continue;
        Object.assign(atk, patch, { resolved: true });
        return;
      }
    }
  }

  // Mirror: the same strategy drives the other side, but without this side's
  // tracing, or the counters would double every number.
  const mirrorPolicy = (obs) => decide(s, obs).action;
  const { result, replay } = runMatch({
    seed,
    matchId,
    policyA,
    policyB: opponent.kind === 'mirror' ? mirrorPolicy : opponent.policy,
    defaultActionA: s.defaultAction,
    defaultActionB: opponent.defaultAction,
    fighters: { a: fighterA, b: fighterB },
    agents: [{ id: 'training-self' }, { id: opponent.id }],
    onTick: ({ tick, events = [] }) => {
      for (const ev of events) {
        if (ev.type === 'hit' && ev.by === 'a') attachEvent(tick, { hit: true, damage: ev.damage }, ev.move);
        else if (ev.type === 'block' && ev.by === 'a') attachEvent(tick, { blocked: true }, ev.move);
        if (ev.type === 'hit' && ev.on === 'a') {
          hitsOnA.push(tick);
          const threat = threatByTick.get(tick) || threatByTick.get(tick - 1) || 'none';
          if (threat !== 'none') {
            const sit = situations.get(threat);
            if (sit) sit.gotHit += 1;
          }
        }
      }
    },
  });
  // A punish is only a punish once the mistake is known to be a whiff: decided
  // after the fact, so a trade that still landed is never counted as one.
  const wasPunished = (atk) => hitsOnA.some((t) => t >= atk.tick && t - atk.tick <= PUNISH_WINDOW_TICKS);

  // Close every attack: connected, blocked, or a whiff.
  for (const atk of openAttacks) {
    const whiffed = !atk.hit && !atk.blocked;
    const punished = whiffed && wasPunished(atk);
    const row = actionOutcomes.get(atk.move) || { attempts: 0, hits: 0, blocks: 0, whiffs: 0, punished: 0, damage: 0, distances: [] };
    row.attempts += 1;
    row.distances.push(atk.distance);
    const fire = ruleFires.get(atk.ruleIndex);
    if (atk.hit) { row.hits += 1; row.damage += atk.damage || 0; if (fire) fire.hits += 1; }
    else if (atk.blocked) { row.blocks += 1; if (fire) fire.blocks += 1; }
    else {
      row.whiffs += 1;
      if (fire) { fire.whiffs += 1; if (punished) fire.punished += 1; }
    }
    if (punished) row.punished += 1;
    actionOutcomes.set(atk.move, row);
  }
  for (const [idx, fire] of ruleFires) {
    if (fire.distances.length) {
      const sorted = fire.distances.slice().sort((x, y) => x - y);
      fire.distanceP50 = sorted[Math.floor(sorted.length / 2)];
      fire.distanceMax = sorted[sorted.length - 1];
      delete fire.distances;
    }
    if (fire.shadowedBy) fire.shadowedBy = Array.from(fire.shadowedBy);
  }

  return {
    opponent: opponent.id,
    opponentName: opponent.name,
    opponentKind: opponent.kind,
    goal: opponent.goal || null,
    seed,
    winner: result.winner,
    result: result.winner === 'a' ? 'win' : result.winner === 'b' ? 'loss' : 'draw',
    reason: result.reason,
    hpA: result.hpA,
    hpB: result.hpB,
    ticks: result.ticks,
    replayTicks: replay.ticks.length,
    decisionTicks,
    fallbackTicks,
    meterSpent,
    superUsed,
    meterFinal,
    attacks: openAttacks.length,
    ruleFires: Array.from(ruleFires.entries()).map(([idx, v]) => ({ ruleIndex: idx, ...v })),
    actionOutcomes: Array.from(actionOutcomes.entries()).map(([move, v]) => ({ move, ...v, avgDistance: Math.round(v.distances.reduce((x, y) => x + y, 0) / (v.distances.length || 1)) })).map(({ distances, ...v }) => v),
    situations: Array.from(situations.entries()).map(([threat, v]) => ({ threat, seen: v.seen, gotHit: v.survived })),
    // The training path never calls a model. This is the zero-cost claim, measured.
    cost: { llmUsed: false, declaredModelCalls: 0, serverActions: decisionTicks, modelCallBudget: MAX_MODEL_CALLS_PER_MATCH, freeClass: COST_CLASSES.free.id },
  };
}

// ---------------------------------------------------------------- 报告

/** Aggregate raw games into the per-opponent view the player reads. */
function aggregate(games) {
  const byOpponent = new Map();
  for (const g of games) {
    const row = byOpponent.get(g.opponent) || {
      opponent: g.opponent, opponentId: g.opponent, opponentKind: g.opponentKind,
      name: g.opponentName, goal: g.goal || null,
      games: 0, wins: 0, losses: 0, draws: 0, hpLeft: 0, ticks: 0,
      decisions: 0, fallbackTicks: 0, meterSpent: 0, superUsed: 0,
    };
    row.games += 1;
    if (g.result === 'win') row.wins += 1; else if (g.result === 'loss') row.losses += 1; else row.draws += 1;
    row.hpLeft += g.hpA;
    row.ticks += g.ticks;
    row.decisions += g.decisionTicks;
    row.fallbackTicks += g.fallbackTicks;
    row.meterSpent += g.meterSpent;
    row.superUsed += g.superUsed;
    byOpponent.set(g.opponent, row);
  }
  return Array.from(byOpponent.values()).map((r) => ({
    ...r,
    winRate: Math.round((r.wins / (r.games || 1)) * 100),
    avgHpLeft: Math.round(r.hpLeft / (r.games || 1)),
    avgTicks: Math.round(r.ticks / (r.games || 1)),
    fallbackShare: Math.round((r.fallbackTicks / (r.ticks || 1)) * 1000) / 10,
  }));
}

/** Merge the per-game rule/action tables into strategy-level findings. */
function mergeRules(games) {
  const map = new Map();
  for (const g of games) {
    for (const f of g.ruleFires) {
      const row = map.get(f.ruleIndex) || { ruleIndex: f.ruleIndex, action: f.action, note: f.note, fires: 0, hits: 0, whiffs: 0, punished: 0, shadowedBy: [], distanceP50: null, distanceMax: 0 };
      row.fires += f.fires;
      row.hits += f.hits || 0;
      row.whiffs += f.whiffs || 0;
      row.punished += f.punished || 0;
      if (f.distanceP50 != null) row.distanceP50 = Math.max(row.distanceP50 == null ? 0 : row.distanceP50, f.distanceP50);
      if (f.distanceMax) row.distanceMax = Math.max(row.distanceMax, f.distanceMax);
      if (f.shadowedBy && f.shadowedBy.length) row.shadowedBy = Array.from(new Set([...row.shadowedBy, ...f.shadowedBy]));
      map.set(f.ruleIndex, row);
    }
  }
  return Array.from(map.values())
    .filter((r) => r.ruleIndex >= 0)
    .map((r) => ({ ...r, hitRate: Math.round((r.hits / (r.hits + r.whiffs || 1)) * 100) }))
    .sort((a, b) => a.ruleIndex - b.ruleIndex);
}

function mergeActions(games) {
  const map = new Map();
  for (const g of games) {
    for (const a of g.actionOutcomes) {
      const row = map.get(a.move) || { move: a.move, attempts: 0, hits: 0, blocks: 0, whiffs: 0, punished: 0, avgDistance: 0 };
      row.attempts += a.attempts;
      row.hits += a.hits;
      row.blocks += a.blocks;
      row.whiffs += a.whiffs;
      row.punished += a.punished;
      row.avgDistance = Math.max(row.avgDistance, a.avgDistance);
      map.set(a.move, row);
    }
  }
  return Array.from(map.values())
    .map((r) => ({ ...r, whiffRate: Math.round((r.whiffs / (r.attempts || 1)) * 100) }))
    .sort((a, b) => b.attempts - a.attempts);
}

/**
 * The "该怎么写" half of the training ground. Each finding is produced from
 * measured counters only, and says which rule to move and why.
 */
export function trainingAdvice({ games, rules, actions, rows, strategy, seeds, capReached }) {
  const out = [];
  const push = (code, severity, message, hint, extra) => out.push({ code, severity, message, hint, ...extra });

  const totalTicks = games.reduce((n, g) => n + g.ticks, 0);
  const fallbackTicks = games.reduce((n, g) => n + g.fallbackTicks, 0);
  const fallbackShare = totalTicks ? (fallbackTicks / totalTicks) * 100 : 0;

  // Per opponent, because "your long poke always whiffs" against a stationary
  // dummy is not the same finding as the same ratio inside a real press.
  const grouped = new Map();
  for (const g of games) {
    if (!grouped.has(g.opponent)) grouped.set(g.opponent, { opponent: g.opponent, kind: g.opponentKind, games: 0, ticks: 0, fallbackTicks: 0 });
    const b = grouped.get(g.opponent);
    b.games += 1; b.ticks += g.ticks; b.fallbackTicks += g.fallbackTicks;
  }
  const rowsByOpponent = new Map(rows.map((r) => [r.opponent, r]));

  const declared = strategy.rules.length;
  // A rule can appear in the trace with fires=0 (it was evaluated but always
  // lost the race to an earlier rule) — that is shadowed, not fired.
  const fired = new Map(rules.filter((r) => r.fires > 0).map((r) => [r.ruleIndex, r]));
  const neverFired = [];
  for (let i = 0; i < declared; i += 1) {
    if (fired.has(i)) continue;
    const r = strategy.rules[i];
    const blocked = rules.find((x) => x.ruleIndex === i && x.shadowedBy && x.shadowedBy.length);
    neverFired.push({ ruleIndex: i, action: r.action, note: r.note || null, shadowedBy: (blocked && blocked.shadowedBy) || [] });
  }
  if (neverFired.length) {
    const shadowed = neverFired.filter((n) => n.shadowedBy.length);
    const unreachable = neverFired.filter((n) => !n.shadowedBy.length);
    const list = (arr) => arr.map((n) => `rules[${n.ruleIndex}](${n.note || n.action})`).join('、');
    if (unreachable.length) {
      push('rules_never_fired', 'high',
        `${unreachable.length}/${declared} 条规则在整个训练集里一次都没触发：${list(unreachable)}。`,
        '逐条看 when 里的字段：字段名拼错、阈值超出取值域、或这个局面在你的靶单里根本没出现。规则表不是装饰品，没触发的规则等于没写。',
        { ruleIndexes: unreachable.map((n) => n.ruleIndex), rules: unreachable });
    }
    if (shadowed.length) {
      push('rules_shadowed', 'medium',
        `${shadowed.length} 条规则被更靠前的同类规则遮蔽，永远轮不到：` + shadowed.map((n) => `rules[${n.ruleIndex}] 被 ${n.shadowedBy.map((i) => 'rules[' + i + ']').join('、')} 挡住`).join('；') + '。',
        'rules 是先到先得的顺序匹配：把更具体的那条往前挪，或给被挡的那条加一个更窄的 when。',
        { ruleIndexes: shadowed.map((n) => n.ruleIndex), rules: shadowed });
    }
  }

  if (fallbackShare > 40) {
    const perOpponent = [...grouped.values()].filter((b) => b.ticks > 0 && b.fallbackTicks / b.ticks > 0.4)
      .map((b) => `${b.opponent} ${Math.round((b.fallbackTicks / b.ticks) * 100)}%`);
    push('fallback_overused', 'high',
      `${Math.round(fallbackShare)}% 的拍数没有命中任何规则，走了 defaultAction${perOpponent.length ? '（' + perOpponent.join('、') + '）' : ''}。`,
      '规则太窄或太散：给最常见的中距/近距局面补一条兜底规则，而不是继续加特例。',
      { fallbackShare: Math.round(fallbackShare), perOpponent });
  }

  const worstWhiff = actions.filter((a) => ATTACK_ACTIONS.has(a.move) && a.attempts >= 5).sort((a, b) => b.whiffRate - a.whiffRate)[0];
  if (worstWhiff && worstWhiff.whiffRate >= 40) {
    push('whiff_heavy', 'medium',
      `${worstWhiff.move} 出手 ${worstWhiff.attempts} 次，${worstWhiff.whiffRate}% 空挥，平均出招距离 ${worstWhiff.avgDistance}，被确反 ${worstWhiff.punished} 次。`,
      `把这条规则的 ${worstWhiff.move} 距离门槛收到实测命中距离以内（用观察里的 derived.inRange.${worstWhiff.move}，而不是自己估的 distanceX）。`,
      { move: worstWhiff.move });
  }

  const neverSuper = games.length >= 3 && games.every((g) => g.superUsed === 0);
  if (neverSuper) {
    const finalMeter = Math.round(games.reduce((n, g) => n + g.meterFinal, 0) / games.length);
    push('meter_unused', 'low',
      `${games.length} 局训练一次超必杀都没打出去，终局气槽平均 ${finalMeter} / ${CONFIG.MAX_METER}。`,
      `满气不收尾等于白攒：补一条 canSuper + 距离条件的高伤规则。超必杀耗 ${CONFIG.SUPER_COST} 气、EX 耗 ${CONFIG.EX_COST} 气，这是局内唯一真正“花钱”的资源。`,
      { finalMeter });
  }

  const variety = outcomeVariety(games);
  if (games.length >= 4 && !variety.diversified) {
    push('seeds_not_diversifying', 'info',
      `${games.length} 局训练只得到 ${variety.distinct} 种结果：这些靶是确定性脚本，换 seed 不会换局面。`,
      '要评估稳定性就把 chaos / random 混进靶单，它们的出招按种子变化；否则你测的是同一个局面。');
  }

  const vsDummy = rowsByOpponent.get('dummy');
  if (vsDummy && vsDummy.winRate < 100) {
    push('combo_incomplete', 'high',
      `连打不还手的木人桩胜率只有 ${vsDummy.winRate}%（${vsDummy.wins}/${vsDummy.games}）。`,
      '先别管战术：问题在连段本身。用 frameData.hitLanded + cancelInto 做命中取消，把 lp→mp→hp→special 接满。',
      { opponent: 'dummy' });
  }

  for (const r of rows) {
    if (r.opponentId === 'mirror') {
      push('mirror_is_not_a_score', 'info',
        `镜像局 ${r.wins}胜${r.losses}负${r.draws}平：同一份策略互相打，结果是确定的，胜负由先后手决定，不由强弱决定。`,
        '看镜像要看双方指标是否对称（谁先掉血、谁空挥多、谁更依赖兜底），不要看这个胜率；它也不计入强度指数。',
        { opponent: 'mirror' });
    }
    if (r.opponentKind === 'drill' && r.winRate === 0 && r.losses >= r.games) {
      push('cannot_press_drill', 'medium',
        `${r.name || r.opponent}（${r.goal || '靶'}）你 ${r.games} 局全输，一分没拿。`,
        '这个靶专门惩罚一类习惯（龟缩、乱跳、无脑挥长手）：先看这局的 actionBreakdown 和 frameEvents，确认自己是在什么距离、什么帧窗口送的。',
        { opponent: r.opponent });
    }
  }

  if (capReached) {
    push('cap_reached', 'info', `靶单/seed/rounds 组合被单次局数上限截断（${capReached} 局封顶）。`, '想跑满就分批换 seed，或把 maxGames 调高（上限 200）。');
  }
  if (games.length && games.length < 10) {
    push('small_sample', 'info', `样本只有 ${games.length} 局（seed ${seeds.length} 个）。`, '加 seed 是免费的，不要拿 3 局的胜负当结论。');
  }

  if (!out.length) {
    push('clean', 'info', '没有发现结构性问题：规则都会触发、兜底占比正常、空挥可控。', '下一步换更强的靶（压制靶 / 官方基线）或跑版本 A/B 看能不能再涨。');
  }
  return out;
}

/** How many distinct (opponent, result, ticks) triples a run produced. */
function outcomeVariety(games) {
  const keys = new Set(games.map((g) => `${g.opponent}:${g.result}:${g.ticks}`));
  return { distinct: keys.size, games: games.length, diversified: keys.size > 1 };
}

/** 结论口径：训练指标不是榜单评分，只是同靶同 seed 下的强弱变化。 */
function strengthIndex(rows) {
  const weights = { dummy: 1, blockwall: 1.2, whiffbait: 1.4, punisher: 1.6, pressure: 1.8, antiair: 2.0, chaos: 1.5, brawler: 2.4, zoner: 2.4, turtle: 2.2, random: 1.8 };
  let num = 0; let den = 0;
  for (const r of rows) {
    // An identical mirror is decided by first-move advantage, not strength.
    if (r.opponentId === 'mirror') continue;
    const w = weights[r.opponent] || weights[r.opponentId] || 1;
    num += (r.wins + r.draws * 0.5) / (r.games || 1) * w * (r.games || 1);
    den += w * (r.games || 1);
  }
  return den ? Math.round((num / den) * 100) / 100 : null;
}

/**
 * Run the training ground.
 *
 * @param {object} input.strategy   the player's hosted DSL strategy (validated)
 * @param {string[]} [input.drills] drill / baseline ids, `mirror` to fight yourself
 * @param {number[]} [input.seeds]  seed set; default 5 seeds per opponent
 * @param {number} [input.rounds]   rounds per opponent per seed (default 1)
 * @param {string} [input.fighterA] fighter for the player's side (default their own)
 */
export function runTraining(input = {}) {
  const strategy = validateStrategy(input.strategy);
  const opponents = resolveOpponents(input.drills);
  const seeds = (Array.isArray(input.seeds) && input.seeds.length ? input.seeds : [101, 202, 303, 404, 505]).slice(0, 20).map((n) => Number(n) || 1);
  const rounds = Math.max(1, Math.min(Number(input.rounds) || 1, 5));
  const cap = Math.max(1, Math.min(Number(input.maxGames) || MAX_TRAINING_GAMES, MAX_TRAINING_GAMES));
  let truncated = false;
  const fighterA = input.fighterA || strategy.fighterId || 'quartz';
  const games = [];
  outer: for (const opponent of opponents) {
    for (const seed of seeds) {
      for (let r = 0; r < rounds; r += 1) {
        if (games.length >= cap) { truncated = true; break outer; }
        games.push(playOne(strategy, opponent, { seed, fighterA, fighterB: input.fighterB || 'quartz', matchId: `train_${opponent.id}_${seed}_${r}` }));
      }
    }
  }
  const rows = aggregate(games);
  const rules = mergeRules(games);
  const actions = mergeActions(games);
  const report = {
    kind: 'training',
    countsTowardLadder: false,
    versionHash: strategyHash(input.strategy).slice(0, 12),
    strategyName: strategy.name,
    fighterId: fighterA,
    drills: opponents.map((o) => o.id),
    seeds,
    games: games.length,
    gameCap: cap,
    truncated,
    outcomeVariety: outcomeVariety(games),
    strengthIndexNote: '镜像局不计入强度指数：同一份策略互相打结果由先后手决定，不反映强弱',
    wins: rows.reduce((n, r) => n + r.wins, 0),
    losses: rows.reduce((n, r) => n + r.losses, 0),
    draws: rows.reduce((n, r) => n + r.draws, 0),
    strengthIndex: strengthIndex(rows),
    rows,
    rules,
    actions,
    cost: {
      billingClass: COST_CLASSES.free.id,
      llmUsed: false,
      modelCalls: 0,
      opponentEngine: 'league-bot-algorithm',
      note: '练习对手由联赛自己的机器人算法逐拍实时计算，不走 LLM：零成本。',
    },
    methodology: {
      punishWindowTicks: PUNISH_WINDOW_TICKS,
      seedDiversity: '对确定性靶（脚本策略）换 seed 不会换结果：只有 chaos / random 这类按种子出招的靶才会产生分布。想看方差就混进混沌靶。',
      whiff: '一次出手在该拍之后的事件流里没有 hit/block 记录即计为空挥',
      shadowedRule: '同一拍上有两条以上规则成立时，decide 只取最前的一条，其余记为被遮蔽',
      strengthIndex: '按靶位难度加权的结果率（0-1），只是训练指标，不是榜单评分',
      determinism: '同 strategy + 同 drills + 同 seeds 的结果逐拍一致（确定性内核）',
    },
    games_detail: games.map((g) => ({ opponent: g.opponent, seed: g.seed, result: g.result, reason: g.reason, hpA: g.hpA, hpB: g.hpB, ticks: g.ticks, decisions: g.decisionTicks, fallbackTicks: g.fallbackTicks, meterSpent: g.meterSpent, superUsed: g.superUsed })),
  };
  report.findings = trainingAdvice({ games, rules, actions, rows, strategy, seeds, capReached: truncated ? cap : 0 });
  return report;
}

/**
 * Same drills, same seeds, two strategy versions. This is the only honest way
 * to answer "did my change make it stronger" - everything else in the report is
 * descriptive, this is comparative, and the seed set is held fixed on purpose.
 */
export function compareStrategies({ strategyA, strategyB, drills, seeds, rounds, fighterA } = {}) {
  const a = runTraining({ strategy: strategyA, drills, seeds, rounds, fighterA });
  const b = runTraining({ strategy: strategyB, drills, seeds, rounds, fighterA });
  const perOpponent = a.rows.map((rowA) => {
    const rowB = b.rows.find((r) => r.opponent === rowA.opponent);
    return {
      opponent: rowA.opponent,
      name: rowA.name,
      aWinRate: rowA.winRate,
      bWinRate: rowB ? rowB.winRate : 0,
      delta: (rowB ? rowB.winRate : 0) - rowA.winRate,
      aAvgHpLeft: rowA.avgHpLeft,
      bAvgHpLeft: rowB ? rowB.avgHpLeft : 0,
      games: rowA.games,
    };
  });
  // Only mirror rows can differ without a strategy change (an identical mirror
  // is deterministic); report which seeds actually changed so nobody reads noise
  // as signal.
  const changedSeeds = [];
  for (const ga of a.games_detail) {
    const gb = b.games_detail.find((x) => x.opponent === ga.opponent && x.seed === ga.seed);
    if (gb && ga.result !== gb.result) changedSeeds.push(`${ga.opponent}#${ga.seed}: ${ga.result}→${gb.result}`);
  }
  const mirrorOnly = a.rows.every((r) => r.opponentId === 'mirror');
  const aIndex = mirrorOnly ? null : a.strengthIndex;
  const bIndex = mirrorOnly ? null : b.strengthIndex;
  const deltaStrength = (aIndex === null || bIndex === null) ? null : Math.round((bIndex - aIndex) * 100) / 100;
  const verdict = deltaStrength === null ? 'inconclusive' : deltaStrength > 0.02 ? 'stronger' : deltaStrength < -0.02 ? 'weaker' : 'flat';
  return {
    kind: 'training-compare',
    countsTowardLadder: false,
    seeds: a.seeds,
    drills: a.drills,
    games: a.games + b.games,
    versionA: { hash: a.versionHash, wins: a.wins, strengthIndex: aIndex, findings: a.findings.map((f) => f.code) },
    versionB: { hash: b.versionHash, wins: b.wins, strengthIndex: bIndex, findings: b.findings.map((f) => f.code) },
    perOpponent,
    strengthDelta: deltaStrength,
    verdict,
    sample: { gamesPerVersion: a.games, opponents: a.drills.length, seeds: a.seeds.length },
    // New seeds that produce a different result is the honest overfitting metric:
    // a change that only wins on the seeds you tuned against is not an improvement.
    changedSeeds,
    findingSeeds: a.findings.map((f) => f.code).filter((code) => !b.findings.some((x) => x.code === code)),
    introducedSeeds: b.findings.map((f) => f.code).filter((code) => !a.findings.some((x) => x.code === code)),
    verdictNote: verdict === 'inconclusive'
      ? '本次只打了镜像靶：镜像不提供强弱结论。换真实靶（至少 dummy + 一个会还手的）再比。'
      : verdict === 'stronger'
      ? '新版本在同一批靶、同一批 seed 下结果率更高：这是一次可复现的进步，不是运气。'
      : verdict === 'weaker'
        ? '新版本在同批靶与同批 seed 下变差了：回滚或只保留其中涨的那部分规则。'
        : '两个版本没有可分辨的差距（阈值 0.02）：加大 seed 数再判，别按这个结论改代码。',
    caveat: `样本 ${a.games} 局/版本 × ${a.drills.length} 个靶 × ${a.seeds.length} 个 seed；seed 集固定，所以差值只反映策略改动本身。训练指标不进榜、不等于对手池的真实强度；判定 flat 就不要上线。`,
    cost: a.cost,
  };
}
