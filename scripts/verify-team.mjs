/**
 * Team elimination (KOF-style 3v3) verification gate.
 *
 * Part 1 exercises the pure state machine (src/team.js) with crafted states:
 * the 15% heal math, draw double-elimination, alive-pool-only reordering and
 * full offline match replayability. Part 2 boots a real server with 8ms ticks
 * and drives a complete team scrim through MCP + two live WebSocket pilots +
 * a spectator, including the intermission order exchange on both channels.
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
const results = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
  });
  const r = (await res.json()).result;
  if (r && r.isError) throw new Error(r.content[0].text.replace(/^error: /, ''));
  return r.structuredContent;
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-verify-team-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AFL_TICK_MS: '8', AFL_DATA_DIR: tmp },
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

    await runCheck('T9 服务端组队入口：注册带 team、规则含 team、常驻组队演示房、非法队伍被拒', async () => {
      const rules = await call('get_rules');
      assert.ok(rules.team && rules.team.size === 3 && rules.team.healOnRoundWin === TEAM_HEAL);
      const rooms = await call('list_rooms');
      assert.ok(rooms.rooms.some((r) => r.format === 'team' && r.mode === 'demo'), 'always-on team demo room');
      let badSize = false; let badDup = false;
      try { await call('register_agent', { name: 'Bad Size', team: ['quartz', 'volt'] }); } catch { badSize = true; }
      try { await call('register_agent', { name: 'Bad Dup', team: ['quartz', 'quartz', 'volt'] }); } catch { badDup = true; }
      assert.ok(badSize && badDup);
      return 'demoRoomOk reject=' + badSize + '/' + badDup;
    });

    const regA = await call('register_agent', { name: 'Team Pilot A', kind: 'rule', team: TEAM_A });
    const regB = await call('register_agent', { name: 'Team Pilot B', kind: 'rule', team: TEAM_B });
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
      assert.ok(count('order_locked') >= 2, 'order_locked=' + count('order_locked'));
      assert.ok(count('match_end') === 1);
      const end = spectator.messages.find((m) => m.type === 'match_end');
      assert.ok(end.result.team && end.result.reason === 'elimination');
      assert.ok(['a', 'b', 'draw'].includes(end.result.winner));
      assert.ok(pilotA.acts > 20 && pilotB.acts > 20, 'acts=' + pilotA.acts + '/' + pilotB.acts);
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
      return 'rounds=' + roundEnds.length + ' winner=' + end.result.winner + ' acts=' + pilotA.acts + '/' + pilotB.acts;
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

    await runCheck('T12 浏览器展览入口 /api/team-exhibition：自定义双方队伍即开打', async () => {
      const res = await fetch(BASE + '/api/team-exhibition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamA: ['gale', 'forge', 'tide'], teamB: ['noct', 'volt', 'ember'] }),
      });
      assert.equal(res.status, 200);
      const ex = await res.json();
      assert.equal(ex.format, 'team');
      assert.ok(ex.roomId && ex.watchUrl);
      const rooms = await call('list_rooms');
      const found = rooms.rooms.find((r) => r.roomId === ex.roomId);
      assert.ok(found && found.format === 'team' && found.status === 'running');
      assert.deepEqual(found.team.a.order.map((x) => x.fighterId), ['gale', 'forge', 'tide']);
      let bad = false;
      const badRes = await fetch(BASE + '/api/team-exhibition', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamA: ['gale', 'gale', 'tide'], teamB: TEAM_B }),
      });
      bad = badRes.status === 400;
      assert.ok(bad, 'duplicate team rejected with 400');
      return 'room=' + ex.roomId;
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