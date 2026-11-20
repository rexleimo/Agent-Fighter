/**
 * Team elimination (KOF-style 3v3) verification gate.
 *
 * Part 1 exercises the pure state machine (src/team.js) with crafted states:
 * the 15% heal math, draw double-elimination, alive-pool-only reordering and
 * full offline match replayability. Part 2 boots a real server with 8ms ticks
 * and drives a complete team scrim through MCP + two live WebSocket pilots +
 * a spectator, then the REAL ranked loop: two signed-up players register
 * rosters and strategies -> roster lock mid-match -> matchmaking pairs them ->
 * wins-first board. There is no anonymous control plane and no /api/enter.
 *
 * Run standalone: node scripts/verify-team.mjs   (also wired as C23 in verify.js)
 *
 * The gates live in scripts/verify-parts/team-*.mjs, grouped by responsibility.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createMatch } from '../src/engine.js';
import { createTeamState, teamRoundStart, applyRoundResult, appendTeamRound } from '../src/team.js';
import { attempt } from './lib/no-throw.mjs';
import { runKernel } from './verify-parts/team-kernel.mjs';
import { makeLiveHelpers } from './verify-parts/team-live-helpers.mjs';
import { verifyLive } from './verify-parts/team-live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT;
// Better Auth pins its baseURL to http://localhost:<PORT>, so player sign-up
// has to use that exact origin even though the rest of the gate talks to 127.0.0.1.
const AUTH_BASE = 'http://localhost:' + PORT;
const TEST_DB = process.env.AFL_TEST_DATABASE_URL || '';

// Every live MCP call goes through a player-bound service, because the league
// has no anonymous control plane. Tokens map back to their owner's endpoint.
const SERVICES = new Map();
const results = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function hist(messages) {
  const out = {};
  for (const m of messages) out[m.type] = (out[m.type] || 0) + 1;
  return out;
}

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
}

async function runCheck(name, fn) {
  const outcome = await attempt(fn);
  if (outcome.ok) check(name, true, outcome.value);
  else check(name, false, outcome.error.message);
}

async function throwsWith(fn, re) {
  const outcome = await attempt(fn);
  return !outcome.ok && re.test(outcome.error.message);
}

const TEAM_A = ['quartz', 'volt', 'noct'];
const TEAM_B = ['ember', 'tide', 'basalt'];

function freshState() {
  return createTeamState({ matchId: 'verify-team', seed: 4242, teams: { a: TEAM_A, b: TEAM_B } });
}

/** Drive one full round with local policies, exactly like Room.startTeamRound. */
function playRound(ts, envelope, policies) {
  const { fighters, start } = teamRoundStart(ts);
  const seed = (ts.seed ^ Math.imul(ts.round, 2654435761)) >>> 0;
  const match = createMatch({ seed, matchId: ts.matchId, agents: [], fighters, start });
  while (!match.over && match.tick < CONFIG.MATCH_TICKS) {
    const obs = match.observations();
    match.advance(policies.a(obs.a), policies.b(obs.b));
  }
  const summary = applyRoundResult(ts, { winner: match.result.winner, reason: match.result.reason });
  appendTeamRound(envelope, {
    round: summary.round, start: { fighters, start }, orders: { a: null, b: null },
    result: { winner: match.result.winner, reason: match.result.reason },
    summary, replay: match.replay,
  });
  return summary;
}

const ctx = {
  ROOT, PORT, BASE, WS, AUTH_BASE, TEST_DB,
  SERVICES, readEp: null, results, delay, check, runCheck, throwsWith,
  TEAM_A, TEAM_B, hist, freshState, playRound,
};
ctx.live = makeLiveHelpers(ctx);

await runKernel(ctx);
await verifyLive(ctx);

const passed = results.filter((r) => r.ok).length;
console.log('\n=== ' + passed + '/' + results.length + ' team checks passed ===\n');
if (passed !== results.length) process.exitCode = 1;
