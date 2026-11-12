#!/usr/bin/env node
/**
 * 独立 MCP 客户端实测（不是自写 fetch 封装，也不是直接调内部函数）。
 *
 * 使用官方 @modelcontextprotocol/sdk 的 Client + StreamableHTTPClientTransport
 * 连接本站 /mcp，完成 initialize / notifications/initialized 握手，然后：
 *   listTools / listResources / listPrompts / readResource / getPrompt
 *   -> register_agent -> get_rules -> get_strategy_template -> validate_strategy
 *   -> simulate_strategy -> submit_strategy -> join_queue -> 打完一整局
 *   -> get_my_matches -> get_match_result -> get_replay -> get_leaderboard
 *
 * 同时用 WebSocket 观战抓服务端实拍帧，与回放离线重算帧逐拍比对，
 * 并用 replayMatch 验证状态哈希链，证明观战页数字不是随机数。
 *
 * 复现：
 *   npm install --prefix /tmp/afl-mcp-probe @modelcontextprotocol/sdk
 *   AFL_MCP_SDK_ROOT=/tmp/afl-mcp-probe/node_modules \
 *     AFL_MCP_URL=http://127.0.0.1:8787/mcp/<player key> node scripts/mcp-real-client.mjs
 *
 * 用 AFL_MCP_URL 而不是 AFL_BASE：控制面绑定玩家，真实服务地址是 /mcp/<key>。
 * 只给 AFL_BASE 时探测的是匿名沙箱（仅未配置账号库时存在），报告会写清探测的是哪一个。
 *
 * Windows 下把 /tmp 换成任意目录，AFL_MCP_SDK_ROOT 指向其 node_modules。
 * 输出：docs/mcp-client-probe.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { replayMatch, renderReplay } from '../src/engine.js';
import { parseReplay } from '../src/replay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.AFL_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
// Prefer the player service URL; fall back to the sandbox path and label it.
const MCP_URL = (process.env.AFL_MCP_URL || '').replace(/\/+$/, '') || BASE + '/mcp';
const PROBE_MODE = /\/mcp(\/|$)/.test(MCP_URL) && MCP_URL !== BASE + '/mcp' ? 'player-service' : 'anonymous-sandbox';
const WS_BASE = BASE.replace(/^http/, 'ws');
const REPORT_PATH = path.join(ROOT, 'docs', 'mcp-client-probe.json');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  client: 'official @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport',
  checks: [],
  evidence: {},
};
let failed = 0;
function check(name, ok, detail = '') {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
  if (!ok) failed += 1;
}

function sdkRoot() {
  const candidates = [
    process.env.AFL_MCP_SDK_ROOT,
    path.join(ROOT, 'node_modules'),
    path.join(os.tmpdir(), 'afl-mcp-probe', 'node_modules'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'streamableHttp.js'))) return dir;
  }
  return null;
}

const root = sdkRoot();
if (!root) {
  console.error('找不到官方 MCP SDK。先执行：');
  console.error('  npm install --prefix /tmp/afl-mcp-probe @modelcontextprotocol/sdk');
  console.error('然后设置 AFL_MCP_SDK_ROOT=/tmp/afl-mcp-probe/node_modules');
  process.exit(2);
}
report.sdkRoot = root;
let sdkVersion = 'unknown';
try {
  sdkVersion = JSON.parse(fs.readFileSync(path.join(root, '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8')).version;
} catch { /* ignore */ }
report.sdkVersion = sdkVersion;

const esm = (p) => pathToFileURL(path.join(root, '@modelcontextprotocol', 'sdk', 'dist', 'esm', p)).href;
const { Client } = await import(esm('client/index.js'));
const { StreamableHTTPClientTransport } = await import(esm('client/streamableHttp.js'));

