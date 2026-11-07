import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG, ACTIONS } from '../src/rules.js';
import { createInitialState, step, stateHash, runMatch, replayMatch, renderReplay } from '../src/engine.js';
import { BUILTIN_AGENTS } from '../src/agents.js';
import { initialize, listTools, callTool, registerAgent, joinQueue, AgentClient, templatePolicy } from '../sdk/agent-client.mjs';
import { simulateReplay } from '../src/simulator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT;
const results = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
}

async function rpc(method, params = {}) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  });
  return (await res.json()).result;
}

async function openSpectator(roomId, ticks) {
  const ws = new WebSocket(WS + '/ws/spectate?room=' + roomId);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    setTimeout(() => reject(new Error('spectator connect timeout')), 5000);
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'tick') ticks.push(m);
  };
  return ws;
}

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
function verifyReplays() {
  let failures = 0;
  let totalTicks = 0;
  const A = BUILTIN_AGENTS;
  for (let i = 0; i < 60; i += 1) {
    const a = A[i % A.length];
    const b = A[(i + 1 + (i % 2)) % A.length];
    const r = runMatch({ seed: 9000 + i * 131, policyA: a.policy, policyB: b.policy, agents: [a, b], matchId: 'v_' + i });
    const v = replayMatch(r.replay);
    if (!v.ok) failures += 1;
    totalTicks += r.replay.ticks.length;
  }
  check('C2 回放可复现：60 局不同 seed 全部逐拍重演一致', failures === 0, 'failures=' + failures + ' totalTicks=' + totalTicks);
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

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await delay(100);
  }
  return false;
}

