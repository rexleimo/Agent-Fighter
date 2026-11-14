// ============================================================================
// Match runners for the two benchmark modes.
//
// hosted   — author a strategy once (no time pressure), then score it with the
//            deterministic kernel via runMatch across every opponent x seed.
//            Pure reasoning measurement: no per-tick latency exists here.
//
// realtime — drive createMatch tick-by-tick through the async adapter, measuring
//            the REAL wall-clock latency of every decision. The league deadline
//            gates whether a decision is USED (a late action is replaced by the
//            fallback and counted as a timeout), exactly like the live server,
//            but the full latency is still recorded so the slow tail is visible.
//            Running with a relaxed deadline (--deadline-ms) gives the oracle
//            decision quality; constrained minus oracle win rate = latency cost.
//
// The kernel is deterministic, so a hosted report reproduces byte-for-byte and a
// realtime report reproduces whenever the adapter is deterministic (temperature
// 0 / reference). The runner never trusts self-reported modelCalls for scoring.
// ============================================================================
import { createMatch, runMatch } from '../../src/engine.js';
import { policyFromStrategy, strategyHash, describeDsl } from '../../src/strategy-dsl.js';
import { CONFIG } from '../../src/config.js';
import { opponentLadder, ladderManifest, calibrateLadder } from './opponents.mjs';
import { wilson, latencySummary, round, mean } from './stats.mjs';

function tally() { return { wins: 0, losses: 0, draws: 0, hp: 0, ticks: 0 }; }

function record(t, result) {
  if (result.winner === 'a') t.wins += 1;
  else if (result.winner === 'b') t.losses += 1;
  else t.draws += 1;
  t.hp += result.hpA;
  t.ticks += result.ticks;
}

function summarize(t, n) {
  const games = t.wins + t.losses + t.draws;
  return {
    games, wins: t.wins, losses: t.losses, draws: t.draws,
    winRate: round(games ? t.wins / games : 0, 4),
    wilson: wilson(t.wins, games),
    avgHpLeft: round(n ? t.hp / n : 0, 1),
    avgTicks: round(n ? t.ticks / n : 0, 1),
  };
}

/** HOSTED — reasoning-isolated strategy evaluation. */
export async function runHosted({ protocol, adapter, onProgress }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const { ladder, calibration, calibrationSeeds } = calibrateLadder(opponentLadder(protocol.opponents), { fighters: protocol.fighters, ticks: protocol.ticks });

  const authorT0 = Date.now();
  const strategy = await adapter.authorStrategy({ fighter: protocol.fighter, dsl: describeDsl() });
  const authoringMs = Date.now() - authorT0;
  const { policy } = policyFromStrategy(strategy);
  const versionHash = strategyHash(strategy);

  const perOpponent = [];
  const matches = [];
  const overall = tally();
  for (const opp of ladder) {
    const t = tally();
    for (const seed of protocol.seeds) {
      const r = runMatch({
        seed, matchId: `bench_${opp.id}_${seed}`,
        policyA: policy, policyB: opp.policy,
        defaultActionA: strategy.defaultAction, defaultActionB: opp.defaultAction,
        ticks: protocol.ticks, fighters: protocol.fighters,
        agents: [{ id: adapter.id }, { id: opp.id }],
      });
      record(t, r.result); record(overall, r.result);
      matches.push({ opponent: opp.id, seed, winner: r.result.winner, hpA: r.result.hpA, hpB: r.result.hpB, ticks: r.result.ticks });
      if (onProgress) onProgress({ mode: 'hosted', opponent: opp.id, seed, winner: r.result.winner });
    }
    perOpponent.push({ opponent: opp.id, name: opp.name, tier: opp.tier, ...summarize(t, protocol.seeds.length) });
  }

  return {
    mode: 'hosted', protocol,
    adapter: { id: adapter.id, kind: adapter.kind, config: adapter.config },
    opponents: ladderManifest(ladder),
    calibration, calibrationSeeds,
    strategy: {
      versionHash, name: strategy.name, defaultAction: strategy.defaultAction,
      ruleCount: strategy.rules.length, valid: true, authoringMs,
    },
    reasoning: { overall: summarize(overall, protocol.seeds.length * ladder.length), perOpponent },
    latency: null, // hosted has no per-tick latency by design
    matches,
    startedAt, durationMs: Date.now() - t0,
  };
}

