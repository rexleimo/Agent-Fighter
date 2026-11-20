/** One match, decomposed into per-rule / per-move / per-situation counters. */
import { runMatch } from '../engine.js';
import { decide, matchingRules } from '../strategy-dsl.js';
import { COST_CLASSES, MAX_MODEL_CALLS_PER_MATCH } from '../costs.js';
import { ATTACK_ACTIONS, PUNISH_WINDOW_TICKS } from './drills.js';

// ---------------------------------------------------------------- 逐拍采集

/** Turn one raw match into per-rule, per-move, per-situation counters. */
export function playOne(strategy, opponent, { seed, fighterA, fighterB, matchId }) {
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
    // Training is a deterministic strategy-diagnosis sandbox, not a ranked
    // match: anti-stall (rules 2.2) would drain a passive training strategy and
    // change the very findings this report exists to produce. Pin the sandbox
    // to the pre-anti-stall rules so diagnostics stay stable and comparable.
    rulesVersion: '2.1',
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
