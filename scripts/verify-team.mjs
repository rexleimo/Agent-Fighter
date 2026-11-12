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
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createMatch } from '../src/engine.js';
import { BUILTIN_AGENTS } from '../src/agents.js';
import { templatePolicy } from '../sdk/agent-client.mjs';
import { authEnv, mcpTool, mcpInitialize, onboardPlayer } from './lib/harness-auth.mjs';
import {
  TEAM_SIZE, TEAM_HEAL, TEAM_MAX_ROUNDS,
  normalizeTeam, createTeamState, teamRoundStart, applyRoundResult,
  isValidOrder, applyOrder, teamView, teamResult,
  createTeamReplay, appendTeamRound, replayTeamMatch, renderTeamReplay,
  flattenTeamReplay, parseTeamReplay,
} from '../src/team.js';

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
let READ_EP = null;
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
  try {
    const detail = await fn();
    check(name, true, detail);
  } catch (err) {
    check(name, false, err.message);
  }
}

function throwsWith(fn, re) {
  try { fn(); } catch (err) { return re.test(err.message); }
  return false;
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

// ---------------------------------------------------------------- part 1

console.log('\n=== Agent Fighting League · team elimination verification ===\n');

await runCheck('T1 组队注册校验：恰好 3 名、合法且不重复', () => {
  assert.deepEqual(normalizeTeam(TEAM_A), TEAM_A);
  assert.ok(throwsWith(() => normalizeTeam(['quartz', 'volt']), /exactly 3/));
  assert.ok(throwsWith(() => normalizeTeam([...TEAM_A, 'ember']), /exactly 3/));
  assert.ok(throwsWith(() => normalizeTeam(['quartz', 'quartz', 'volt']), /duplicate/));
  assert.ok(throwsWith(() => normalizeTeam(['quartz', 'volt', 'snk-bogus']), /unknown fighter/));
  return 'size=' + TEAM_SIZE;
});

await runCheck('T2 初始状态与内核开局注入（残血/气槽直接进场）', () => {
  const ts = freshState();
  assert.equal(ts.round, 1);
  assert.equal(ts.sides.a.order.length, 3);
  const rs = teamRoundStart(ts);
  assert.deepEqual(rs.fighters, { a: 'quartz', b: 'ember' });
  assert.equal(rs.start.a.hp, CONFIG.MAX_HP);
  const match = createMatch({
    seed: 1, matchId: 'inject', fighters: { a: 'quartz', b: 'volt' },
    start: { a: { hp: 500, meter: 120 }, b: { hp: CONFIG.MAX_HP, meter: 0 } },
  });
  assert.equal(match.state.a.hp, 500);
  assert.equal(match.state.a.meter, 120);
  assert.equal(match.replay.start.a.hp, 500);
  return 'hp=' + CONFIG.MAX_HP + ' injectOk';
});

await runCheck('T3 胜者回血 15%（500→650、950→1000 封顶），气槽携带、替补冻结', () => {
  const ts = freshState();
  ts.sides.a.roster.quartz.hp = 500;
  ts.sides.a.roster.quartz.meter = 120;
  ts.sides.a.roster.volt.hp = 777;
  ts.sides.a.roster.volt.meter = 90;
  const s1 = applyRoundResult(ts, { winner: 'a', reason: 'ko' });
  assert.equal(ts.sides.a.roster.quartz.hp, 500 + TEAM_HEAL);
  assert.equal(s1.healed.amount, TEAM_HEAL);
  assert.equal(ts.sides.a.roster.quartz.meter, 120);
  assert.equal(ts.sides.a.roster.volt.hp, 777, 'benched hp frozen');
  assert.equal(ts.sides.a.roster.volt.meter, 90, 'benched meter frozen');
  assert.equal(ts.sides.b.roster.ember.alive, false);
  assert.equal(ts.sides.b.roster.ember.hp, 0);
  assert.deepEqual(ts.sides.b.fallen, ['ember']);
  assert.equal(ts.sides.b.order[0], 'tide');
  ts.sides.a.roster.quartz.hp = 950;
  const s2 = applyRoundResult(ts, { winner: 'a', reason: 'time_up' });
  assert.equal(ts.sides.a.roster.quartz.hp, CONFIG.MAX_HP);
  assert.equal(s2.healed.amount, CONFIG.MAX_HP - 950, 'heal capped at max');
  return 'heal=' + TEAM_HEAL + ' capOk';
});

await runCheck('T4 平局（双 KO / 时间到同血）双方场上角色同时淘汰', () => {
  const ts = freshState();
  const s = applyRoundResult(ts, { winner: 'draw', reason: 'ko' });
  assert.equal(s.eliminated.length, 2);
  assert.equal(s.healed, null);
  assert.equal(ts.sides.a.order[0], 'volt');
  assert.equal(ts.sides.b.order[0], 'tide');
  assert.equal(ts.over, false);
  return 'bothEliminated';
});

await runCheck('T5 淘汰终局：一方 3 人全灭判负，双方同时清空判平', () => {
  const ts = freshState();
  for (let i = 0; i < 3; i += 1) applyRoundResult(ts, { winner: 'a', reason: 'ko' });
  assert.equal(ts.over, true);
  assert.equal(ts.winner, 'a');
  assert.equal(ts.reason, 'elimination');
  assert.equal(ts.rounds.length, 3);
  const tr = teamResult(ts);
  assert.deepEqual(tr.fallen.b, TEAM_B);
  assert.equal(tr.survivors.a, 3);
  const draw = freshState();
  for (let i = 0; i < 3; i += 1) applyRoundResult(draw, { winner: 'draw', reason: 'ko' });
  assert.equal(draw.over, true);
  assert.equal(draw.winner, 'draw');
  return 'maxRounds=' + TEAM_MAX_ROUNDS;
});

await runCheck('T6 换人只允许存活池的排列：增删、重复、阵亡角色一律拒绝', () => {
  const ts = freshState();
  applyRoundResult(ts, { winner: 'a', reason: 'ko' }); // b loses ember
  assert.ok(isValidOrder(ts, 'b', ['basalt', 'tide']));
  assert.ok(applyOrder(ts, 'b', ['basalt', 'tide']));
  assert.equal(teamRoundStart(ts).fighters.b, 'basalt');
  assert.ok(!isValidOrder(ts, 'b', ['tide']));
  assert.ok(!isValidOrder(ts, 'b', ['tide', 'tide']));
  assert.ok(!isValidOrder(ts, 'b', ['tide', 'ember']));
  assert.ok(!isValidOrder(ts, 'b', ['tide', 'quartz']));
  assert.ok(!applyOrder(ts, 'b', ['tide', 'ember']));
  assert.deepEqual(ts.sides.b.order, ['basalt', 'tide'], 'rejected order leaves state untouched');
  return 'permutationOnly';
});

await runCheck('T7 离线整场组队赛：逐回合重演一致，篡改必被检出，扁平帧带回合标签', () => {
  const ts = freshState();
  const envelope = createTeamReplay(ts.matchId, ts.seed, [], { a: TEAM_A, b: TEAM_B });
  const policies = { a: BUILTIN_AGENTS[0].policy, b: BUILTIN_AGENTS[1].policy };
  let guard = 0;
  while (!ts.over && guard < TEAM_MAX_ROUNDS) { playRound(ts, envelope, policies); guard += 1; }
  assert.ok(ts.over, 'match must end by elimination');
  assert.ok(envelope.rounds.length >= 3);
  const replay = replayTeamMatch(envelope);
  assert.ok(replay.ok, JSON.stringify(replay.mismatches));
  assert.equal(replay.winner, ts.winner);
  const tampered = structuredClone(envelope);
  tampered.rounds[0].start.start.a.hp -= 1;
  assert.ok(!replayTeamMatch(tampered).ok, 'tampered start must fail verification');
  const flat = flattenTeamReplay(envelope);
  const rendered = renderTeamReplay(envelope);
  assert.equal(flat.length, rendered.reduce((n, r) => n + r.ticks.length, 0));
  assert.ok(flat.every((t) => t.round >= 1 && t.round <= envelope.rounds.length));
  return 'rounds=' + envelope.rounds.length + ' winner=' + ts.winner + ' ticks=' + flat.length;
});

await runCheck('T8 回放信封识别：team 信封可解析，单局 JSONL 不误判', () => {
  const envelope = createTeamReplay('x', 1, [], { a: TEAM_A, b: TEAM_B });
  assert.equal(parseTeamReplay(JSON.stringify(envelope)).format, 'afl-team-replay/1');
  assert.equal(parseTeamReplay('{"tick":0}\n{"tick":1}\n'), null);
  return 'envelopeOk';
});

// ---------------------------------------------------------------- part 2

async function call(name, args = {}) {
  const endpoint = (args.token && SERVICES.get(args.token)) || READ_EP;
  if (!endpoint) throw new Error('no player service resolved for ' + name + ': onboard a player first');
  return mcpTool(endpoint, name, args);
}

/** A real player with a real agent slot - the only identity the league accepts. */
async function playerAgent(label, { team, source } = {}) {
  const player = await onboardPlayer(AUTH_BASE, label);
  const reg = await mcpTool(player.endpoint, 'register_agent', {
    name: label, ...(team ? { team } : {}), ...(source ? { source } : {}),
  });
  // The bound service knows its own agent, but the pilots still connect with
  // the agent token, and call() routes by token, so keep the pair registered.
  SERVICES.set(reg.token, player.endpoint);
  return { ...player, ...reg, endpoint: player.endpoint };
}

function connectPilot(token, { policy, onIntermission = () => {} }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS + '/ws/agent?token=' + token);
    const pilot = { ws, messages: [], acts: 0, intermissions: 0, orderReplies: [] };
    const timer = setTimeout(() => reject(new Error('pilot connect timeout')), 8000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      pilot.messages.push(m);
      if (m.type === 'connected') { clearTimeout(timer); resolve(pilot); return; }
      if (m.type === 'observe') {
        const out = policy(m.observation);
        const action = typeof out === 'string' ? out : (out && out.action) || 'block';
        ws.send(JSON.stringify({ type: 'act', matchId: m.matchId, tick: m.tick, action }));
        pilot.acts += 1;
      } else if (m.type === 'intermission') {
        pilot.intermissions += 1;
        onIntermission(pilot, m);
      } else if (m.type === 'order_locked' || m.type === 'order_rejected') {
        pilot.orderReplies.push(m);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('pilot websocket error')); };
  });
}

