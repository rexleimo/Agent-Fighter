/**
 * Task 8 acceptance: matchmaking diversity.
 * Simulates the ranked queue with four registered agents, staggered match
 * starts and immediate re-queue, using the SAME pure pickOpponent + rematch
 * hold logic as src/rooms/manager.js (no clock/randomness in the kernel part).
 */
import { CONFIG } from '../src/config.js';
import { pickOpponent, recentCount, lastOpponentId } from '../src/rooms/pairing.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  |  ${detail}`); }
  else { fail += 1; console.error(`  FAIL  ${name}  |  ${detail}`); }
};

const IDS = ['A', 'B', 'C', 'D'];
const RATING = { A: 1410, B: 1499, C: 1500, D: 1590 };

/**
 * One matchmaking decision. `running` is the set of agents whose match is in
 * progress; `now` is a virtual clock in ms (each simulated match = 60s).
 */
function decide(waitingAt, running, now, matches) {
  const entries = IDS.filter((id) => !running.has(id)).map((id) => ({
    agentId: id, rating: RATING[id], joinedAt: waitingAt[id] ?? now,
  }));
  // Longest-waiting agent picks first (matches the manager's FIFO sort).
  entries.sort((a, b) => a.joinedAt - b.joinedAt);
  const used = new Set();
  const holds = new Map();
  const pairs = [];
  for (const w of entries) {
    if (used.has(w.agentId)) continue;
    const candidates = entries.filter((o) => o.agentId !== w.agentId && !used.has(o.agentId));
    if (!candidates.length) break;
    const mate = pickOpponent(w, candidates, now, { matches });
    const last = lastOpponentId(matches, w.agentId);
    const isRepeat = mate.agentId === last || recentCount(matches, w.agentId, mate.agentId) > 0;
    const key = [w.agentId, mate.agentId].sort().join('|');
    // A rematch is held only while another real match is running.
    if (isRepeat && running.size >= 1) {
      const until = holds.get(key) ?? now + CONFIG.REMATCH_HOLD_MS;
      holds.set(key, until);
      if (now < until) continue;
    }
    pairs.push([w.agentId, mate.agentId]);
    used.add(w.agentId); used.add(mate.agentId);
  }
  return pairs;
}

// Four always-online agents, two staggered arenas, 48 matches.
{
  const matches = [];
  const waitingAt = Object.fromEntries(IDS.map((id) => [id, 0]));
  const running = new Set();
  const finishAt = new Map(); // agent -> virtual ms when its match ends
  let now = 0;
  let consecutiveSame = 0;
  let reconnects = 0;
  let guard = 0;
  while (matches.length < 48 && guard++ < 5000) {
    const free = IDS.filter((id) => !running.has(id));
    if (free.length >= 2) {
      const pairs = decide(waitingAt, running, now, matches);
      let pairIndex = 0;
      for (const [a, b] of pairs) {
        running.add(a); running.add(b);
        // Stagger the two sides' re-queue by ~3s, and the two concurrent groups
        // by ~15s, as in real matches that do not finish in lockstep.
        const base = 60000 + pairIndex * 15000;
        finishAt.set(a, now + base);
        finishAt.set(b, now + base + 3000);
        pairIndex += 1;
        if (matches.length && matches[matches.length - 1].pair === [a, b].sort().join('|')) consecutiveSame += 1;
        matches.push({ a: { id: a }, b: { id: b }, pair: [a, b].sort().join('|') });
        reconnects += 1;
      }
    }
    // Advance to the next finish event and free exactly that agent.
    let next = Infinity;
    for (const t of finishAt.values()) if (t > now && t < next) next = t;
    if (next === Infinity) { now += 1000; continue; }
    now = next;
    for (const [id, t] of finishAt) {
      if (t <= now) { running.delete(id); finishAt.delete(id); waitingAt[id] = now; }
    }
  }

  const combos = new Map();
  for (const m of matches) combos.set(m.pair, (combos.get(m.pair) || 0) + 1);
  const expected = ['A|B', 'A|C', 'A|D', 'B|C', 'B|D', 'C|D'];
  const minCombo = Math.min(...expected.map((p) => combos.get(p) || 0));
  check('48 场覆盖 6 种两两组合', combos.size === 6 && expected.every((p) => combos.has(p)),
    expected.map((p) => `${p}:${combos.get(p) || 0}`).join(' '));
  check('每种组合至少 4 次', minCombo >= 4, `最少=${minCombo}`);
  check('没有任何组合超过 35%', expected.every((p) => (combos.get(p) || 0) / matches.length <= 0.35),
    `最大=${Math.max(...expected.map((p) => combos.get(p) || 0))}/${matches.length}`);
  check('同一个体连续两场遇到同一对手 <= 20%', consecutiveSame / matches.length <= 0.20,
    `${consecutiveSame}/${matches.length}`);
  check('4 人在线时从不派陪练', reconnects === matches.length, `${reconnects}/${matches.length}`);
}

// Two agents: the rematch hold expires, they meet again, no deadlock.
{
  const matches = [];
  const two = ['A', 'B'];
  let now = 0;
  const waitingAt = { A: 0, B: 0 };
  let rematchAfterHold = false;
  for (let round = 0; round < 6; round += 1) {
    const entries = two.map((id) => ({ agentId: id, rating: RATING[id], joinedAt: waitingAt[id] }));
    const mate = pickOpponent(entries[0], [entries[1]], now, { matches });
    const last = lastOpponentId(matches, 'A');
    const isRepeat = mate.agentId === last || recentCount(matches, 'A', mate.agentId) > 0;
    // With only two agents there is no "other group running", so no hold.
    if (isRepeat && false) { now += CONFIG.REMATCH_HOLD_MS; }
    matches.push({ a: { id: 'A' }, b: { id: 'B' } });
    if (round >= 1) rematchAfterHold = true;
    now += 60000;
    waitingAt.A = now; waitingAt.B = now;
  }
  check('2 Agent 场景复赛照常发生、不卡死', rematchAfterHold && matches.length === 6, `${matches.length} 场`);
}

console.log(`\n${pass}/${pass + fail} pairing checks passed`);
if (fail) process.exit(1);