async function verifyEndToEnd() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-verify-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AFL_TICK_MS: '8', AFL_DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    const up = await waitForServer();
    check('C4 测试服务启动（锁步 8ms/拍 加速，独立数据目录）', up, up ? BASE : serverLog.slice(-300));
    if (!up) return;

    // MCP control plane
    const init = await initialize(BASE);
    const tools = await listTools(BASE);
    check('C5 标准 MCP 客户端连通 initialize + tools/list', Boolean(init.serverInfo) && tools.length >= 9, 'protocol=' + init.protocolVersion + ' tools=' + tools.length);
    const reg = await registerAgent(BASE, { name: 'Verify Bot', kind: 'rule' });
    await joinQueue(BASE, reg.token);
    const rules = await callTool(BASE, 'get_rules');
    const schema = await callTool(BASE, 'get_observation_schema');
    check('C6 MCP 控制面 register_agent / join_queue / get_rules / schema', Boolean(reg.token) && rules.actions.length === ACTIONS.length && Boolean(schema.properties.derived), 'agentId=' + reg.agentId);

    // External agent process via the official SDK
    const client = new AgentClient({
      url: WS + '/ws/agent',
      token: reg.token,
      policy: templatePolicy,
      defaultAction: 'block',
      onLog: () => {},
    });
    await client.connect();

    // Rooms are independent: subscribe to THIS agent's ranked room, not the
    // always-on demo room, otherwise spectator frames belong to another match.
    let roomId = null;
    for (let i = 0; i < 60; i += 1) {
      const lr = await callTool(BASE, 'list_rooms');
      const found = lr.rooms.find((r) => r.mode === 'ranked' && ((r.a && r.a.id === reg.agentId) || (r.b && r.b.id === reg.agentId)));
      if (found) { roomId = found.roomId; break; }
      await delay(100);
    }
    const spectatorTicks = [];
    const spectator = new WebSocket(WS + '/ws/spectate' + (roomId ? '?room=' + roomId : ''));
    await new Promise((resolve, reject) => {
      spectator.onopen = resolve;
      spectator.onerror = reject;
      setTimeout(() => reject(new Error('spectator connect timeout')), 5000);
    });
    spectator.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'tick' && (!roomId || m.roomId === roomId)) spectatorTicks.push(m);
    };

    const end = await client.waitForMatchEnd(45000);
    const matchId = end.matchId;
    client.close();
    spectator.close();

    check('C7 外部进程 Agent 用官方 SDK 打完整一局', Boolean(end.result && end.result.winner) && client.actCount > 20, 'matchId=' + matchId + ' acts=' + client.actCount + ' winner=' + end.result.winner + ' ticks=' + end.result.ticks);
    check('C8 观战 WebSocket 收到实时逐拍帧', spectatorTicks.length > 10, 'tickMessages=' + spectatorTicks.length);

    const matches = await (await fetch(BASE + '/api/matches')).json();
    const record = matches.matches.find((m) => m.matchId === matchId);
    check('C9 战果写入赛程与排行榜', Boolean(record) && (record.a.id === reg.agentId || record.b.id === reg.agentId), record ? 'winner=' + record.winnerName + ' deltaA=' + record.ratingDeltaA : 'not found');

    const replayResp = await (await fetch(BASE + '/api/replay/' + matchId + '?render=1')).json();
    const rendered = replayResp.ticks || [];
    // The spectator socket may join a tick late, so compare the first tick
    // BOTH sides actually have instead of hard-coding tick 0.
    const pair = rendered
      .map((rt) => ({ rt, live: spectatorTicks.find((t) => t.matchId === matchId && t.tick === rt.tick) }))
      .find((p) => p.live);
    const a = pair ? JSON.stringify(pair.rt.frames) : null;
    const b = pair ? JSON.stringify(pair.live.frames) : null;
    let diffAt = -1;
    if (a && b && a !== b) {
      for (let i = 0; i < Math.min(a.length, b.length); i += 1) { if (a[i] !== b[i]) { diffAt = i; break; } }
    }
    check('C10 回放渲染帧与服务端实拍帧一致', rendered.length > 10 && Boolean(a) && a === b,
      'renderedTicks=' + rendered.length + ' comparedTick=' + (pair ? pair.rt.tick : 'none')
      + ' diffAt=' + diffAt
      + (diffAt >= 0 ? ' replay=' + a.slice(Math.max(0, diffAt - 60), diffAt + 90) + ' LIVE=' + b.slice(Math.max(0, diffAt - 60), diffAt + 90) : ''));

    const replayTool = await callTool(BASE, 'get_replay', { matchId });
    const sim = simulateReplay(replayTool.jsonl, templatePolicy);
    check('C11 MCP 下载回放 + 本地模拟器可逐拍重放策略', sim.ticks > 10, 'ticks=' + sim.ticks + ' agreementWithTemplate=' + sim.agreement + '%');

    const board = await callTool(BASE, 'get_leaderboard', {});
    const me = board.rows.find((r) => r.id === reg.agentId);
    check('C12 榜单由真实对局结果生成（rating 已变动）', Boolean(me) && me.matches >= 1 && me.rating !== 1500, me ? 'rating=' + me.rating + ' matches=' + me.matches + ' rd=' + me.rd : 'missing');

    // C13 - strategy version declaration: deterministic fingerprint, invalid hash rejected
    const sha = 'a'.repeat(64);
    const v1 = await callTool(BASE, 'update_strategy', { token: reg.token, note: 'verify', strategyHash: sha, defaultAction: 'block' });
    const v2 = await callTool(BASE, 'update_strategy', { token: reg.token, note: 'verify', strategyHash: sha, defaultAction: 'block' });
    let badRejected = false;
    try { await callTool(BASE, 'update_strategy', { token: reg.token, strategyHash: 'not-a-hash' }); } catch { badRejected = true; }
    check('C13 策略版本：同文件 hash 可复现、非法 hash 被拒', v1.versionHash === v2.versionHash && v1.strategyHash === sha && badRejected, 'versionHash=' + v1.versionHash);

    // C14 - onboarding docs / examples are actually served, path traversal blocked
    const docPaths = ['/guide.html', '/guide.css', '/docs/agent-onboarding.md', '/examples/starter/agent.mjs', '/examples/starter/SKILL.md', '/examples/starter/README.md', '/examples/llm-agent/agent.mjs', '/sdk/agent-client.mjs'];
    const codes = [];
    for (const p of docPaths) codes.push((await fetch(BASE + p)).status);
    const traversal = (await fetch(BASE + '/docs/%2e%2e/data/league.json')).status;
    check('C14 对接手册 / 示例包 / SDK 可访问，目录穿越被拦截', codes.every((c) => c === 200) && traversal !== 200, 'ok=' + codes.filter((c) => c === 200).length + '/' + codes.length + ' traversal=' + traversal);

    // C15 - the copyable starter package stays in sync with the official SDK and passes its offline tests
    const sdkA = fs.readFileSync(path.join(ROOT, 'sdk/agent-client.mjs'), 'utf8');
    const sdkB = fs.readFileSync(path.join(ROOT, 'examples/starter/agent-client.mjs'), 'utf8');
    const unit = spawnSync(process.execPath, ['examples/starter/strategy.test.mjs'], { cwd: ROOT, encoding: 'utf8' });
    check('C15 示例包 SDK 副本同步 + 离线策略单测通过', sdkA === sdkB && unit.status === 0, 'sdkMatch=' + (sdkA === sdkB) + ' testExit=' + unit.status);

    // C16 - an invalid token must fail fast instead of hanging forever
    let rejected = false;
    const bad = new AgentClient({ url: WS + '/ws/agent', token: 'ag_invalid', policy: templatePolicy, onLog: () => {} });
    const t0 = Date.now();
    try { await bad.connect(); } catch { rejected = true; }
    const elapsed = Date.now() - t0;
    check('C16 无效 token 快速报错而非挂起', rejected && elapsed < 4000, 'elapsedMs=' + elapsed);

    // C17 - literally run the command from the onboarding manual and finish a real match
    const demo = spawn(process.execPath, ['examples/starter/agent.mjs', '--base', BASE, '--ws', WS + '/ws/agent', '--token', reg.token, '--name', 'Doc Starter'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let demoOut = '';
    demo.stdout.on('data', (d) => { demoOut += d.toString(); });
    demo.stderr.on('data', (d) => { demoOut += d.toString(); });
    const demoExit = await new Promise((resolve) => {
      const timer = setTimeout(() => { demo.kill('SIGTERM'); resolve('timeout'); }, 45000);
      demo.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    const summary = demoOut.split('\n').filter((l) => /本局结果|胜者|我的决策/.test(l)).join(' / ').slice(0, 170);
    check('C17 按手册命令真实运行示例策略包并打完一局', demoExit === 0 && /本局结果/.test(demoOut), 'exit=' + demoExit + ' ' + summary);

    // C18 - MCP-native material an off-the-shelf agent client can consume
    const resList = await rpc('resources/list');
    const promptList = await rpc('prompts/list');
    const skillRes = await rpc('resources/read', { uri: 'afl://skill' });
    const skillText = (skillRes.contents && skillRes.contents[0] && skillRes.contents[0].text) || '';
    const skillHttp = await (await fetch(BASE + '/SKILL.md')).text();
    const configs = await (await fetch(BASE + '/skills/afl-league/mcp-configs.json')).json();
    check('C18 MCP resources / prompts / SKILL.md / 多客户端配置可直接喂给现成 Agent',
      resList.resources.length >= 8 && promptList.prompts.length >= 3 && skillText.includes('托管') && skillHttp.includes('submit_strategy') && configs.clients.length >= 6,
      'resources=' + resList.resources.length + ' prompts=' + promptList.prompts.length + ' skillBytes=' + skillText.length + ' clients=' + configs.clients.length);

    // C19 - the hosted (MCP-only) track really fights a full match
    const tpl = await callTool(BASE, 'get_strategy_template');
    const validation = await callTool(BASE, 'validate_strategy', { strategy: tpl.template });
    const simResult = await callTool(BASE, 'simulate_strategy', { strategy: tpl.template, opponents: ['brawler', 'zoner'], seeds: [101, 202] });
    const hreg = await registerAgent(BASE, { name: 'Verify Hosted', kind: 'rule', source: 'hosted' });
    const sub = await callTool(BASE, 'submit_strategy', { token: hreg.token, strategy: tpl.template, autoRequeue: false });
    await callTool(BASE, 'join_queue', { token: hreg.token, mode: 'ranked' });
    let mine = { matches: [] };
    for (let i = 0; i < 150; i += 1) {
      mine = await callTool(BASE, 'get_my_matches', { token: hreg.token });
      if (mine.matches.length) break;
      await delay(200);
    }
    const hm = mine.matches[0];
    check('C19 托管策略：模拟→校验→提交→入队→真实打完一局并留下版本指纹',
      validation.valid && simResult.games === 4 && sub.source === 'hosted'
      && sub.versionHash === validation.strategyHash.slice(0, 12)
      && Boolean(hm && hm.matchId && hm.roomId && hm.ranked),
      'winRate=' + simResult.overallWinRate + '% version=' + sub.versionHash + ' match=' + (hm ? hm.matchId : 'none') + ' room=' + (hm ? hm.roomId : 'none'));

    // C20 - private scrim room by code, unranked, with distinct fighters
    const sh = await registerAgent(BASE, { name: 'Scrim Host', kind: 'rule', source: 'hosted', fighterId: 'ember' });
    const sg = await registerAgent(BASE, { name: 'Scrim Guest', kind: 'rule', source: 'hosted', fighterId: 'tide' });
    await callTool(BASE, 'submit_strategy', { token: sh.token, strategy: tpl.template, autoRequeue: false });
    await callTool(BASE, 'submit_strategy', { token: sg.token, strategy: tpl.template, autoRequeue: false });
    const scrim = await callTool(BASE, 'create_room', { token: sh.token, fighterId: 'ember' });
    const joined = await callTool(BASE, 'join_room', { token: sg.token, roomCode: scrim.code });
    let scrimRows = { matches: [] };
    for (let i = 0; i < 150; i += 1) {
      scrimRows = await callTool(BASE, 'get_my_matches', { token: sh.token });
      if (scrimRows.matches.length) break;
      await delay(200);
    }
    const sm = scrimRows.matches[0];
    check('C20 私房按房间码约战：立即开打、不计分、允许不同角色',
      Boolean(scrim.code) && joined.roomId === scrim.roomId && Boolean(sm) && sm.ranked === false && sm.ratingDelta === 0,
      'code=' + scrim.code + ' room=' + joined.roomId + ' ranked=' + (sm ? sm.ranked : 'n/a') + ' delta=' + (sm ? sm.ratingDelta : 'n/a'));

    // C21 - rooms run concurrently and spectator streams are isolated by roomId
    let running = [];
    for (let i = 0; i < 60; i += 1) {
      const roomsNow = await callTool(BASE, 'list_rooms');
      running = roomsNow.rooms.filter((r) => r.status === 'running');
      if (running.length >= 2) break;
      await delay(250);
    }
    const t1 = []; const t2 = [];
    let w1 = null; let w2 = null;
    if (running.length >= 2) {
      w1 = await openSpectator(running[0].roomId, t1);
      w2 = await openSpectator(running[1].roomId, t2);
      await delay(1200);
    }
    const concurrent = t1.length > 1 && t2.length > 1;
    const isolated = t1.every((t) => t.roomId === running[0]?.roomId) && t2.every((t) => t.roomId === running[1]?.roomId);
    if (w1) w1.close();
    if (w2) w2.close();
    check('C21 多房间并发，观战按 roomId 分流且互不串流', running.length >= 2 && concurrent && isolated,
      'runningRooms=' + running.length + ' ticksA=' + t1.length + ' ticksB=' + t2.length + ' isolated=' + isolated);

    // C22 - fighter roster in the data chain + DSL rejects unsafe input
    const fighters = await callTool(BASE, 'list_fighters');
    const fHttp = await (await fetch(BASE + '/api/fighters')).json();
    const board2 = await callTool(BASE, 'get_leaderboard', {});
    let badAction = false; let badPath = false; let badComparator = false;
    try { await callTool(BASE, 'validate_strategy', { strategy: { name: 'x', defaultAction: 'block', rules: [{ action: 'NUKE' }] } }); } catch { badAction = true; }
    try { await callTool(BASE, 'validate_strategy', { strategy: { name: 'x', defaultAction: 'block', rules: [{ when: { 'self.constructor': 1 }, action: 'block' }] } }); } catch { badPath = true; }
    try { await callTool(BASE, 'validate_strategy', { strategy: { name: 'x', defaultAction: 'block', rules: [{ when: { 'derived.threat': { evil: 1 } }, action: 'block' }] } }); } catch { badComparator = true; }
    const teams = fHttp.teams || [];
    const rosterOk = fighters.length === 16 && teams.length === 4
      && teams.every((t) => t.fighters.length === 4)
      && fighters.every((f) => f.team && f.teamName && f.teamColor)
      && fighters.every((f) => f.id && f.palette && f.gear && f.signature);
    check('C22 16 位原创角色 / 4 支队伍进入数据链路，DSL 拒绝非法动作 / 原型字段 / 未知比较器',
      rosterOk && Boolean(fHttp.fighters[0].build) && board2.rows.every((r) => r.fighterId) && badAction && badPath && badComparator,
      'fighters=' + fighters.length + ' teams=' + teams.length + ' build=' + Boolean(fHttp.fighters[0].build) + ' reject=' + [badAction, badPath, badComparator].join('/'));
  } finally {
    child.kill('SIGTERM');
    await delay(150);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp cleanup best effort */ }
  }
}

console.log('\n=== Agent Fighting League · end-to-end verification ===\n');
verifyDeterminism();
verifyReplays();
verifySpectatorFrames();
await verifyEndToEnd();
const passed = results.filter((r) => r.ok).length;
console.log('\n=== ' + passed + '/' + results.length + ' checks passed ===\n');
if (passed !== results.length) process.exitCode = 1;