function connectSpectator(roomId, onMessage = () => {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS + '/ws/spectate?room=' + roomId);
    const messages = [];
    const timer = setTimeout(() => reject(new Error('spectator connect timeout')), 8000);
    ws.onopen = () => { clearTimeout(timer); resolve({ ws, messages }); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('spectator websocket error')); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      messages.push(m);
      onMessage(m);
    };
  });
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(BASE + '/api/state')).ok) return true; } catch { /* not up yet */ }
    await delay(100);
  }
  return false;
}

async function verifyLive() {
  if (!TEST_DB) {
    check('T9-T14 实时组队列（MCP + WS + 匹配器）', true,
      'SKIP: AFL_TEST_DATABASE_URL is required - the league has no anonymous control plane, so these checks need real player accounts (see README 验收)');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-verify-team-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...authEnv(PORT, TEST_DB), AFL_TICK_MS: '8', AFL_DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });
  const pilots = [];
  let spectator = null;

  try {
    const up = await waitForServer();
    if (!up) throw new Error('server did not start: ' + serverLog.slice(-300));

    // A service must belong to someone, even for read-only calls.
    const viewer = await onboardPlayer(AUTH_BASE, 'Team Viewer');
    READ_EP = viewer.endpoint;
    const init = await mcpInitialize(READ_EP);
    check('T8a 玩家服务 initialize 与 tools/list 可用（26 工具含训练/成本面）',
      Boolean(init.serverInfo) && (await (await fetch(READ_EP, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })).json()).result.tools.length >= 26, 'protocol=' + init.protocolVersion);

    await runCheck('T9 服务端组队入口：注册带 team、规则含 team、常驻组队演示房、非法队伍被拒', async () => {
      const rules = await call('get_rules');
      assert.ok(rules.team && rules.team.size === 3 && rules.team.healOnRoundWin === TEAM_HEAL);
      const rooms = await call('list_rooms');
      assert.ok(rooms.rooms.some((r) => r.format === 'team' && r.mode === 'demo'), 'always-on team demo room');
      // Illegal rosters are rejected on the roster entry itself: a player-bound
      // service has exactly one slot, so "bad register" is no longer a thing.
      const probe = await playerAgent('Roster Probe');
      let badSize = false; let badDup = false;
      try { await call('set_team', { token: probe.token, team: ['quartz', 'volt'] }); } catch { badSize = true; }
      try { await call('set_team', { token: probe.token, team: ['quartz', 'quartz', 'volt'] }); } catch { badDup = true; }
      assert.ok(badSize && badDup);
      return 'demoRoomOk reject=' + badSize + '/' + badDup;
    });

    const regA = await playerAgent('Team Pilot A', { team: TEAM_A });
    const regB = await playerAgent('Team Pilot B', { team: TEAM_B });
    assert.deepEqual(regA.team, TEAM_A, 'roster registered through the player service');
    const room = await call('create_room', { token: regA.token, format: 'team', team: TEAM_A });
    assert.equal(room.format, 'team');
    const joined = await call('join_room', { token: regB.token, roomCode: room.code, team: TEAM_B });
    assert.equal(joined.roomId, room.roomId);

    // Running (not intermission): set_team_order must fail fast.
    let notInIntermission = false;
    try { await call('set_team_order', { token: regA.token, order: TEAM_A.slice().reverse() }); }
    catch (err) { notInIntermission = /not_in_intermission/.test(err.message); }

    // First intermission: pilot A tries an invalid WS order then a valid swap;
    // side B locks through the MCP tool instead, exercising both channels.
    let mcpLock = null; let mcpSecond = null;
    spectator = await connectSpectator(room.roomId, (m) => {
      if (m.type !== 'intermission' || mcpLock) return;
      const poolB = m.team.b.order.map((x) => x.fighterId);
      mcpLock = call('set_team_order', { token: regB.token, order: poolB })
        .then(async (out) => {
          try { await call('set_team_order', { token: regB.token, order: poolB.slice().reverse() }); }
          catch (err) { mcpSecond = err.message; }
          return out;
        })
        .catch((err) => { mcpSecond = err.message; return null; });
    });

    const pilotA = await connectPilot(regA.token, {
      policy: templatePolicy,
      onIntermission: (p, m) => {
        const pool = m.yourOrder;
        if (p.intermissions === 1) {
          p.ws.send(JSON.stringify({ type: 'team_order', matchId: m.matchId, order: [pool[0], pool[0], pool[1] || pool[0]] }));
          setTimeout(() => {
            p.ws.send(JSON.stringify({ type: 'team_order', matchId: m.matchId, order: pool.slice().reverse() }));
          }, 150);
        } else {
          p.ws.send(JSON.stringify({ type: 'team_order', matchId: m.matchId, order: pool }));
        }
      },
    });
    const pilotB = await connectPilot(regB.token, {
      policy: BUILTIN_AGENTS[0].policy,
      onIntermission: (p, m) => {
        if (p.intermissions >= 2) p.ws.send(JSON.stringify({ type: 'team_order', matchId: m.matchId, order: m.yourOrder }));
      },
    });
    pilots.push(pilotA, pilotB);

    let matchId = null;
    for (let i = 0; i < 450; i += 1) {
      const mine = await call('get_my_matches', { token: regA.token });
      if (mine.matches.length) { matchId = mine.matches[0].matchId; break; }
      await delay(200);
    }
    assert.ok(matchId, 'team match did not finish within 90s');
    await delay(300); // let trailing broadcasts land

    await runCheck('T10 组队私房全流程：回合广播、双通道换人、非法序被拒、打满淘汰终局', async () => {
      const types = spectator.messages.map((m) => m.type);
      const count = (t) => types.filter((x) => x === t).length;
      assert.ok(count('tick') > 50, 'ticks=' + count('tick'));
      assert.ok(count('round_start') >= 1, 'round_start=' + count('round_start'));
      assert.ok(count('round_end') >= 2, 'round_end=' + count('round_end'));
      assert.ok(count('intermission') >= 1, 'intermission=' + count('intermission'));
      assert.ok(count('order_locked') >= 2, 'order_locked=' + count('order_locked')
        + ' aReplies=' + JSON.stringify(pilotA.orderReplies.map((m) => m.type + ':' + (m.reason || '')))
        + ' mcpLock=' + JSON.stringify(mcpLock && mcpLock.locked ? 'ok' : mcpLock)
        + ' mcpSecond=' + String(mcpSecond || '').slice(0, 60)
        + ' Amsg=' + JSON.stringify(hist(pilotA.messages))
        + ' Bmsg=' + JSON.stringify(hist(pilotB.messages))
        + ' interA=' + pilotA.intermissions + ' interB=' + pilotB.intermissions);
      assert.ok(count('match_end') === 1);
      const end = spectator.messages.find((m) => m.type === 'match_end');
      assert.ok(end.result.team && end.result.reason === 'elimination');
      assert.ok(['a', 'b', 'draw'].includes(end.result.winner));
      assert.ok(pilotA.acts > 20 && pilotB.acts > 20, 'acts=' + pilotA.acts + '/' + pilotB.acts);
      // The server must have ACCEPTED what the pilots sent. Before the room
      // resume path was fixed, a hosted agent that connected over WS had every
      // act dropped by a guard on conn.meta.roomId: the pilots counted acts,
      // the league counted ~600 timeouts, and the match still "finished", so
      // nothing looked wrong from either side's own view.
      const stA = await call('get_agent_stats', { agentId: regA.agentId });
      const stB = await call('get_agent_stats', { agentId: regB.agentId });
      const cap = (n) => Math.max(3, Math.round(n * 0.05));
      assert.ok(stA.timeouts <= cap(pilotA.acts), 'side a acts dropped: timeouts=' + stA.timeouts + ' acts=' + pilotA.acts);
      assert.ok(stB.timeouts <= cap(pilotB.acts), 'side b acts dropped: timeouts=' + stB.timeouts + ' acts=' + pilotB.acts);
      assert.ok(pilotA.intermissions >= 1, 'pilot got intermission prompt');
      const rejected = pilotA.orderReplies.find((m) => m.type === 'order_rejected');
      assert.ok(rejected && rejected.reason === 'invalid_order', 'invalid WS order rejected');
      assert.ok(pilotA.orderReplies.some((m) => m.type === 'order_locked'));
      const locked = await mcpLock;
      assert.ok(locked && locked.ok, 'MCP set_team_order locked side b');
      assert.ok(mcpSecond && /order_already_locked|not_in_intermission/.test(mcpSecond), 'second lock refused: ' + mcpSecond);
      assert.ok(notInIntermission, 'set_team_order outside intermission refused');
      const roundEnds = spectator.messages.filter((m) => m.type === 'round_end');
      assert.ok(roundEnds.every((m) => m.summary.eliminated.length >= 1));
      return 'rounds=' + roundEnds.length + ' winner=' + end.result.winner + ' acts=' + pilotA.acts + '/' + pilotB.acts
        + ' timeouts=' + stA.timeouts + '/' + stB.timeouts;
    });

    await runCheck('T11 战果落库：format=team、不计分、信封回放可重演、render=1 扁平帧', async () => {
      const mine = await call('get_my_matches', { token: regA.token });
      const row = mine.matches[0];
      assert.equal(row.ranked, false);
      assert.equal(row.ratingDelta, 0);
      const result = await call('get_match_result', { matchId });
      assert.equal(result.format, 'team');
      assert.ok(result.team && result.team.rounds.length >= 3);
      const replayTool = await call('get_replay', { matchId });
      assert.equal(replayTool.format, 'afl-team-replay/1');
      const envelope = parseTeamReplay(replayTool.json);
      assert.ok(envelope);
      assert.deepEqual(envelope.teams, { a: TEAM_A, b: TEAM_B });
      const replay = replayTeamMatch(envelope);
      assert.ok(replay.ok, JSON.stringify(replay.mismatches));
      const rendered = await (await fetch(BASE + '/api/replay/' + matchId + '?render=1')).json();
      assert.ok(rendered.ticks.length > 50);
      assert.ok(rendered.ticks.every((t) => t.round >= 1));
      return 'rounds=' + envelope.rounds.length + ' replayOk renderedTicks=' + rendered.ticks.length;
    });

    let signup = null;
    await runCheck('T12 两名玩家各自报名：注册+建队+托管策略+排位报名，匹配器真实配对计分组队赛', async () => {
      // The league removed the one-shot POST /api/enter: registration is now
      // sign up as a player, then drive your own bound service. That is what
      // the account UI does, so the gate follows the same path.
      assert.equal((await fetch(BASE + '/api/enter', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nope' }),
      })).status, 404, 'legacy /api/enter is not served');

      const x = await playerAgent('Web Signup X', { team: ['gale', 'forge', 'tide'] });
      // A hosted agent must actually carry a strategy: without one the league
      // treats that side as remote and waits for a WS pilot, so the ranked room
      // would stall. Submitting the official template is the documented path.
      const tpl = await call('get_strategy_template', { token: x.token });
      const subX = await call('submit_strategy', { token: x.token, strategy: tpl.template });
      assert.ok(subX.accepted !== false && subX.versionHash, 'template strategy hosted for side X');
      const rx = await call('join_queue', { token: x.token, format: 'team' });
      assert.ok(rx.joined, 'registered player queued for team ladder');

      // Y deliberately fields a do-nothing strategy so the match has a decisive
      // winner and the wins-first assertions below actually exercise the win path.
      const y = await playerAgent('Web Signup Y', { team: ['noct', 'volt', 'ember'] });
      const idle = { name: 'idle-sandbox', defaultAction: 'idle', rules: [{ action: 'idle' }] };
      const sub = await call('submit_strategy', { token: y.token, strategy: idle });
      assert.ok(sub.versionHash, 'hosted strategy submitted for the losing side');
      const ry = await call('join_queue', { token: y.token, format: 'team' });
      assert.ok(ry.joined);
      assert.deepEqual(x.team, ['gale', 'forge', 'tide']);

      // Illegal rosters are rejected before any queue entry exists.
      let dupRoster = false;
      try { await call('set_team', { token: y.token, team: ['gale', 'gale', 'tide'] }); } catch { dupRoster = true; }
      assert.ok(dupRoster, 'duplicate roster rejected');

      // The matchmaker must pair the two REAL registrants with each other.
      let room = null;
      for (let i = 0; i < 100 && !room; i += 1) {
        const rooms = await call('list_rooms');
        room = rooms.rooms.find((r) => r.mode === 'ranked' && r.format === 'team'
          && (r.status === 'running' || r.status === 'intermission') && r.a && r.b
          && [r.a.id, r.b.id].includes(x.agentId) && [r.a.id, r.b.id].includes(y.agentId));
        if (!room) await delay(100);
      }
      assert.ok(room, 'matchmaker paired the two registered players');
      assert.equal(room.pairing, 'rating');
      assert.equal(room.ranked, true);
      const rosters = [room.team.a.order.map((e) => e.fighterId), room.team.b.order.map((e) => e.fighterId)];
      assert.ok(rosters.some((r) => JSON.stringify(r) === JSON.stringify(x.team)), 'side rosters come from registration');
      assert.ok(rosters.some((r) => JSON.stringify(r) === JSON.stringify(y.team)), 'side rosters come from registration');

      // Roster is locked while the match is live.
      let lockedErr = null;
      try { await call('set_team', { token: x.token, team: ['ember', 'tide', 'basalt'] }); }
      catch (err) { lockedErr = err.message; }
      assert.ok(lockedErr && /locked during match/.test(lockedErr), 'roster locked mid-match: ' + lockedErr);

      let row = null;
      for (let i = 0; i < 600 && !row; i += 1) {
        const mine = await call('get_my_matches', { token: x.token });
        if (mine.matches.length) { row = mine.matches[0]; break; }
        await delay(200);
      }
      assert.ok(row, 'ranked team match did not finish within 120s');
      const mine = await call('get_my_matches', { token: x.token });
      assert.equal(mine.matches.length, 1, 'one team match = one recorded result, not per-round');
      assert.equal(row.ranked, true);
      assert.equal(row.format, 'team');
      assert.equal(row.result, 'win', 'template strategy must beat the idle sandbox');
      assert.ok(row.ratingDelta > 0, 'ranked win moves rating up');
      signup = { x, y, row };
      signup = { x, y, row };
      return 'room=' + room.roomId + ' result=' + row.result + ' delta=' + row.ratingDelta;
    });

    await runCheck('T13 胜场榜：wins 优先排序、同胜场比评分、自建队伍进榜', async () => {
      assert.ok(signup, 'T12 must produce a ranked result first');
      const board = await call('get_leaderboard');
      const rows = board.rows;
      const rx = rows.find((r) => r.id === signup.x.agentId);
      const ry = rows.find((r) => r.id === signup.y.agentId);
      assert.ok(rx && ry, 'both signup agents on the board');
      assert.deepEqual(rx.team, signup.x.team, 'roster shown on the board');
      assert.deepEqual(ry.team, signup.y.team);
      // X beat the idle sandbox, so X must have wins and outrank Y. (>= not ===:
      // autoRequeue may already have produced another win by the time we read.)
      assert.ok(rx.wins >= 1, 'winner has wins');
      assert.equal(ry.wins, 0, 'idle sandbox never wins');
      assert.ok(rows.indexOf(rx) < rows.indexOf(ry), 'more wins ranks higher');
      for (let i = 1; i < rows.length; i += 1) {
        const a = rows[i - 1]; const b = rows[i];
        assert.ok(a.wins > b.wins || (a.wins === b.wins && a.rating >= b.rating), 'wins-first order broken at row ' + i);
      }
      return 'rows=' + rows.length + ' top=' + rows[0].name + ' wins=' + rows[0].wins;
    });

    await runCheck('T14 set_team：无队伍报名被拒、非法队伍被拒、建队后报名成功、局间可换队', async () => {
      const reg = await playerAgent('Roster Rules');
      let noRoster = null;
      try { await call('join_queue', { token: reg.token, format: 'team' }); } catch (err) { noRoster = err.message; }
      assert.ok(noRoster && /roster/.test(noRoster), 'team queue without roster rejected: ' + noRoster);
      for (const bad of [['quartz', 'volt'], ['quartz', 'quartz', 'volt'], ['quartz', 'volt', 'snk-bogus']]) {
        let msg = null;
        try { await call('set_team', { token: reg.token, team: bad }); } catch (err) { msg = err.message; }
        assert.ok(msg, 'bad roster rejected: ' + JSON.stringify(bad));
      }
      const ok = await call('set_team', { token: reg.token, team: ['ember', 'tide', 'basalt'] });
      assert.deepEqual(ok.team, ['ember', 'tide', 'basalt']);
      const q = await call('join_queue', { token: reg.token, format: 'team' });
      assert.ok(q.joined, 'queued after set_team');
      const re = await call('set_team', { token: reg.token, team: ['basalt', 'tide', 'ember'] });
      assert.deepEqual(re.team, ['basalt', 'tide', 'ember'], 're-pick allowed between matches');
      // No legacy POST /api/team: the account UI drives set_team through the
      // same player service, so the service IS the contract. Assert that.
      const gone = await fetch(BASE + '/api/team', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: reg.token, team: ['tide', 'ember', 'basalt'] }),
      });
      assert.equal(gone.status, 404, 'legacy /api/team is not served');
      const viaTool = await call('set_team', { token: reg.token, team: ['tide', 'ember', 'basalt'] });
      assert.deepEqual(viaTool.team, ['tide', 'ember', 'basalt'], 'the player service is the only roster entry');
      return 'validation+rePickOk legacyRest=404';
    });

    pilotA.ws.close();
    pilotB.ws.close();
    spectator.ws.close();
  } finally {
    for (const p of pilots) { try { p.ws.close(); } catch { /* already closed */ } }
    if (spectator) { try { spectator.ws.close(); } catch { /* already closed */ } }
    child.kill('SIGTERM');
    await delay(150);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

await verifyLive();
const passed = results.filter((r) => r.ok).length;
console.log('\n=== ' + passed + '/' + results.length + ' team checks passed ===\n');
if (passed !== results.length) process.exitCode = 1;