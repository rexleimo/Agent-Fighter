import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { attempt, withFinally, parseOr } from '../lib/no-throw.mjs';
import { League, isLadderCompetitor, isOfficialBaseline } from '../../src/league.js';
import { strategyTemplate } from '../../src/strategy-dsl.js';
import { CONFIG } from '../../src/rules.js';
import { MAX_MODEL_CALLS_PER_MATCH as MAX_MODEL_CALLS_FOR_TEST } from '../../src/costs.js';


export async function runRules(ctx) {
  const { check, record, ROOT, replay, result } = ctx;
// ---------------------------------------------------------------- part A: rules

console.log('\n=== Agent Fighting League · live + ladder integrity ===\n');

const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-ladder-rules-'));
const league = new League({ dataDir: dirA });
league.ensureHostedDemo(strategyTemplate());
const A = league.registerAgent({ name: 'Ladder A', kind: 'rule', playerId: 'ply_a' }).agentId;
const B = league.registerAgent({ name: 'Ladder B', kind: 'llm', playerId: 'ply_b' }).agentId;
const agent = (id) => league.agents.get(id);
const none = { a: { modelCalls: 0, timeouts: 0 }, b: { modelCalls: 0, timeouts: 0 } };

await record('L1 官方基线不是竞争者，已注册玩家 Agent 才是', () => {
  assert.ok(isOfficialBaseline(agent('brawler')), 'builtin is official');
  assert.ok(isOfficialBaseline(agent('demo_hosted')), 'hosted baseline is official');
  assert.ok(!isLadderCompetitor(agent('demo_hosted')), 'hosted baseline cannot compete');
  assert.ok(isLadderCompetitor(agent(A)), 'registered player agent competes');
  return 'officials=' + league.getLeaderboard().officials.length;
});

await record('L2 官方基线演示局：记录真实战果，不动任何榜单数字', () => {
  league.recordMatch({ matchId: 'x_showcase', agentA: agent('demo_hosted'), agentB: agent('brawler'), result: result('a'), replay: replay('x_showcase'), decisions: null, roomId: 'r_demo', mode: 'demo', ranked: false, pairing: 'showcase' });
  const board = league.getLeaderboard();
  assert.equal(board.rows.length, 2, 'only the two registered agents are on the board');
  assert.equal(board.rows.find((r) => r.id === 'demo_hosted'), undefined, 'no hosted baseline row');
  assert.equal(board.rows.find((r) => r.id === 'brawler'), undefined, 'no builtin row');
  const hosted = board.officials.find((o) => o.id === 'demo_hosted');
  assert.equal(hosted.exhibitionMatches, 1, 'exhibition games are counted as exhibition');
  assert.equal(hosted.rating, 1500, 'official baseline keeps its fixed nominal rating');
  return 'rows=' + board.rows.map((r) => r.name).join(',');
});

await record('L3 排位房遇到官方基线：真实一局，但不计胜场不计分', () => {
  const before = { ...agent(A) };
  league.recordMatch({ matchId: 'x_practice', agentA: agent(A), agentB: agent('zoner'), result: result('a'), replay: replay('x_practice'), decisions: none, roomId: 'r_rank', mode: 'ranked', ranked: true, pairing: 'sparring' });
  const rec = league.matches.find((m) => m.matchId === 'x_practice');
  assert.equal(rec.ranked, false, 'not a counting ladder result');
  assert.equal(rec.practice, true, 'flagged as practice');
  assert.equal(rec.ratingDeltaA, 0, 'no rating change');
  assert.equal(rec.a.competitor, true);
  assert.equal(rec.b.official, true);
  const now = agent(A);
  assert.equal(now.wins, before.wins, 'no ladder win');
  assert.equal(now.matches, before.matches, 'no ladder match');
  assert.equal(now.rating, before.rating, 'rating untouched');
  assert.equal(now.practiceMatches, 1, 'practice games are disclosed separately');
  return 'practice=' + now.practiceMatches + ' wins=' + now.wins;
});

await record('L4 两名已注册玩家 Agent 的排位局：计分一次且只计这一次', () => {
  league.recordMatch({ matchId: 'x_ladder', agentA: agent(A), agentB: agent(B), result: result('a'), replay: replay('x_ladder'), decisions: none, roomId: 'r_rank', mode: 'ranked', ranked: true, pairing: 'rating' });
  const board = league.getLeaderboard();
  const rowA = board.rows.find((r) => r.id === A);
  const rowB = board.rows.find((r) => r.id === B);
  assert.equal(rowA.wins, 1, 'one real ladder win');
  assert.equal(rowA.matches, 1);
  assert.ok(rowA.rating > 1500, 'rating moved: ' + rowA.rating);
  assert.ok(rowB.rating < 1500, 'loser rated down: ' + rowB.rating);
  assert.equal(board.rows[0].id, A, 'wins-first ordering puts the real winner on top');
  assert.equal(rowA.practiceMatches, 1, 'practice games stay visible next to the ladder record');
  return 'A rating=' + rowA.rating + ' wins=' + rowA.wins;
});

await record('L5 赛道筛选只在真实玩家行内筛选，开放赛道不再混入纯规则行', () => {
  const open = league.getLeaderboard({ track: 'open' }).rows;
  const rule = league.getLeaderboard({ track: 'rule_only' }).rows;
  assert.deepEqual(open.map((r) => r.id), [B], 'open track lists only open-track agents');
  assert.deepEqual(rule.map((r) => r.id), [A], 'rule_only track lists only rule agents');
  assert.equal(league.getLeaderboard({ track: 'all' }).rows.length, 2);
  return 'open=' + open.length + ' rule=' + rule.length;
});

await record('L6 战果回读带来源标记，账号页能区分排位与陪练', () => {
  const mine = league.getMyMatches({ token: agent(A).token }).matches;
  const ladderRow = mine.find((m) => m.matchId === 'x_ladder');
  const practiceRow = mine.find((m) => m.matchId === 'x_practice');
  assert.equal(ladderRow.ranked, true);
  assert.equal(ladderRow.practice, false);
  assert.equal(practiceRow.ranked, false);
  assert.equal(practiceRow.practice, true);
  assert.equal(practiceRow.opponentOfficial, true, 'opponent disclosed as official baseline');
  return 'rows=' + mine.map((m) => m.matchId + ':' + (m.ranked ? 'ladder' : 'practice')).join(',');
});

/**
 * A contaminated league file is the one thing the migration must never get wrong
 * on. Prefer the real archived state if the repo has one; otherwise synthesise
 * the same shape (officials holding thousands of showcase results) so the check
 * is self-contained.
 */
function contaminatedFixture(dir) {
  const archive = path.join(ROOT, 'data/league.pre-integrity.json');
  const live = path.join(ROOT, 'data/league.json');
  const source = fs.existsSync(archive) ? archive : live;
  if (fs.existsSync(source)) {
    const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
    const polluted = raw.agents.filter((a) => isOfficialBaseline(a) && (a.matches || 0) > 0);
    if (polluted.length > 0) {
      fs.cpSync(source, path.join(dir, 'league.json'));
      return { raw, polluted, synthesised: false };
    }
  }
  const seed = new League({ dataDir: path.join(dir, 'seed') });
  seed.ensureHostedDemo(strategyTemplate());
  const player = seed.registerAgent({ name: 'Fixture Player', kind: 'rule', playerId: 'ply_fixture' }).agentId;
  for (let i = 0; i < 40; i += 1) {
    const opponent = i % 2 ? 'zoner' : 'demo_hosted';
    seed.recordMatch({ matchId: 'fx_' + i, agentA: seed.agents.get(opponent), agentB: seed.agents.get(player), result: result('a'), replay: replay('fx_' + i), decisions: none, roomId: 'r_fx', mode: 'ranked', ranked: true, pairing: 'rating' });
  }
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'seed/league.json'), 'utf8'));
  // Replay the pre-fix bookkeeping by hand: under the old rules an official
  // baseline absorbed those 40 games as ladder results, which is exactly the
  // state the migration has to recognise and undo.
  for (const a of raw.agents) {
    if (!isOfficialBaseline(a)) continue;
    a.matches = 20;
    a.wins = 7;
    a.losses = 13;
    a.rating = 1442;
    a.ratingHistory = [{ matchId: 'fx_0', ts: Date.now(), ratingBefore: 1500, ratingAfter: 1442 }];
  }
  fs.writeFileSync(path.join(dir, 'league.json'), JSON.stringify(raw));
  return { raw, polluted: raw.agents.filter((a) => isOfficialBaseline(a) && (a.matches || 0) > 0), synthesised: true };
}