/** REALTIME — agency under a decision deadline + model-call budget. */
export async function runRealtime({ protocol, adapter, onProgress }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const { ladder, calibration, calibrationSeeds } = calibrateLadder(opponentLadder(protocol.opponents), { fighters: protocol.fighters, ticks: protocol.ticks });

  const perOpponent = [];
  const matches = [];
  const overall = tally();
  const latencies = [];
  let modelCalls = 0, timeouts = 0, budgetExceeded = 0, decisions = 0;

  for (const opp of ladder) {
    const t = tally();
    for (const seed of protocol.seeds) {
      const m = await runRealtimeMatch({ protocol, adapter, opp, seed, latencies, counters: { addCall: (n) => { modelCalls += n; }, addTimeout: () => { timeouts += 1; }, addBudget: () => { budgetExceeded += 1; }, addDecision: () => { decisions += 1; } } });
      record(t, m.result); record(overall, m.result);
      matches.push({ opponent: opp.id, seed, winner: m.result.winner, hpA: m.result.hpA, hpB: m.result.hpB, ticks: m.result.ticks, modelCalls: m.modelCalls, timeouts: m.timeouts });
      if (onProgress) onProgress({ mode: 'realtime', opponent: opp.id, seed, winner: m.result.winner });
    }
    perOpponent.push({ opponent: opp.id, name: opp.name, tier: opp.tier, ...summarize(t, protocol.seeds.length) });
  }

  const games = matches.length;
  return {
    mode: 'realtime', protocol,
    adapter: { id: adapter.id, kind: adapter.kind, config: adapter.config },
    opponents: ladderManifest(ladder),
    calibration, calibrationSeeds,
    strategy: null,
    reasoning: { overall: summarize(overall, games), perOpponent },
    latency: {
      ...latencySummary(latencies),
      decisions, timeouts,
      timeoutRate: round(decisions ? timeouts / decisions : 0, 4),
      budgetExceeded, modelCalls,
      budgetLimit: protocol.budget, deadlineMs: protocol.deadlineMs,
    },
    efficiency: {
      modelCallsPerMatch: round(games ? modelCalls / games : 0, 2),
      timeoutsPerMatch: round(games ? timeouts / games : 0, 2),
    },
    matches,
    startedAt, durationMs: Date.now() - t0,
  };
}

/** One realtime match: drive the deterministic kernel through the async adapter.
 *  Latency is measured fully (real tail visible); the deadline gates whether the
 *  action is used; the budget caps model invocations per match. */
async function runRealtimeMatch({ protocol, adapter, opp, seed, latencies, counters }) {
  const match = createMatch({ seed, matchId: `bench_${opp.id}_${seed}`, fighters: protocol.fighters, ticks: protocol.ticks, agents: [{ id: adapter.id }, { id: opp.id }] });
  const fallback = CONFIG.DEFAULT_ACTION;
  let matchCalls = 0, matchTimeouts = 0;

  while (!match.over && match.tick < protocol.ticks) {
    const obs = match.observations(protocol.deadlineMs);
    let actionA = fallback;

    if (matchCalls >= protocol.budget) {
      counters.addBudget();
    } else {
      const start = Date.now();
      let decided = null;
      try { decided = await adapter.decide(obs.a); } catch { decided = null; }
      const latency = Date.now() - start;
      latencies.push(latency);
      counters.addDecision();
      const calls = decided && Number(decided.modelCalls) ? Number(decided.modelCalls) : (adapter.kind === 'model' ? 1 : 0);
      matchCalls += calls; counters.addCall(calls);
      if (latency > protocol.deadlineMs) {
        matchTimeouts += 1; counters.addTimeout(); // arrived too late -> fallback
      } else if (decided && decided.action) {
        actionA = decided.action;
      }
    }

    const actionB = opp.policy(obs.b);
    match.advance(actionA, actionB, { sourceA: 'bench', sourceB: opp.id });
  }

  return { result: match.result, modelCalls: matchCalls, timeouts: matchTimeouts };
}

export { mean };