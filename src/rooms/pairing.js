/**
 * Pure opponent selection for the ranked queue (task 8).
 *
 * The old matcher took the FIRST rating-eligible candidate, which locked the
 * four registrants into two fixed pairings: the two agents that finished a
 * match re-queued together while the other group was still playing, and FIFO
 * always handed them back to each other. Scoring every candidate and charging
 * a premium for recent / last opponents breaks that lock without randomness.
 */
import { CONFIG } from '../rules.js';

/** How many of the last `window` matches pitted a against b (either side). */
export function recentCount(matches, agentId, opponentId, window = CONFIG.RECENT_WINDOW) {
  let count = 0;
  for (const m of (matches || []).slice(-window)) {
    const a = m.a && m.a.id;
    const b = m.b && m.b.id;
    if ((a === agentId && b === opponentId) || (a === opponentId && b === agentId)) count += 1;
  }
  return count;
}

/** The opponent from this agent's most recent recorded match, if any. */
export function lastOpponentId(matches, agentId) {
  for (let i = (matches || []).length - 1; i >= 0; i -= 1) {
    const m = matches[i];
    if (m.a && m.a.id === agentId && m.b) return m.b.id;
    if (m.b && m.b.id === agentId && m.a) return m.a.id;
  }
  return null;
}

/**
 * Lower cost wins. Recent repeats and the last opponent are penalised; a
 * longer wait earns a credit so a lone registrant is not starved. `now` is
 * injected (this is not kernel code, so it may read the clock).
 */
export function pickOpponent(w, candidates, now, ctx = {}) {
  const matches = ctx.matches || [];
  const config = ctx.config || CONFIG;
  const last = ctx.lastOpponentId !== undefined
    ? ctx.lastOpponentId
    : lastOpponentId(matches, w.agentId);
  let best = null;
  let bestCost = Infinity;
  for (const o of candidates) {
    if (!o || o.agentId === w.agentId) continue;
    const recent = recentCount(matches, w.agentId, o.agentId, config.RECENT_WINDOW);
    const waited = Math.max(0, now - (o.joinedAt || now));
    const cost = Math.abs(o.rating - w.rating) / 100
      + config.REPEAT_PENALTY * recent
      + (o.agentId === last ? config.LAST_OPPONENT_PENALTY : 0)
      - Math.min(waited, config.WAIT_CAP_MS) / config.WAIT_CREDIT_MS;
    if (cost < bestCost) {
      bestCost = cost;
      best = o;
    }
  }
  return best;
}
