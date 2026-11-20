import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { attempt, withFinally, parseOr } from '../lib/no-throw.mjs';
import { fetchCaptcha } from '../lib/captcha-auth.mjs';
import { League, isLadderCompetitor, isOfficialBaseline } from '../../src/league.js';
import { strategyTemplate } from '../../src/strategy-dsl.js';
import { CONFIG } from '../../src/rules.js';
import { MAX_MODEL_CALLS_PER_MATCH as MAX_MODEL_CALLS_FOR_TEST } from '../../src/costs.js';


export async function runRegistrants(ctx) {
  const { check, BASE, get, IDLE_SANDBOX, delay } = ctx;
  const ADMIN = {
    username: 'admin',
    password: 'admin-test-pass-123',
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
    const data = await parseOr(text, text);
    return { res, data, cookie: cookieOf(res) };
  }
  const login = async (c) => {
    const challenge = await fetchCaptcha(BASE);
    return req('/api/login', { method: 'POST', body: { ...c, captchaAnswer: challenge.answer }, cookie: challenge.cookie });
  };
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

  // First-run setup creates the admin; on a re-used test database it is
  // locked (409) and the fixed admin logs in instead.
  const setup = await req('/api/setup', { method: 'POST', body: ADMIN });
  let adminCookie;
  if (setup.res.status === 200) adminCookie = setup.cookie;
  else {
    assert.equal(setup.res.status, 409, 'setup should be locked on a re-used database: ' + JSON.stringify(setup.data));
    const admin = await login(ADMIN);
    assert.equal(admin.res.status, 200, 'admin login against the test database');
    adminCookie = admin.cookie;
  }

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
  await attempt(() => ws.close()); // already closed is fine
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
    const { League: LeagueCls } = await import('../../src/league.js');
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