await record('L7 历史脏数据自动迁移：归档 + 清零 + 新Season，且幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-ladder-migrate-'));
  const fixture = contaminatedFixture(dir);
  fs.mkdirSync(path.join(dir, 'replays'), { recursive: true });
  const migrated = new League({ dataDir: dir });
  const board = migrated.getLeaderboard();
  assert.ok(fixture.polluted.length > 0, 'fixture really carries showcase rows with matches');
  assert.ok(board.rows.every((r) => isLadderCompetitor(migrated.agents.get(r.id))), 'every board row is a registered player');
  assert.ok(board.rows.every((r) => r.matches === 0 && r.wins === 0 && r.rating === 1500), 'ladder restarts from real results only');
  assert.equal(migrated.matches.length, 0, 'contaminated schedule cleared');
  assert.ok(fs.existsSync(path.join(dir, 'league.pre-integrity.json')), 'old file archived');
  assert.equal(migrated.enforceLadderIntegrity(), false, 'second run changes nothing');
  return (fixture.synthesised ? 'synthesised fixture: ' : 'archived real file: ') + 'officials held up to ' + Math.max(...fixture.polluted.map((a) => a.matches)) + ' counted games; season -> ' + migrated.season;
});

  Object.assign(ctx, { league, A, B, agent, none });
}
