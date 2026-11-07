import { createInitialState, step } from './engine.js';
import { buildObservation } from './protocol.js';
import { parseReplay } from './replay.js';
import { CONFIG } from './rules.js';

// Offline replay simulator: feed a downloaded JSONL replay through your own policy
// and see tick by tick where your decisions diverge from the recorded ones.
export function simulateReplay(text, policy, { side = 'a', matchId = 'local' } = {}) {
  const replay = parseReplay(text, matchId);
  let state = createInitialState(replay.seed, matchId);
  const history = [];
  const diffs = [];
  for (const rec of replay.ticks) {
    const obs = buildObservation(state, side, rec.tick, CONFIG.TICK_MS, history, replay.seed);
    let predicted = null;
    try {
      const out = policy(obs);
      predicted = typeof out === 'string' ? out : (out && out.action) || null;
    } catch { /* policy failed: counted as disagreement */ }
    const actual = side === 'a' ? rec.actionA : rec.actionB;
    if (predicted !== actual) diffs.push({ tick: rec.tick, predicted, actual, threat: obs.derived.threat, distanceX: obs.derived.distanceX });
    history.push({ tick: rec.tick, action: actual });
    state.tick = rec.tick;
    for (let i = 0; i < CONFIG.FRAMES_PER_TICK && !state.over; i += 1) {
      state = step(state, rec.actionA, rec.actionB);
    }
  }
  return {
    ticks: replay.ticks.length,
    disagreements: diffs.length,
    agreement: replay.ticks.length ? Math.round(((replay.ticks.length - diffs.length) / replay.ticks.length) * 1000) / 10 : 0,
    sample: diffs.slice(0, 10),
  };
}
