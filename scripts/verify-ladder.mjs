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
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { League, isLadderCompetitor, isOfficialBaseline } from '../src/league.js';
import { strategyTemplate } from '../src/strategy-dsl.js';
import { CONFIG } from '../src/rules.js';
import { MAX_MODEL_CALLS_PER_MATCH as MAX_MODEL_CALLS_FOR_TEST } from '../src/costs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DB = process.env.AFL_TEST_DATABASE_URL || '';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
  return ok;
}

async function record(name, fn) {
  try {
    const detail = await fn();
    check(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    check(name, false, 'ERR ' + err.message);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const replay = (matchId) => ({ format: 'afl-replay/1', matchId, seed: 1, rulesVersion: '1.0', agents: [], ticks: [] });
const result = (winner) => ({ winner, reason: 'ko', hpA: 100, hpB: 0, ticks: 120, frame: 700, startedAt: new Date().toISOString() });

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

const IDLE_SANDBOX = { name: 'idle-sandbox', defaultAction: 'idle', rules: [{ action: 'idle' }] };

// ------------------------------------------------------- part B: served surfaces

const PORT = await freePort();
const BASE = 'http://127.0.0.1:' + PORT;
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-ladder-live-'));
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    AFL_TICK_MS: '8',
    AFL_DATA_DIR: dirB,
    DATABASE_URL: TEST_DB,
    AFL_ADMIN_USERNAME: process.env.AFL_ADMIN_USERNAME || 'admin',
    AFL_ADMIN_PASSWORD: process.env.AFL_ADMIN_PASSWORD || 'admin-test-pass-123',
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_TRUSTED_ORIGINS: BASE + ',http://localhost:' + PORT,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function get(pathname) {
  const res = await fetch(BASE + pathname);
  return { status: res.status, data: await res.json() };
}

try {
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    try { up = (await fetch(BASE + '/api/state')).ok; } catch { /* not yet */ }
    if (!up) await delay(100);
  }
  check('L8 测试服务启动（独立数据目录，无账号库）', up, up ? BASE : serverLog.slice(-300));
  if (!up) throw new Error('server did not start');

  await delay(4000);

  await record('L9 无人报名时不伪造排位房，官方基线只在演示房打表演局', async () => {
    const rooms = (await get('/api/rooms')).data.rooms;
    const ranked = rooms.filter((r) => r.mode === 'ranked');
    assert.equal(ranked.length, 0, 'no phantom ranked room while nobody is registered: ' + JSON.stringify(ranked));
    const showcase = rooms.filter((r) => r.mode === 'demo');
    assert.ok(showcase.length >= 1, 'the always-on showcase keeps the screen alive');
    return 'rooms=' + rooms.map((r) => r.roomId + ':' + r.mode + ':' + r.pairing).join(',');
  });

  await record('L10 榜单不含任何官方基线行，且公开统计口径', async () => {
    const board = (await get('/api/leaderboard')).data;
    assert.ok(Array.isArray(board.rows));
    assert.ok(board.rows.every((r) => r.source !== 'builtin' && r.id !== 'demo_hosted'), 'no official rows');
    assert.equal(board.scope, 'registered-players');
    assert.ok(board.officials.length >= 5, 'officials disclosed separately: ' + board.officials.map((o) => o.id).join(','));
    assert.ok(board.rows.length === 0, 'a fresh league has an empty real board');
    return 'rows=' + board.rows.length + ' officials=' + board.officials.length;
  });

  await record('L11 赛程只登记真实打完的对局，官方对局一律 ranked=false', async () => {
    const matches = (await get('/api/matches')).data.matches;
    assert.ok(matches.length > 0, 'the showcase really produced matches');
    assert.ok(matches.every((m) => m.ranked === false), 'no official game is presented as a counting result');
    assert.ok(matches.every((m) => m.a.official === true || m.a.competitor === true));
    const every = matches.every((m) => Boolean(m.matchId) && Number.isFinite(m.hpA) && Number.isFinite(m.hpB) && m.ticks > 0);
    assert.ok(every, 'each record carries real engine numbers');
    return 'matches=' + matches.length + ' latest=' + matches[matches.length - 1].matchId;
  });

  await record('L12 实时通道如实标注对局性质（demo 不冒充 MATCH LIVE）', async () => {
    const state = (await get('/api/state')).data;
    const match = state.match;
    assert.ok(match, 'live feed carries a real match');
    assert.ok(['demo', 'ranked', 'scrim'].includes(match.mode), 'mode published: ' + match.mode);
    assert.ok(match.pairing, 'pairing published: ' + match.pairing);
    assert.equal(match.ranked, false, 'the showcase channel is not a ladder channel');
    assert.ok(match.a && match.b, 'both sides are the agents that actually fought');
    assert.ok(match.a.source === 'builtin' || match.a.source === 'hosted' || match.a.source === 'external');
    assert.ok(match.totalTicks > 0 && match.tickMs > 0, 'clock comes from CONFIG, not from the UI');
    return 'channel=' + match.mode + '/' + match.pairing + ' tick=' + match.tick;
  });

  await record('L13 在线人数只报真实连接，不为凑画面造假', async () => {
    const lobby = (await get('/api/state')).data.lobby;
    assert.equal(lobby.onlineAgents, 0, 'no external agent is connected in this run');
    assert.equal(lobby.waiting, 0, 'queue is empty');
    assert.ok(Array.isArray(lobby.queue) && lobby.queue.length === 0);
    return 'online=' + lobby.onlineAgents + ' waiting=' + lobby.waiting;
  });

  if (TEST_DB) {
    await partC();
  } else {
    console.log('\n  SKIP  L14-L16 两名真实玩家报名的完整排位闭环（需要 AFL_TEST_DATABASE_URL 指向独立测试库）');
  }
} finally {
  child.kill();
}

// --------------------- part C: registrants through the real matchmaking loop

async function partC() {
  const ADMIN = {
    username: process.env.AFL_ADMIN_USERNAME || 'admin',
    password: process.env.AFL_ADMIN_PASSWORD || 'admin-test-pass-123',
  };
  const PASS = 'ladder-pass-123';
  const stamp = Date.now().toString(36);
  let rpcId = 0;
  const cookieOf = (res) => (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]).filter(Boolean).map((l) => l.split(';')[0]).join('; ');

  async function req(pathname, { method = 'GET', body, cookie, key } = {}) {
    const headers = { 'Content-Type': 'application/json', Origin: BASE };
    if (cookie) headers.Cookie = cookie;
    if (key) headers.Authorization = 'Bearer ' + key;
    const res = await fetch(BASE + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { res, data, cookie: cookieOf(res) };
  }
  const login = async (c) => (await req('/api/auth/sign-in/username', { method: 'POST', body: c }));
  const tool = async (name, args, key) => {
    const { res, data } = await req('/mcp/' + encodeURIComponent(key), { method: 'POST', body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, key });
    const r = data.result;
    if (!r || r.isError) throw new Error(name + ': ' + (r?.content?.[0]?.text || res.status));
    return r.structuredContent;
  };

  /** One registrant: account -> MCP service -> agent -> hosted strategy -> queue. */
  async function enter(displayName, strategy) {
    const created = await req('/api/admin/players', {
      method: 'POST', cookie: adminCookie,
      body: { username: displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), password: PASS, displayName },
    });
    assert.equal(created.res.status, 200, 'create player ' + displayName + ': ' + JSON.stringify(created.data));
    const pl = await login({ username: created.data.player.username, password: PASS });
    assert.equal(pl.res.status, 200, 'player login ' + displayName);
    const issued = await req('/api/me/mcp', { method: 'POST', body: {}, cookie: pl.cookie });
    const playerCookie = pl.cookie;
    const key = issued.data.mcp.key;
    assert.ok(key, 'MCP service issued for ' + displayName);
    const reg = await tool('register_agent', { name: displayName }, key);
    await tool('submit_strategy', { strategy, autoRequeue: false }, key);
    await tool('join_queue', { mode: 'ranked' }, key);
    return { name: displayName, key, agentId: reg.agentId, cookie: playerCookie };
  }

  async function firstMatch(p, timeoutMs = 120000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const mine = await tool('get_my_matches', {}, p.key);
      if (mine.matches.length) return mine.matches[0];
      await delay(250);
    }
    return null;
  }

  const admin = await login(ADMIN);
  assert.equal(admin.res.status, 200, 'admin login against the test database');
  const adminCookie = admin.cookie;

  // X plays the official template, Y deliberately does nothing: the pair must
  // produce one decisive, counted ladder result between two real registrants.
  const x = await enter('Ladder X ' + stamp, strategyTemplate());
  const y = await enter('Ladder Y ' + stamp, IDLE_SANDBOX);

  const rowX = await firstMatch(x);
  const rowY = await firstMatch(y);
  check('L14 两名已注册玩家报名后真实配对打完一局', Boolean(rowX) && Boolean(rowY), rowX ? rowX.matchId + ' room=' + rowX.roomId : 'no match');
  check('L15 这一局计入胜场榜：ranked=true、pairing=rating、胜者得分、负者扣分',
    rowX && rowX.ranked === true && rowX.pairing === 'rating' && rowX.practice === false
    && rowX.result === 'win' && rowX.ratingDelta > 0
    && rowY && rowY.ranked === true && rowY.pairing === 'rating' && rowY.result === 'loss' && rowY.ratingDelta < 0,
    'X=' + (rowX ? rowX.result + '/' + rowX.ratingDelta + '/' + rowX.pairing : 'none')
    + ' Y=' + (rowY ? rowY.result + '/' + rowY.ratingDelta + '/' + rowY.pairing : 'none'));

  const boardAfter = (await get('/api/leaderboard')).data;
  const rows = boardAfter.rows.filter((r) => [x.agentId, y.agentId].includes(r.id));
  check('L16 榜单行只由这两名玩家的真实战果构成',
    rows.length === 2
    && rows.every((r) => r.matches === 1 && r.wins + r.losses + r.draws === 1)
    && boardAfter.rows[0].id === x.agentId && boardAfter.rows[0].wins === 1
    && boardAfter.rows.every((r) => r.source !== 'builtin' && r.id !== 'demo_hosted'),
    rows.map((r) => r.name + ':' + r.wins + '胜' + r.matches + '局' + r.rating).join(' / '));

  // A lone registrant has no opponent: it gets the official baseline, and that
  // game must stay off the board. This is the check that used to buy fake wins.
  const z = await enter('Ladder Z ' + stamp, strategyTemplate());
  const rowZ = await firstMatch(z);
  const boardZ = (await get('/api/leaderboard')).data;
  const rowBoardZ = boardZ.rows.find((r) => r.id === z.agentId);
  check('L17 单独报名配到官方基线：真实打完一局但不计榜（pairing=sparring）',
    rowZ && rowZ.ranked === false && rowZ.practice === true && rowZ.pairing === 'sparring'
    && rowZ.opponentOfficial === true
    && rowZ.ratingDelta === 0 && rowBoardZ && rowBoardZ.matches === 0 && rowBoardZ.wins === 0
    && rowBoardZ.rating === 1500 && rowBoardZ.practiceMatches === 1,
    rowZ ? 'opponent=' + rowZ.opponent + ' ranked=' + rowZ.ranked + ' pairing=' + rowZ.pairing + ' board=' + JSON.stringify(
      rowBoardZ && { matches: rowBoardZ.matches, wins: rowBoardZ.wins, rating: rowBoardZ.rating, practice: rowBoardZ.practiceMatches }
    ) : 'no match for lone registrant');

  // The published per-match model budget has to be real, not documentation:
  // an external agent that declares more calls than the budget must have its
  // action replaced by its own fallback, counted as budgetExceeded.
  const budgetAgent = await req('/api/admin/players', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'budget-probe-' + stamp, password: PASS, displayName: 'Budget Probe ' + stamp },
  });
  check('L18b 可创建外部 Agent 账号（不计策略，只测预算）', budgetAgent.res.status === 200, budgetAgent.res.status + '');
  const bp = await login({ username: budgetAgent.data.player.username, password: PASS });
  const bpKey = (await req('/api/me/mcp', { method: 'POST', body: {}, cookie: bp.cookie })).data.mcp.key;
  const bpReg = await tool('register_agent', { name: 'Budget Probe ' + stamp }, bpKey);
  const bpToken = bpReg.token;
  const bpStats0 = await tool('get_agent_stats', { agentId: bpReg.agentId }, bpKey);
  check('L18c 未提交策略的账号仍是"逐拍走网络"的一侧（预算才会生效）',
    bpStats0.hosted === false && bpStats0.competitor === true,
    'source=' + bpStats0.source + ' hostedStrategy=' + bpStats0.hosted);
  await tool('join_queue', { mode: 'ranked' }, bpKey);
  const wsBase = BASE.replace('http://', 'ws://');
  const ws = new WebSocket(wsBase + '/ws/agent?token=' + encodeURIComponent(bpToken));
  const seen = { observe: 0, rejected: 0, budget: 0 };
  await new Promise((resolve) => {
    const to = setTimeout(resolve, 25000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'observe') {
        seen.observe += 1;
        // Declare 5 calls per tick: the 8-call budget is crossed within two ticks.
        ws.send(JSON.stringify({ type: 'act', matchId: m.matchId, tick: m.tick, action: 'idle', modelCalls: 5 }));
      }
      if (m.type === 'act_rejected') { if (m.reason === 'model_budget_exceeded') seen.rejected += 1; else seen.other = (seen.other || 0) + 1; }
      if (m.type === 'match_end') { clearTimeout(to); resolve(); }
      if (m.type === 'room_closed') { clearTimeout(to); resolve(); }
    };
    ws.onerror = () => { clearTimeout(to); resolve(); };
  });
  try { ws.close(); } catch { /* already closed */ }
  const bpStats = (await get('/api/agents/' + bpReg.agentId)).data || null;
  const bpBoard = await tool('get_my_matches', {}, bpKey);
  check('L18d 每局模型预算在服务端强制执行：超出后动作被回落并计数（不是只写在文档里）',
    seen.observe > 0 && seen.rejected > 0 && seen.other === undefined,
    'observe=' + seen.observe + ' 超预算被回落=' + seen.rejected + ' 其它拒绝=' + (seen.other || 0) + ' budget=' + MAX_MODEL_CALLS_FOR_TEST);
  void bpStats; void bpBoard;



  // Training over HTTP must not move the ladder by even one point.
  const beforeZ = (await get('/api/leaderboard')).data.rows.find((r) => r.id === z.agentId);
  const trainRun = await req('/api/training/run', {
    method: 'POST', cookie: (await login({ username: 'ladder-z-' + stamp.toLowerCase(), password: PASS })).cookie,
    body: { drills: ['dummy', 'blockwall', 'chaos'], seeds: [41, 42] },
  });
  const afterZ = (await get('/api/leaderboard')).data.rows.find((r) => r.id === z.agentId);
  check('L19 走 HTTP 的训练场同样不动榜：战果数字逐字不变，只有 trainingRuns 增加',
    trainRun.res.status === 200 && trainRun.data.countsTowardLadder === false
      && trainRun.data.cost.modelCalls === 0 && trainRun.data.cost.llmUsed === false
      && afterZ && JSON.stringify({ m: afterZ.matches, w: afterZ.wins, l: afterZ.losses, d: afterZ.draws, r: afterZ.rating })
        === JSON.stringify({ m: beforeZ.matches, w: beforeZ.wins, l: beforeZ.losses, d: beforeZ.draws, r: beforeZ.rating })
      && afterZ.trainingRuns === (beforeZ.trainingRuns || 0) + 1,
    trainRun.res.status + ' ' + JSON.stringify(trainRun.data && { games: trainRun.data.games, cost: trainRun.data.cost?.modelCalls, board: { matches: afterZ?.matches, rating: afterZ?.rating, trainingRuns: afterZ?.trainingRuns } }));

  const anonTrain = await req('/api/training/run', { method: 'POST', body: { drills: ['dummy'] } });
  check('L19b 未登录不能借用别人的训练额度', anonTrain.res.status === 401 || anonTrain.res.status === 403 || anonTrain.res.status === 503,
    'anon POST /api/training/run -> ' + anonTrain.res.status);

  const costsRoute = (await get('/api/costs')).data;
  check('L20b 平台侧回放存储用量是实测值，并且有留存上限在执行',
    costsRoute.platformUsage && Number.isInteger(costsRoute.platformUsage.replays.files)
      && costsRoute.platformUsage.replays.retention === costsRoute.replayRetention,
    'replays=' + costsRoute.platformUsage.replays.files + ' retention=' + costsRoute.platformUsage.replays.retention);

  // Retention is a claim in the cost model, so it has to actually delete.
  {
    const { League: LeagueCls } = await import('../src/league.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-retention-'));
    const L = new LeagueCls({ dataDir: dir });
    const rd = L.replayDir;
    for (let i = 0; i < 12; i += 1) {
      const f = path.join(rd, `old_${i}.jsonl`);
      fs.writeFileSync(f, '{"tick":' + i + '}\n');
      // distinct, older mtimes so "oldest first" is measurable
      const t = new Date(Date.now() - (12 - i) * 60000);
      fs.utimesSync(f, t, t);
    }
    const pruned = L.pruneReplays({ keep: 5 });
    const left = fs.readdirSync(rd).filter((f) => f.endsWith('.jsonl')).sort();
    check('C6 回放留存上限真的会删：超出后按最旧优先删除并如实上报数量',
      pruned.removed === 7 && pruned.kept === 5
      && fs.readdirSync(rd).filter((f) => f.endsWith('.jsonl')).length === 5
      && left.every((f) => Number(f.match(/old_(\d+)/)[1]) >= 7)
      && L.replayStore().pruned === 7 && L.replayStore().files === 5,
      'removed=' + pruned.removed + ' kept=' + pruned.kept + ' 留下=' + left.join(','));
    const noop = L.pruneReplays({ keep: 50 });
    check('C7b 未超上限时一个文件都不动', noop.removed === 0 && fs.readdirSync(rd).filter((f) => f.endsWith('.jsonl')).length === 5, 'removed=' + noop.removed);

    // C8: retention must never delete the evidence behind a schedule row.
    {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-retention-ref-'));
      const L2 = new LeagueCls({ dataDir: dir2 });
      const rd2 = L2.replayDir;
      // one still-listed match whose replay file is the OLDEST on disk
      const keptId = 'referenced_old_match';
      fs.writeFileSync(path.join(rd2, keptId + '.jsonl'), '{"tick":1}\n');
      fs.utimesSync(path.join(rd2, keptId + '.jsonl'), new Date(Date.now() - 9 * 60000), new Date(Date.now() - 9 * 60000));
      for (let i = 0; i < 6; i += 1) {
        const f = path.join(rd2, `junk_${i}.jsonl`);
        fs.writeFileSync(f, '{"tick":' + i + '}\n');
        const t = new Date(Date.now() - (6 - i) * 1000); // all newer than the referenced one
        fs.utimesSync(f, t, t);
      }
      L2.matches = [{ matchId: keptId, ranked: false }];
      const res = L2.pruneReplays({ keep: 2 });
      const still = fs.readdirSync(rd2).filter((f) => f.endsWith('.jsonl'));
      check('C8 留存清理从不删除赛程仍在引用的回放（哪怕它的 mtime 最旧）',
        still.includes(keptId + '.jsonl') && res.protected === 1
        && res.removed === 4 && still.length === 3
        && L2.getReplay(keptId) !== null && !L2.getReplay('junk_0'),
        '留下=' + still.sort().join(',') + ' protected=' + res.protected + ' removed=' + res.removed);
      fs.rmSync(dir2, { recursive: true, force: true });
    }

    const noopUnused = true;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const costs = (await get('/api/costs')).data;
  check('L20 /api/costs 公开口径可查：free 面含训练，玩家账单面只含外部模型调用',
    costs.surfaces.start_training === 'free' && costs.surfaces.compare_strategies === 'free'
      && costs.surfaces.external_agent_tick === 'player_model_spend'
      && costs.matchResources.exCost === CONFIG.EX_COST && costs.matchResources.superCost === CONFIG.SUPER_COST,
    'training=' + costs.surfaces.start_training + ' external=' + costs.surfaces.external_agent_tick
      + ' meter=' + JSON.stringify({ max: costs.matchResources.maxMeter, ex: costs.matchResources.exCost, super: costs.matchResources.superCost }));

  const rooms = (await get('/api/rooms')).data.rooms;
  const officialRooms = rooms.filter((r) => r.mode === 'ranked' && (r.a?.source === 'builtin' || r.b?.source === 'builtin') && r.pairing === 'rating');
  check('L18 排位房从不出现两个官方基线互打（自打自刷榜的旧路径已封死）',
    officialRooms.length === 0,
    rooms.map((r) => r.roomId + ':' + r.mode + ':' + r.pairing + ':' + (r.a ? r.a.source : '-') + '/' + (r.b ? r.b.source : '-')).join(', '));
}

