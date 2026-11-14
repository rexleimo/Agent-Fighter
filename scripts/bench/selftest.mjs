#!/usr/bin/env node
// ============================================================================
// Deterministic self-test for the benchmark harness — NO API key, NO network.
// Proves the harness itself is correct before any model is plugged in:
//   reproducibility, skill discrimination, budget enforcement, deadline gating,
//   calibration determinism, and report completeness. Run: node scripts/bench/selftest.mjs
// ============================================================================
import { resolveProtocol } from './protocol.mjs';
import { referenceAuthorAdapter, passiveAuthorAdapter, referenceDecideAdapter, openaiAdapter } from './adapters.mjs';
import { runHosted, runRealtime } from './runner.mjs';
import { buildReport } from './report.mjs';
import { strategyTemplate } from '../../src/strategy-dsl.js';
import { createMatch } from '../../src/engine.js';
import { runSuite } from './suite.mjs';
import { rank, entryFromBundle } from './leaderboard.mjs';
import http from 'node:http';

/** Spin up a local OpenAI-compatible /chat/completions mock so the real-model
 *  adapter path is exercised end-to-end without an API key or network. */
function mockLLM(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const content = handler(j);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS  ' + name); passed += 1; }
  catch (e) { console.log('  FAIL  ' + name + '  |  ' + (e.message || e)); failed += 1; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const small = { seeds: 3, opponents: ['random', 'brawler'] };

console.log('\nAFL benchmark harness self-test (offline, deterministic)\n');

// 1. Hosted reproducibility: identical protocol + adapter => identical scores.
await check('hosted: deterministic across two runs', async () => {
  const p = resolveProtocol({ mode: 'hosted', ...small });
  const a = await runHosted({ protocol: p, adapter: referenceAuthorAdapter() });
  const b = await runHosted({ protocol: p, adapter: referenceAuthorAdapter() });
  assert(a.strategy.versionHash === b.strategy.versionHash, 'versionHash differs');
  assert(JSON.stringify(a.reasoning) === JSON.stringify(b.reasoning), 'reasoning differs');
  assert(JSON.stringify(a.matches) === JSON.stringify(b.matches), 'match records differ');
});

// 2. Hosted discrimination: a real strategy must outscore a block-only floor.
await check('hosted: template beats passive floor (measures skill)', async () => {
  const p = resolveProtocol({ mode: 'hosted', seeds: 4, opponents: ['random', 'turtle', 'brawler'] });
  const good = await runHosted({ protocol: p, adapter: referenceAuthorAdapter() });
  const bad = await runHosted({ protocol: p, adapter: passiveAuthorAdapter() });
  assert(good.reasoning.overall.winRate > bad.reasoning.overall.winRate,
    `template ${good.reasoning.overall.winRate} should beat passive ${bad.reasoning.overall.winRate}`);
});

// 3. Calibration determinism: same matchup => same measured ordering.
await check('hosted: opponent calibration is deterministic', async () => {
  const p = resolveProtocol({ mode: 'hosted', ...small });
  const a = await runHosted({ protocol: p, adapter: referenceAuthorAdapter() });
  const b = await runHosted({ protocol: p, adapter: referenceAuthorAdapter() });
  assert(JSON.stringify(a.calibration) === JSON.stringify(b.calibration), 'calibration differs');
  assert(a.calibration.every((c) => c.calibrationGames > 0), 'calibration has no games');
});

// 4. Realtime reproducibility with a deterministic (reference) adapter.
await check('realtime: deterministic reference adapter reproduces', async () => {
  const p = resolveProtocol({ mode: 'realtime', ...small });
  const a = await runRealtime({ protocol: p, adapter: referenceDecideAdapter('brawler') });
  const b = await runRealtime({ protocol: p, adapter: referenceDecideAdapter('brawler') });
  assert(JSON.stringify(a.reasoning) === JSON.stringify(b.reasoning), 'reasoning differs');
  assert(a.latency.decisions > 0, 'no decisions recorded');
  assert(a.latency.timeouts === 0, 'reference adapter should not time out');
});

// 5. Budget enforcement: a model that calls every tick must hit the cap.
await check('realtime: model-call budget is enforced', async () => {
  const fakeModel = {
    id: 'fake:model', kind: 'model', config: {},
    async authorStrategy() { return { name: 'x', defaultAction: 'block', rules: [{ action: 'block' }] }; },
    async decide() { return { action: 'block', modelCalls: 1 }; },
  };
  const p = resolveProtocol({ mode: 'realtime', seeds: 1, opponents: ['random'], budget: 8 });
  const r = await runRealtime({ protocol: p, adapter: fakeModel });
  assert(r.latency.modelCalls >= 8, 'expected >=8 model calls, got ' + r.latency.modelCalls);
  assert(r.latency.budgetExceeded > 0, 'budget never enforced (budgetExceeded=0)');
});

// 6. Deadline gating: a decision slower than the deadline is a timeout + fallback.
await check('realtime: late decisions are gated as timeouts', async () => {
  const slowModel = {
    id: 'fake:slow', kind: 'model', config: {},
    async authorStrategy() { return { name: 'x', defaultAction: 'block', rules: [{ action: 'block' }] }; },
    async decide() { await new Promise((r) => setTimeout(r, 60)); return { action: 'block', modelCalls: 1 }; },
  };
  const p = resolveProtocol({ mode: 'realtime', seeds: 1, opponents: ['random'], deadlineMs: 20, budget: 1000 });
  const r = await runRealtime({ protocol: p, adapter: slowModel });
  assert(r.latency.timeouts > 0, 'slow decisions were not counted as timeouts');
  assert(r.latency.p50Ms >= 20, 'latency tail not captured');
});

// 7. Oracle vs constrained: relaxing the deadline removes timeouts.
await check('realtime: relaxed deadline (oracle) removes timeouts', async () => {
  const slowModel = {
    id: 'fake:slow', kind: 'model', config: {},
    async authorStrategy() { return { name: 'x', defaultAction: 'block', rules: [{ action: 'block' }] }; },
    async decide() { await new Promise((r) => setTimeout(r, 30)); return { action: 'block', modelCalls: 1 }; },
  };
  const p = resolveProtocol({ mode: 'realtime', seeds: 1, opponents: ['random'], deadlineMs: 100000, budget: 1000 });
  const r = await runRealtime({ protocol: p, adapter: slowModel });
  assert(r.latency.timeouts === 0, 'oracle run should have no timeouts');
});

// 8. Report completeness: every required section is present and well-formed.
await check('report: complete reproducible structure', async () => {
  const p = resolveProtocol({ mode: 'hosted', ...small });
  const report = buildReport(await runHosted({ protocol: p, adapter: referenceAuthorAdapter() }));
  for (const key of ['harness', 'protocol', 'adapter', 'opponents', 'calibration', 'reasoning', 'matches', 'reproducibility']) {
    assert(report[key], 'missing report section: ' + key);
  }
  assert(report.reasoning.overall.wilson.n === report.reasoning.overall.games, 'wilson n mismatch');
  assert(report.protocol.seedCount === report.protocol.seeds.length, 'seedCount mismatch');
  assert(report.harness.protocolVersion === 'afl-bench/1', 'protocol version mismatch');
});

// 9. OpenAI adapter authors a valid strategy through a real HTTP endpoint.
await check('openai adapter: authors strategy via mock endpoint (hosted)', async () => {
  const { server, port } = await mockLLM(() => '```json\n' + JSON.stringify(strategyTemplate()) + '\n```');
  try {
    const adapter = openaiAdapter({ base: `http://127.0.0.1:${port}/v1`, key: 'test', model: 'mock' });
    const p = resolveProtocol({ mode: 'hosted', seeds: 2, opponents: ['random'] });
    const r = await runHosted({ protocol: p, adapter });
    assert(r.strategy.valid && r.strategy.ruleCount > 0, 'strategy not authored');
    assert(r.adapter.id === 'openai:mock', 'adapter id wrong');
    assert(r.reasoning.overall.games === 2, 'games mismatch');
  } finally { server.close(); }
});

// 10. OpenAI adapter decides per-tick through a real HTTP endpoint.
await check('openai adapter: decides per-tick via mock endpoint (realtime)', async () => {
  const { server, port } = await mockLLM((j) => (j.max_tokens <= 8 ? 'block' : JSON.stringify(strategyTemplate())));
  try {
    const adapter = openaiAdapter({ base: `http://127.0.0.1:${port}/v1`, key: 'test', model: 'mock' });
    const p = resolveProtocol({ mode: 'realtime', seeds: 1, opponents: ['random'], budget: 5, deadlineMs: 5000 });
    const r = await runRealtime({ protocol: p, adapter });
    assert(r.latency.modelCalls >= 5, 'model calls not counted');
    assert(r.latency.budgetExceeded > 0, 'budget not enforced for model adapter');
    assert(r.latency.decisions > 0, 'no decisions');
  } finally { server.close(); }
});

// 11. OpenAI adapter retries an invalid first reply, then accepts a valid one.
await check('openai adapter: retries invalid strategy reply', async () => {
  let n = 0;
  const { server, port } = await mockLLM(() => { n += 1; return n === 1 ? 'not json at all' : JSON.stringify(strategyTemplate()); });
  try {
    const adapter = openaiAdapter({ base: `http://127.0.0.1:${port}/v1`, key: 'test', model: 'mock', maxRetries: 2 });
    const s = await adapter.authorStrategy({ fighter: 'quartz', dsl: '' });
    assert(s.rules.length > 0, 'retry did not recover');
    assert(n >= 2, 'expected a retry, calls=' + n);
  } finally { server.close(); }
});

// 12. Standard suite: runs all three evaluations and computes the latency cost.
await check('suite: bundle has hosted+realtime+oracle and latency cost', async () => {
  const tiny = { name: 'test-tiny', seeds: 2, opponents: ['random'], fighter: 'quartz', ticks: 600, budget: 8, deadlineMs: 80, oracleDeadlineMs: 100000, evals: ['hosted', 'realtime', 'oracle'] };
  const bundle = await runSuite({ adapter: referenceAuthorAdapter(), preset: tiny });
  assert(bundle.evaluations.hosted && bundle.evaluations.realtime && bundle.evaluations.oracle, 'missing evaluation');
  assert(bundle.summary.reasoningWinRate != null, 'reasoning win rate missing');
  assert(bundle.summary.latencyCost != null, 'latency cost not computed');
  assert(bundle.preset.name === 'test-tiny', 'preset not recorded');
});

// 13. Leaderboard ranks by reasoning win rate (descending).
await check('leaderboard: ranks by reasoning win rate', async () => {
  const ranked = rank([
    { adapter: 'low', reasoningWinRate: 0.2, oracleWinRate: 0.2, latencyCost: 0 },
    { adapter: 'high', reasoningWinRate: 0.8, oracleWinRate: 0.8, latencyCost: 0 },
    { adapter: 'mid', reasoningWinRate: 0.5, oracleWinRate: 0.5, latencyCost: 0 },
  ]);
  assert(ranked.map((e) => e.adapter).join(',') === 'high,mid,low', 'rank order wrong: ' + ranked.map((e) => e.adapter));
});

// 14. OpenAI adapter sends the reproducibility seed + temperature 0 on the wire.
await check('openai adapter: sends seed and temperature 0 in request', async () => {
  const bodies = [];
  const { server, port } = await mockLLM((j) => { bodies.push(j); return 'block'; });
  try {
    const adapter = openaiAdapter({ base: `http://127.0.0.1:${port}/v1`, key: 'test', model: 'mock', seed: 123 });
    const obs = createMatch({ seed: 1, fighters: { a: 'quartz', b: 'quartz' } }).observations().a;
    await adapter.decide(obs);
    assert(bodies.length === 1, 'no request captured');
    assert(bodies[0].seed === 123, 'seed not sent: ' + bodies[0].seed);
    assert(bodies[0].temperature === 0, 'temperature not 0');
  } finally { server.close(); }
});

// 15. Multi-model leaderboard path: two mock models -> suite -> rank (offline).
await check('leaderboard: multi-model run via mock endpoint ranks both', async () => {
  const { server, port } = await mockLLM((j) => (j.max_tokens <= 8 ? 'block' : JSON.stringify(strategyTemplate())));
  try {
    const tiny = { name: 'test-tiny', seeds: 2, opponents: ['random'], fighter: 'quartz', ticks: 600, budget: 8, deadlineMs: 5000, oracleDeadlineMs: 100000, evals: ['hosted', 'realtime', 'oracle'] };
    const cfg = { base: `http://127.0.0.1:${port}/v1`, key: 'test' };
    const entries = [];
    for (const model of ['mock-a', 'mock-b']) {
      const bundle = await runSuite({ adapter: openaiAdapter({ ...cfg, model }), preset: tiny });
      entries.push(entryFromBundle(bundle, 'suite:' + model));
    }
    const ranked = rank(entries);
    assert(ranked.length === 2, 'expected 2 entries');
    assert(ranked.every((e) => e.reasoningWinRate != null), 'reasoning win rate missing');
    assert(ranked.every((e) => e.preset === 'test-tiny'), 'preset not carried');
  } finally { server.close(); }
});

console.log(`\n=== ${passed}/${passed + failed} self-test checks passed ===\n`);
process.exit(failed ? 1 : 0);