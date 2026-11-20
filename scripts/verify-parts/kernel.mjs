import { createInitialState, step, stateHash, runMatch, replayMatch, renderReplay } from '../../src/engine.js';
import { CONFIG, ACTIONS } from '../../src/rules.js';
import { BUILTIN_AGENTS } from '../../src/agents.js';
import { FIGHTERS } from '../../src/fighters.js';
import { serializeReplay, parseReplay } from '../../src/replay.js';


export function runKernelChecks(check) {
function deterministicSequence(seed, length) {
  const out = [];
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const y = (Math.imul(x ^ (x >>> 9), 2246822519) + 7) >>> 0;
    out.push({ a: ACTIONS[x % ACTIONS.length], b: ACTIONS[y % ACTIONS.length] });
  }
  return out;
}

// C1 - same seed + same action sequence must hash identically 1000 times
function verifyDeterminism() {
  const seq = deterministicSequence(20261107, 120);
  let baseline = null;
  let mismatches = 0;
  for (let run = 0; run < 1000; run += 1) {
    let s = createInitialState(4242, 'determinism');
    for (let t = 0; t < seq.length; t += 1) {
      s.tick = t;
      for (let f = 0; f < CONFIG.FRAMES_PER_TICK; f += 1) s = step(s, seq[t].a, seq[t].b);
    }
    const h = stateHash(s);
    if (baseline === null) baseline = h;
    else if (h !== baseline) mismatches += 1;
  }
  check('C1 确定性内核：同 seed + 同 action 序列跑 1000 次状态哈希全一致', mismatches === 0, 'mismatches=' + mismatches + ' hash=' + String(baseline).slice(0, 12));
}

// C2 - 60 real matches over different seeds, every replay must fully re-simulate
// both in-memory AND through the wire format (serialize -> parse), so a replay
// downloaded via MCP / REST stays reproducible.
function verifyReplays() {
  let failures = 0;
  let wireFailures = 0;
  let totalTicks = 0;
  const A = BUILTIN_AGENTS;
  for (let i = 0; i < 60; i += 1) {
    const a = A[i % A.length];
    const b = A[(i + 1 + (i % 2)) % A.length];
    const r = runMatch({
      seed: 9000 + i * 131, policyA: a.policy, policyB: b.policy, agents: [a, b], matchId: 'v_' + i,
      fighters: { a: FIGHTERS[i % FIGHTERS.length].id, b: FIGHTERS[(i + 5) % FIGHTERS.length].id },
    });
    const v = replayMatch(r.replay);
    if (!v.ok) failures += 1;
    const wire = replayMatch(parseReplay(serializeReplay(r.replay), 'v_' + i));
    if (!wire.ok) wireFailures += 1;
    totalTicks += r.replay.ticks.length;
  }
  check('C2 回放可复现：60 局不同 seed 逐拍重演一致（内存 + 序列化往返）', failures === 0 && wireFailures === 0,
    'failures=' + failures + ' wireFailures=' + wireFailures + ' totalTicks=' + totalTicks);
}

// C3 - spectator frames produced live must equal frames rebuilt from the replay
function verifySpectatorFrames() {
  const live = [];
  const r = runMatch({
    seed: 777,
    policyA: BUILTIN_AGENTS[0].policy,
    policyB: BUILTIN_AGENTS[2].policy,
    agents: [BUILTIN_AGENTS[0], BUILTIN_AGENTS[2]],
    onTick: ({ frames }) => live.push(frames),
  });
  const rebuilt = renderReplay(r.replay);
  let mismatch = 0;
  if (rebuilt.length !== live.length) mismatch += 1;
  else {
    for (let i = 0; i < live.length; i += 1) {
      if (JSON.stringify(live[i]) !== JSON.stringify(rebuilt[i].frames)) { mismatch += 1; break; }
    }
  }
  check('C3 观战快照与回放重演逐帧一致', mismatch === 0, 'ticks=' + live.length + ' mismatches=' + mismatch);
}

}
