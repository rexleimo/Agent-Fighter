/**
 * Ladder and live-feed integrity acceptance.
 *
 * The rule under test: every number on the board and on the live screen must
 * come from a real game that a real, registered player agent took part in.
 *  - the league's own baselines (built-in policies + the hosted strategy demo)
 *    never hold a board position and never enter matchmaking;
 *  - only a ranked game between two registered player agents moves wins and
 *    Glicko-2 rating; a game against an official baseline is real, replayable,
 *    and explicitly not counted;
 *  - the live channel states which kind of game it is streaming.
 *
 *   node scripts/verify-ladder.mjs
 *   AFL_TEST_DATABASE_URL=postgres://... node scripts/verify-ladder.mjs  # also runs the two-player ladder loop
 *
 * The gates live in scripts/verify-parts/ladder-*.mjs, grouped by responsibility.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attempt } from './lib/no-throw.mjs';
import { runRules } from './verify-parts/ladder-rules.mjs';
import { runLive } from './verify-parts/ladder-live.mjs';
import { runCosts } from './verify-parts/ladder-costs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DB = process.env.AFL_TEST_DATABASE_URL || '';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
  return ok;
}

async function record(name, fn) {
  const outcome = await attempt(fn);
  if (outcome.ok) check(name, true, typeof outcome.value === 'string' ? outcome.value : '');
  else check(name, false, 'ERR ' + outcome.error.message);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const replay = (matchId) => ({ format: 'afl-replay/1', matchId, seed: 1, rulesVersion: '1.0', agents: [], ticks: [] });
const result = (winner) => ({ winner, reason: 'ko', hpA: 100, hpB: 0, ticks: 120, frame: 700, startedAt: new Date().toISOString() });
const IDLE_SANDBOX = { name: 'idle-sandbox', defaultAction: 'idle', rules: [{ action: 'idle' }] };

console.log('\n=== Agent Fighting League · live + ladder integrity ===\n');

const ctx = {
  ROOT, TEST_DB, results, check, record, delay, replay, result, IDLE_SANDBOX,
  log: { text: '' },
};

await runRules(ctx);
await runLive(ctx);
await runCosts(ctx);

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' / ' : 'ALL PASS ') + results.length + ' checks');
if (ctx.log.text.includes('ladder integrity')) console.log('note: integrity migration ran on the temp data dir');
process.exitCode = failed.length ? 1 : 0;