function unwrap(result) {
  if (!result) return null;
  if (result.isError) throw new Error('tool error: ' + (result.content?.[0]?.text || 'unknown'));
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** 服务端实拍观战帧，按 tick 索引。 */
function spectate(roomId, durationMs, tag) {
  return new Promise((resolve) => {
    const ticks = new Map();
    let hello = null;
    let ws;
    try {
      ws = new WebSocket(WS_BASE + '/ws/spectate?room=' + encodeURIComponent(roomId));
    } catch (e) {
      resolve({ ticks, hello, error: String(e) });
      return;
    }
    const finish = () => { try { ws.close(); } catch { /* noop */ } resolve({ ticks, hello, error: null }); };
    const timer = setTimeout(finish, durationMs);
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'hello') hello = m;
      if (m.type === 'tick') ticks.set(m.tick, m);
      if (m.type === 'tick' && m.over && tag === 'ranked') {
        clearTimeout(timer);
        setTimeout(finish, 300);
      }
    };
    ws.onerror = () => { /* finish on timer */ };
    ws.onclose = () => { clearTimeout(timer); resolve({ ticks, hello, error: null }); };
    void tag;
  });
}

function actionStats(replay) {
  const counts = {};
  for (const t of replay.ticks) {
    for (const k of ['actionA', 'actionB']) counts[t[k]] = (counts[t[k]] || 0) + 1;
  }
  return counts;
}

function hpCurve(rendered) {
  const out = [];
  for (const t of rendered) {
    const f = t.frames[t.frames.length - 1];
    if (f) out.push({ tick: t.tick, hpA: f.a.hp, hpB: f.b.hp, meterA: f.a.meter, meterB: f.b.meter });
  }
  return out;
}