/* --------------------------------------------------------------------------
 * PART C — 计费项口径 + 训练场（零 LLM、不计榜、可诊断）
 * ------------------------------------------------------------------------ */
{
  const { COST_CLASSES, SURFACE_COST, MAX_MODEL_CALLS_PER_MATCH, matchCost, costModel } = await import('../src/costs.js');
  const { runTraining, compareStrategies, DRILLS, listDrills } = await import('../src/training.js');

  const freeId = COST_CLASSES.free.id;
  const detailed = costModel().surfacesDetailed;
  check('C1 训练/陪练/读数据/校策略/看回放全部零成本，且 payer 为 null',
    ['start_training', 'compare_strategies', 'list_drills', 'get_training_report', 'validate_strategy',
     'get_rules', 'get_leaderboard', 'get_my_matches', 'get_replay', 'get_observation_schema']
      .every((k) => SURFACE_COST[k] === freeId && detailed[k].payer === null),
    ['start_training', 'compare_strategies', 'get_rules', 'get_replay'].map((k) => k + '=' + SURFACE_COST[k]).join(' '));

  check('C2 玩家唯一真正花钱的地方是外部 Agent 的模型调用，账单由玩家供应商出（payer=player）',
    SURFACE_COST.external_agent_tick === COST_CLASSES['player_model_spend'].id
    && detailed.external_agent_tick.payer === 'player'
    && COST_CLASSES['player_model_spend'].note.includes('无法代收'),
    'external_agent_tick=' + SURFACE_COST.external_agent_tick + ' payer=' + detailed.external_agent_tick.payer);

  check('C3 每局模型预算是服务端强制执行的事实，且出现在公开口径里',
    Number.isInteger(MAX_MODEL_CALLS_PER_MATCH) && MAX_MODEL_CALLS_PER_MATCH > 0
    && costModel().maxModelCallsPerMatch === MAX_MODEL_CALLS_PER_MATCH
    && /budgetExceeded/.test(JSON.stringify(costModel())),
    'budget=' + MAX_MODEL_CALLS_PER_MATCH + '/局');

  {
    const strat = strategyTemplate();
    const train = runTraining({ strategy: strat, drills: ['dummy', 'blockwall', 'whiffbait', 'chaos'], seeds: [11, 22], rounds: 1 });
    const replayDir = path.join(ROOT, 'data', 'replays');
    const before = fs.readdirSync(replayDir).filter((f) => f.startsWith('train_')).length;
    check('T1 训练场跑的是真实内核局，且明确不进榜（countsTowardLadder=false）',
      train.kind === 'training' && train.countsTowardLadder === false && train.games > 0
      && train.rows.length === 4 && train.wins + train.losses + train.draws === train.games,
      train.games + ' 局 ' + train.wins + '胜' + train.losses + '负' + train.draws + '平 strength=' + train.strengthIndex);
    check('T2 训练成本项：0 次模型调用、llmUsed=false、计费类 free、对手引擎是自有 bot 算法',
      train.cost.modelCalls === 0 && train.cost.llmUsed === false
      && train.cost.billingClass === freeId && train.cost.opponentEngine === 'league-bot-algorithm',
      JSON.stringify(train.cost.modelCalls) + '/' + train.cost.billingClass + '/' + train.cost.opponentEngine);
    check('T3 训练靶全部是仓库内机器人算法（脚本策略或按种子伪随机），无外部模型',
      DRILLS.every((d) => typeof d.policy === 'function' && d.source !== 'model')
      && listDrills().drills.every((d) => d.llm === false && d.source === 'bot'),
      DRILLS.map((d) => d.id).join(','));
    check('T4 训练不写回放文件（磁盘成本项不增长）',
      before === 0 && fs.readdirSync(replayDir).filter((f) => f.startsWith('train_')).length === 0,
      'train_* 回放文件数=' + before);
    check('T5 确定性：同策略同靶同 seed 两次结果逐字节一致',
      JSON.stringify(runTraining({ strategy: strat, drills: ['dummy', 'blockwall'], seeds: [7, 8] }).games_detail)
      === JSON.stringify(runTraining({ strategy: strat, drills: ['dummy', 'blockwall'], seeds: [7, 8] }).games_detail),
      'games_detail 相同');
    check('T6 训练能诊断写法： unreachable 规则、兜底占比、气槽浪费都报得出来',
      (() => {
        const bad = { name: 'bad', defaultAction: 'idle', rules: [
          { when: { 'derived.distanceX': { gt: 900 } }, action: 'fireball' },
          { when: { 'self.meter': { gte: 300 } }, action: 'super' },
        ] };
        const rep = runTraining({ strategy: bad, drills: ['dummy', 'blockwall', 'pressure'], seeds: [3, 4, 5] });
        const codes = rep.findings.map((f) => f.code);
        const fb = rep.findings.find((f) => f.code === 'fallback_overused');
        return codes.includes('rules_never_fired') && codes.includes('fallback_overused')
          && codes.includes('meter_unused') && fb && fb.perOpponent && fb.perOpponent.length > 0
          && rep.rules.every((r) => r.fires > 0 || r.action);
      })(),
      (() => {
        const bad = { name: 'bad', defaultAction: 'idle', rules: [
          { when: { 'derived.distanceX': { gt: 900 } }, action: 'fireball' },
          { when: { 'self.meter': { gte: 300 } }, action: 'super' },
        ] };
        return runTraining({ strategy: bad, drills: ['dummy', 'blockwall', 'pressure'], seeds: [3, 4, 5] }).findings.map((f) => f.code).join(',');
      })());
    check('T7 被遮蔽规则单独成一条诊断（顺序匹配先到先得，且指出该往前挪谁）',
      (() => {
        const shadowed = { name: 'shadow', defaultAction: 'idle', rules: [
          { when: { 'derived.distanceX': { gt: 100 } }, action: 'walk_b' },
          { when: { 'derived.distanceX': { gt: 300 } }, action: 'fireball' },
        ] };
        const rep = runTraining({ strategy: shadowed, drills: ['dummy', 'brawler'], seeds: [5] });
        const hit = rep.findings.find((f) => f.code === 'rules_shadowed');
        return Boolean(hit) && hit.ruleIndexes.includes(1) && /rules\[0\]/.test(hit.message)
          && /往前挪/.test(hit.hint) && rep.rules.find((r) => r.ruleIndex === 1).shadowedBy[0] === 0;
      })(),
      (() => {
        const shadowed = { name: 'shadow', defaultAction: 'idle', rules: [
          { when: { 'derived.distanceX': { gt: 100 } }, action: 'walk_b' },
          { when: { 'derived.distanceX': { gt: 300 } }, action: 'fireball' },
        ] };
        const rep = runTraining({ strategy: shadowed, drills: ['dummy', 'brawler'], seeds: [5] });
        return rep.findings.map((f) => f.code).join(',') || 'none';
      })());
    check('T8 版本 A/B：同靶同 seed，flat 时明确写"不要上线"，不编造进步',
      (() => {
        const a = strategyTemplate();
        const b = { ...a, name: 'v2-noop', rules: [...a.rules] };
        const cmp = compareStrategies({ strategyA: a, strategyB: b, drills: ['dummy', 'chaos'], seeds: [1, 2, 3] });
        return cmp.kind === 'training-compare' && cmp.countsTowardLadder === false
          && cmp.strengthDelta === 0 && cmp.verdict === 'flat'
          && /不要上线|别按这个结论/.test(cmp.verdictNote) && cmp.sample.gamesPerVersion > 0;
      })(),
      (() => { const c = compareStrategies({ strategyA: strategyTemplate(), strategyB: { ...strategyTemplate(), name: 'v2-noop' }, drills: ['dummy'], seeds: [1] }); return c.verdict + ' Δ' + c.strengthDelta; })());
    check('T9 镜像局不冒充强度：镜像不计入强度指数，并给出解释',
      (() => {
        const only = runTraining({ strategy: strategyTemplate(), drills: ['mirror'], seeds: [1] });
        return only.strengthIndex === null
          && only.findings.some((f) => f.code === 'mirror_is_not_a_score');
      })(),
      'mirror-only strengthIndex=null');
    check('T10 换 seed 不换局面时如实说（确定性靶不假装稳定率）',
      (() => {
        const rep = runTraining({ strategy: strategyTemplate(), drills: ['dummy'], seeds: [1, 2, 3, 4, 5] });
        const scripted = rep.rows.find((r) => r.opponentId === 'dummy');
        return scripted.games === 5 && rep.outcomeVariety.distinct <= 2
          && /确定性/.test(rep.methodology.seedDiversity);
      })(),
      (() => { const r = runTraining({ strategy: strategyTemplate(), drills: ['dummy'], seeds: [1, 2, 3, 4, 5] }); return r.outcomeVariety.distinct + ' 种结果/' + r.games + ' 局'; })());
    check('T11 单次局数有上限（训练不能饿死实时房间）',
      (() => {
        const rep = runTraining({ strategy: strategyTemplate(), drills: ['dummy', 'blockwall', 'chaos', 'pressure'], seeds: [1, 2, 3, 4, 5, 6], rounds: 2, maxGames: 10 });
        return rep.games <= 10 && rep.truncated === true && rep.gameCap === 10;
      })(),
      'maxGames=10 → games<=10 且 truncated');
  }

  {
    // 局内真正"花钱"的资源：气槽消耗必须存在，否则"消耗型成本"是空话。
    const hostedRanked = matchCost({
      mode: 'ranked', ranked: true, practice: false, ticks: 100,
      sideA: { hosted: true, modelCalls: 0, decisions: 100, timeouts: 0 },
      sideB: { hosted: true, modelCalls: 0, decisions: 100, timeouts: 0 },
    });
    const trainingCost = matchCost({
      mode: 'training', ranked: false, practice: true, ticks: 600,
      sideA: { hosted: true, decisions: 600 }, sideB: { hosted: true, decisions: 600 },
    });
    const externalRanked = matchCost({
      mode: 'ranked', ranked: true, practice: false, ticks: 100,
      sideA: { external: true, modelCalls: 3, decisions: 100, timeouts: 0 },
      sideB: { hosted: true, decisions: 100 },
    });
    check('C4 同一局按赛道区分成本归属：托管排位=平台算力，训练=free，外部调模=玩家账单',
      hostedRanked.billingClass === COST_CLASSES['platform_run'].id && hostedRanked.hostedTicksEvaluated === 200 && hostedRanked.hostedSides === 2
      && trainingCost.billingClass === freeId && trainingCost.training === true && trainingCost.ladder === false
      && externalRanked.billingClass === COST_CLASSES['player_model_spend'].id && externalRanked.declaredModelCalls === 3,
      'hosted=' + hostedRanked.billingClass + ' training=' + trainingCost.billingClass + ' external=' + externalRanked.billingClass);

    check('C5 局内消耗型资源（EX 50 气 / 超必 100 气，上限 300）在公开口径与招式表里一致',
      CONFIG.EX_COST === 50 && CONFIG.SUPER_COST === 100 && CONFIG.MAX_METER === 300
      && JSON.stringify(costModel()).includes('EX') && /50|100/.test(JSON.stringify(costModel())),
      `EX=${CONFIG.EX_COST} SUPER=${CONFIG.SUPER_COST} MAX=${CONFIG.MAX_METER}`);
  }

}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' / ' : 'ALL PASS ') + results.length + ' checks');
if (serverLog.includes('ladder integrity')) console.log('note: integrity migration ran on the temp data dir');
process.exitCode = failed.length ? 1 : 0;
