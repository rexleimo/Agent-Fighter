// ============================================================================
// The opponent ladder. Every model is scored against the SAME set of official
// baselines (src/agents.js) — the identical opponents used by simulate_strategy
// and the training ground — so a benchmark score is comparable to the in-game
// offline simulation.
//
// IMPORTANT: difficulty is MEASURED, not assumed. A round-robin among the
// baselines on the exact benchmark matchup orders the ladder by actual win
// count. (Empirically the "noise" baseline can beat the "aggressive" one on a
// given mirror — assuming an ordering would mislabel the ladder.) The
// calibration is recorded in the report so the ordering is reproducible and
// auditable. Each opponent carries its versionHash to pin the exact policy.
// ============================================================================
import { BUILTIN_AGENTS, publicAgent } from '../../src/agents.js';
import { runMatch } from '../../src/engine.js';

const DEFAULT_LADDER = ['random', 'turtle', 'zoner', 'brawler'];
/** Fixed, independent seed set for calibration (kept small; recorded in report). */
export const CALIBRATION_SEEDS = Object.freeze([11, 22, 33, 44, 55, 66, 77, 88]);

export function opponentLadder(ids = null) {
  const wanted = Array.isArray(ids) && ids.length ? ids : DEFAULT_LADDER;
  const ladder = [];
  for (const id of wanted) {
    const agent = BUILTIN_AGENTS.find((a) => a.id === id);
    if (!agent) throw new Error(`unknown opponent "${id}" (available: ${BUILTIN_AGENTS.map((a) => a.id).join(', ')})`);
    ladder.push({ ...publicAgent(agent), tier: null, policy: agent.policy, defaultAction: agent.defaultAction || 'block' });
  }
  return ladder;
}

/**
 * Round-robin calibration on the benchmark matchup. Each unordered pair plays
 * CALIBRATION_SEEDS games (first id as side A); wins are summed per baseline and
 * the ladder is reordered strongest-first. Returns the reordered ladder plus a
 * calibration manifest. Deterministic: same fighters + seeds => same ordering.
 */
export function calibrateLadder(ladder, { fighters, ticks }) {
  const wins = new Map(ladder.map((o) => [o.id, 0]));
  const games = new Map(ladder.map((o) => [o.id, 0]));
  for (let i = 0; i < ladder.length; i += 1) {
    for (let j = i + 1; j < ladder.length; j += 1) {
      const a = ladder[i], b = ladder[j];
      for (const seed of CALIBRATION_SEEDS) {
        const r = runMatch({
          seed, matchId: `cal_${a.id}_${b.id}_${seed}`,
          policyA: a.policy, policyB: b.policy,
          defaultActionA: a.defaultAction, defaultActionB: b.defaultAction,
          ticks, fighters, agents: [{ id: a.id }, { id: b.id }],
        });
        games.set(a.id, games.get(a.id) + 1);
        games.set(b.id, games.get(b.id) + 1);
        if (r.result.winner === 'a') wins.set(a.id, wins.get(a.id) + 1);
        else if (r.result.winner === 'b') wins.set(b.id, wins.get(b.id) + 1);
      }
    }
  }
  const calibration = ladder.map((o) => ({
    id: o.id, name: o.name, versionHash: o.versionHash,
    calibrationWins: wins.get(o.id), calibrationGames: games.get(o.id),
    calibrationWinRate: games.get(o.id) ? Math.round((wins.get(o.id) / games.get(o.id)) * 1000) / 1000 : 0,
  })).sort((x, y) => y.calibrationWins - x.calibrationWins || x.id.localeCompare(y.id));

  const rank = new Map(calibration.map((c, idx) => [c.id, idx]));
  const ordered = [...ladder].sort((a, b) => rank.get(a.id) - rank.get(b.id));
  ordered.forEach((o) => { o.tier = rank.get(o.id); }); // tier 0 = strongest (measured)
  return { ladder: ordered, calibration, calibrationSeeds: CALIBRATION_SEEDS };
}

/** Reproducibility metadata: the exact opponents + version hashes in a report. */
export function ladderManifest(ladder) {
  return ladder.map((o) => ({ id: o.id, name: o.name, tier: o.tier, versionHash: o.versionHash }));
}