const client = new Client({ name: 'afl-independent-probe', version: '1.0.0' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
let connected = false;

try {
  // ---- 1. 真实 MCP 握手 -------------------------------------------------
  await client.connect(transport);
  connected = true;
  const serverInfo = client.getServerVersion();
  const caps = client.getServerCapabilities();
  report.evidence.handshake = {
    serverInfo, capabilities: caps,
    transport: 'Streamable HTTP (POST ' + (PROBE_MODE === 'player-service' ? '/mcp/<player key>' : '/mcp') + ')',
    probed: PROBE_MODE,
  };
  check('M1 官方 MCP SDK 完成 initialize + notifications/initialized 握手',
    Boolean(serverInfo?.name), 'server=' + serverInfo?.name + ' v' + serverInfo?.version + ' sdk=' + sdkVersion);

  const tools = await client.listTools();
  const resources = await client.listResources();
  const prompts = await client.listPrompts();
  report.evidence.capabilities = {
    tools: tools.tools.map((t) => t.name),
    resources: resources.resources.map((r) => r.uri),
    prompts: prompts.prompts.map((p) => p.name),
  };
  check('M2 标准 tools/list + resources/list + prompts/list 可用',
    tools.tools.length >= 18 && resources.resources.length >= 9 && prompts.prompts.length >= 4,
    'tools=' + tools.tools.length + ' resources=' + resources.resources.length + ' prompts=' + prompts.prompts.length);

  const skill = await client.readResource({ uri: 'afl://skill' });
  const rulesRes = await client.readResource({ uri: 'afl://rules' });
  const prompt = await client.getPrompt({ name: 'first-match' });
  const rulesText = rulesRes.contents?.[0]?.text || '{}';
  let rulesResource = null;
  try { rulesResource = JSON.parse(rulesText); } catch { /* ignore */ }
  check('M3 resources/read + prompts/get 返回真实内容',
    (skill.contents?.[0]?.text || '').includes('register_agent') && Boolean(rulesResource?.moves) && Boolean(prompt.messages?.[0]?.content?.text),
    'skillBytes=' + (skill.contents?.[0]?.text || '').length + ' rulesMoves=' + Object.keys(rulesResource?.moves || {}).length);

  const call = async (name, args = {}) => unwrap(await client.callTool({ name, arguments: args }));

  // ---- 2. 走真实工具链：注册 -> 策略 -> 入队 ---------------------------
  const reg = await call('register_agent', { name: 'Independent MCP Probe', kind: 'rule', source: 'hosted' });
  check('M4 tools/call register_agent 签发真实 token', Boolean(reg?.token) && Boolean(reg?.agentId),
    'agentId=' + reg?.agentId + ' token=' + String(reg?.token || '').slice(0, 8) + '…');

  const rules = await call('get_rules');
  const boxMoves = Object.values(rules?.boxes?.moves || {}).filter((m) => Array.isArray(m.hitboxes) && m.hitboxes.length).length;
  check('M5 get_rules 返回 19 动作 + 权威判定框数据',
    rules?.actions?.length === 19 && boxMoves >= 5 && (rules?.boxes?.joints?.length || 0) >= 10,
    'actions=' + rules?.actions?.length + ' movesWithHitboxes=' + boxMoves + ' joints=' + rules?.boxes?.joints?.length + ' bones=' + rules?.boxes?.bones?.length);

  const tpl = await call('get_strategy_template');
  const strategy = tpl?.template;
  const validated = await call('validate_strategy', { strategy });
  const sim = await call('simulate_strategy', { strategy, seeds: [101, 202, 303] });
  report.evidence.simulate = { overallWinRate: sim?.overallWinRate, games: sim?.games, rows: sim?.rows, note: '离线模拟，不是排行榜数据' };
  check('M6 模板 -> validate -> simulate 闭环',
    Boolean(validated?.valid) && typeof sim?.overallWinRate === 'number' && sim?.games > 0,
    'dsl=' + validated?.dsl + ' offlineWinRate=' + sim?.overallWinRate + '% games=' + sim?.games);

  // Reusing a key is normal (it is the human's own service URL), and a reused
  // agent may still be fighting from the previous run. The league locks the
  // strategy mid-match, so wait it out instead of reporting a failure.
  for (let i = 0; i < 90; i += 1) {
    const live = (await call('list_rooms'))?.rooms || [];
    const busy = live.some((r) => r.mode === 'ranked' && [r.a?.id, r.b?.id].includes(reg.agentId)
      && (r.status === 'running' || r.status === 'intermission'));
    if (!busy) break;
    if (i === 89) console.error('  [probe] agent still mid-match after 90s; submitting anyway');
    await delay(1000);
  }
  const submitted = await call('submit_strategy', { token: reg.token, strategy });
  check('M7 submit_strategy 落库并生成版本 hash',
    Boolean(submitted?.versionHash) && submitted?.versionHash === validated?.strategyHash?.slice(0, 12),
    'versionHash=' + submitted?.versionHash + ' rules=' + submitted?.rules);

  const queued = await call('join_queue', { token: reg.token, mode: 'ranked' });
  // 排位要等匹配（无人时约 3 秒配内置陪练），所以持续查大厅直到自己的房间出现。
  let myRoom = null;
  for (let i = 0; i < 14 && !myRoom; i += 1) {
    const roomsNow = await call('list_rooms');
    myRoom = (roomsNow?.rooms || []).find((r) => r.mode === 'ranked' && [r.a?.id, r.b?.id].includes(reg.agentId));
    if (!myRoom) await delay(1000);
  }
  check('M8 join_queue 真的进入排位队列并开出房间',
    Boolean(queued?.joined) && Boolean(myRoom),
    'queuePosition=' + queued?.position + ' roomId=' + myRoom?.roomId + ' opponent=' + (myRoom?.a?.id === reg.agentId ? myRoom?.b?.name : myRoom?.a?.name));

  // ---- 3. 观战抓帧 + 等这一局打完 --------------------------------------
  const demoPromise = spectate('r_demo', 9000, 'demo');
  const rankedPromise = myRoom ? spectate(myRoom.roomId, 75000, 'ranked') : Promise.resolve({ ticks: new Map(), hello: null, error: 'no room' });

  let finished = null;
  const deadline = Date.now() + 80000;
  while (Date.now() < deadline) {
    await delay(1200);
    const mine = await call('get_my_matches', { token: reg.token, limit: 5 });
    // Must be THIS run's match. On a reused key the history already holds
    // earlier games, and comparing a fresh spectator stream against an old
    // replay would silently measure nothing (M14 compared=0). Prefer the room we
    // just opened, and only accept a row that came from it.
    const rows = (mine?.matches || []).filter((m) => m.ticks > 20);
    finished = myRoom
      ? rows.find((m) => m.roomId === myRoom.roomId || String(m.matchId).startsWith(myRoom.roomId + '_'))
      : rows[0];
    if (finished) break;
  }
  check('M9 托管策略真的打完一整局并写入战绩', Boolean(finished),
    finished ? 'matchId=' + finished.matchId + ' ticks=' + finished.ticks + ' result=' + finished.result + ' reason=' + finished.reason : 'timeout');

  const rankedObs = await rankedPromise;
  const demoObs = await demoPromise;

  // A ranked room keeps requeueing, so the newest history row is not
  // necessarily the game this spectator actually watched (that mismatch made
  // M14 compare zero frames and still look like a pass). Re-key the comparison
  // onto the match the frames belong to, and say so if it is not in history.
  const seenIds = new Set([...rankedObs.ticks.values()].map((t) => t.matchId).filter(Boolean));
  if (finished && seenIds.size && !seenIds.has(finished.matchId)) {
    const mine2 = await call('get_my_matches', { token: reg.token, limit: 8 });
    const alt = (mine2?.matches || []).find((m) => seenIds.has(m.matchId));
    if (alt) finished = alt;
  }
  report.evidence.spectate = {
    demoRoomTicks: demoObs.ticks.size,
    demoHelloPresence: demoObs.hello?.presence || null,
    rankedRoomTicks: rankedObs.ticks.size,
  };
  check('M10 WebSocket 观战收到服务端实拍 tick（非前端造数）',
    demoObs.ticks.size > 20 && Boolean(demoObs.hello),
    'demoTicks=' + demoObs.ticks.size + ' rankedTicks=' + rankedObs.ticks.size);

  // demo 房间数据体检：内置策略互打，但数字必须由内核算出
  const demoActions = {};
  let demoHpChanged = false;
  let demoFirst = null;
  let demoLast = null;
  for (const [, t] of demoObs.ticks) {
    if (t.actions) {
      demoActions[t.actions.a] = (demoActions[t.actions.a] || 0) + 1;
      demoActions[t.actions.b] = (demoActions[t.actions.b] || 0) + 1;
    }
    const f = t.frames?.[t.frames.length - 1];
    if (f) {
      if (!demoFirst) demoFirst = { hpA: f.a.hp, hpB: f.b.hp };
      demoLast = { hpA: f.a.hp, hpB: f.b.hp };
      if (f.a.hp !== demoFirst.hpA || f.b.hp !== demoFirst.hpB) demoHpChanged = true;
    }
  }
  const demoSkills = ['dp', 'fireball', 'throw', 'dash', 'special', 'ex', 'super']
    .reduce((n, k) => n + (demoActions[k] || 0), 0);
  report.evidence.demoRoom = { actions: demoActions, firstHp: demoFirst, lastHp: demoLast, hpChanged: demoHpChanged, skillActions: demoSkills };
  check('M11 默认观战页血量真实变化、有技能动作（内置策略，非外部 AI）',
    demoHpChanged && demoSkills > 0,
    'hp ' + JSON.stringify(demoFirst) + ' -> ' + JSON.stringify(demoLast) + ' skillActions=' + demoSkills);

  if (finished) {
    const result = await call('get_match_result', { matchId: finished.matchId });
    const replayResp = await call('get_replay', { matchId: finished.matchId });
    const replay = parseReplay(replayResp?.jsonl || '', finished.matchId);
    const mismatch = replayMatch(replay);
    const rendered = renderReplay(replay);
    const curve = hpCurve(rendered);
    const counts = actionStats(replay);
    const skills = Object.fromEntries(Object.entries(counts).filter(([k]) => ['dp', 'fireball', 'throw', 'dash', 'special', 'ex', 'super'].includes(k)));
    const totalEvents = rendered.reduce((n, t) => n + (t.events?.length || 0), 0);
    report.evidence.match = {
      matchId: finished.matchId,
      result: finished.result,
      reason: finished.reason,
      winner: result?.winner,
      hpA: result?.hpA,
      hpB: result?.hpB,
      ticks: replay.ticks.length,
      seed: replay.seed,
      stateHashMismatches: mismatch.mismatches?.length ?? mismatch.length ?? 0,
      actionCounts: counts,
      skillActions: skills,
      events: totalEvents,
      hpStart: curve[0],
      hpEnd: curve[curve.length - 1],
      ratingDelta: finished.ratingDelta,
    };
    check('M12 回放状态哈希链逐拍一致（确定性内核，非随机数）',
      (mismatch.mismatches?.length ?? mismatch.length ?? 0) === 0 && replay.ticks.length > 20,
      'ticks=' + replay.ticks.length + ' mismatches=' + (mismatch.mismatches?.length ?? mismatch.length ?? 0) + ' seed=' + replay.seed + ' events=' + totalEvents);
    check('M13 回放里出现技能 / 血量下降 / 明确胜负',
      Object.keys(skills).length >= 1 && curve[0].hpA + curve[0].hpB > curve[curve.length - 1].hpA + curve[curve.length - 1].hpB
      && ['a', 'b', 'draw'].includes(result?.winner),
      'skills=' + JSON.stringify(skills) + ' hpSum ' + (curve[0].hpA + curve[0].hpB) + '->' + (curve.at(-1).hpA + curve.at(-1).hpB) + ' winner=' + result?.winner);

    // 页面 WS 实拍帧 vs 回放离线重算帧，逐拍 JSON 比对
    const renderedByTick = new Map(rendered.map((t) => [t.tick, t]));
    let compared = 0;
    let identical = 0;
    let firstDiff = null;
    for (const [tick, live] of rankedObs.ticks) {
      const re = renderedByTick.get(tick);
      if (!re || live.matchId !== finished.matchId) continue;
      compared += 1;
      if (JSON.stringify(live.frames) === JSON.stringify(re.frames)) identical += 1;
      else if (!firstDiff) firstDiff = tick;
    }
    report.evidence.frameParity = { compared, identical, firstDiff };
    check('M14 观战页 WS 帧 == 回放离线重算帧（页面数字可复现）',
      compared > 10 && identical === compared,
      'compared=' + compared + ' identical=' + identical + (firstDiff !== null ? ' firstDiffTick=' + firstDiff : ''));

    const board = await call('get_leaderboard', { limit: 10 });
    const stats = await call('get_agent_stats', { agentId: reg.agentId });
    report.evidence.ranking = {
      leaderboardTop: (board?.leaders || board?.rows || []).slice(0, 3),
      stats,
    };
    // Two truths, and only one of them may hold - whichever the match actually
    // was. A lone registrant gets an official baseline as a sparring partner:
    // that is a real, replayable game that must NOT move the ladder. Asserting
    // matches>=1 unconditionally was the old (wrong) expectation and would only
    // pass by putting exhibition results onto the board.
    const rankedGame = finished?.ranked === true;
    const classified = finished && typeof finished.ranked === 'boolean'
      && typeof finished.practice === 'boolean' && Boolean(finished.pairing);
    const okLadder = rankedGame
      ? Number(stats?.matches) >= 1 && Number(stats?.rating) !== 1500
      : Number(stats?.matches) === 0 && Number(stats?.rating) === 1500
        && Number(stats?.practiceMatches) >= 1 && finished.practice === true;
    report.evidence.ranking.classification = {
      ranked: finished?.ranked, practice: finished?.practice,
      pairing: finished?.pairing, opponentOfficial: finished?.opponentOfficial,
    };
    check('M15 战绩与榜单口径一致（排位局计分；官方陪练局真实但不计榜）',
      classified && okLadder,
      (rankedGame ? '排位' : '不计榜(' + (finished?.pairing || '?') + ')')
      + ' matches=' + stats?.matches + ' practice=' + stats?.practiceMatches
      + ' rating=' + stats?.rating + ' delta=' + finished?.ratingDelta);
  }

  await client.close();
} catch (err) {
  check('M0 真实 MCP 客户端全程无异常', false, String(err?.stack || err).slice(0, 500));
  try { await client.close(); } catch { /* noop */ }
} finally {
  report.summary = {
    total: report.checks.length,
    passed: report.checks.length - failed,
    failed,
    connected,
  };
  // This report is committed as evidence, so it must never carry a live
  // credential: an MCP key is a full control plane for one player's agent, and
  // an agent token authorises realtime control. Scrub on write, not on trust.
  const SECRET = /((?:mcp_|ag_|usr_)[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g;
  const redacted = JSON.parse(JSON.stringify(report).replace(SECRET, '$1…'));
  redacted.redaction = 'MCP keys and agent tokens are truncated to their first 6 payload characters.';
  fs.writeFileSync(REPORT_PATH, JSON.stringify(redacted, null, 2), 'utf8');
  console.log('\n' + (failed ? 'FAILED ' : 'PASSED ') + (report.checks.length - failed) + '/' + report.checks.length
    + '  |  报告: docs/mcp-client-probe.json');
  process.exit(failed ? 1 : 0);
}
