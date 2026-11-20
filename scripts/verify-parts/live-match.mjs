import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { attempt } from '../lib/no-throw.mjs';
import { callTool, templatePolicy, AgentClient, registerAgent } from '../../sdk/agent-client.mjs';
import { simulateReplay } from '../../src/simulator.js';
import { onboardPlayer } from '../lib/harness-auth.mjs';


/** C11–C22: replay parity, docs, strategies, rooms and the data chain. */
export async function runMatchChecks(ctx) {
  const { ROOT, BASE, WS, AUTH_BASE, check, delay, rpc, openSpectator, session } = ctx;
  const { reg, matchId } = session;
    const matches = await (await fetch(BASE + '/api/matches')).json();
    const record = matches.matches.find((m) => m.matchId === matchId);
    const replayTool = await callTool(session.mcp, 'get_replay', { matchId });
    const sim = await simulateReplay(replayTool.jsonl, templatePolicy);
    check('C11 MCP 下载回放 + 本地模拟器可逐拍重放策略', sim.ticks > 10, 'ticks=' + sim.ticks + ' agreementWithTemplate=' + sim.agreement + '%');

    const board = await callTool(session.mcp, 'get_leaderboard', {});
    const me = board.rows.find((r) => r.id === reg.agentId);
    // This agent fought alone, so its opponent was an official baseline. Under
    // the ladder rules that is a real, replayable match that buys no win and no
    // rating - so the board must NOT have moved. Asserting a rating change here
    // would be asserting the bug this project removed.
    const alonePractice = record && record.ranked === false && record.practice === true;
    check('C12 单人报名打到官方基线是真实陪练局：有战果记录但不计榜，榜单数字不动',
      alonePractice && (!me || (me.matches === 0 && me.wins === 0 && me.rating === 1500))
      && board.scope === 'registered-players',
      'ranked=' + record.ranked + ' practice=' + record.practice + ' delta=' + record.ratingDeltaA
      + ' 我方行=' + (me ? me.matches + '局/' + me.rating : '不在榜') + ' scope=' + board.scope);

    // C13 - strategy version declaration: deterministic fingerprint, invalid hash rejected
    const sha = 'a'.repeat(64);
    const v1 = await callTool(session.mcp, 'update_strategy', { token: reg.token, note: 'verify', strategyHash: sha, defaultAction: 'block' });
    const v2 = await callTool(session.mcp, 'update_strategy', { token: reg.token, note: 'verify', strategyHash: sha, defaultAction: 'block' });
    const badRejected = !(await attempt(() => callTool(session.mcp, 'update_strategy', { token: reg.token, strategyHash: 'not-a-hash' }))).ok;
    check('C13 策略版本：同文件 hash 可复现、非法 hash 被拒', v1.versionHash === v2.versionHash && v1.strategyHash === sha && badRejected, 'versionHash=' + v1.versionHash);

    // C14 - onboarding docs / examples are actually served, path traversal blocked
    const docPaths = ['/guide.html', '/guide.css', '/docs/advanced.md', '/examples/starter/agent.mjs', '/examples/starter/SKILL.md', '/examples/starter/README.md', '/examples/llm-agent/agent.mjs', '/sdk/agent-client.mjs'];
    const codes = [];
    for (const p of docPaths) codes.push((await fetch(BASE + p)).status);
    const traversal = (await fetch(BASE + '/docs/%2e%2e/data/league.json')).status;
    check('C14 对接手册 / 示例包 / SDK 可访问，目录穿越被拦截', codes.every((c) => c === 200) && traversal !== 200, 'ok=' + codes.filter((c) => c === 200).length + '/' + codes.length + ' traversal=' + traversal);

    // C14b - removed legacy REST entries must STAY removed, and the docs must
    // not describe them as available. Both halves matter: the endpoints were
    // gone while two documents still called them "kept compatibility entries",
    // which is a promise the server cannot honour.
    {
      const legacy = ['/api/token', '/api/enter', '/api/team'];
      const legacyCodes = [];
      for (const route of legacy) {
        const r = await fetch(BASE + route, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', token: 'x', team: [] }),
        });
        legacyCodes.push(r.status);
      }
      const docFiles = ['docs/advanced.md', 'docs/player-accounts.md', 'README.md', 'skills/afl-league/SKILL.md'];
      const offenders = [];
      for (const rel of docFiles) {
        const file = path.join(ROOT, rel);
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!/\/api\/(token|enter|team)\b/.test(line)) return;
          // A mention is only allowed as a tombstone or a migration note.
          if (!/(已删除|不再|404|~~|迁移)/.test(line)) offenders.push(rel + ':' + (i + 1) + ' ' + line.trim().slice(0, 70));
        });
      }
      check('C14b 三个已删除的旧 REST 入口返回 404，且文档没有把它们写成可用能力',
        legacyCodes.every((c) => c === 404) && offenders.length === 0,
        'codes=' + legacyCodes.join(',') + ' 文档违规=' + offenders.length
        + (offenders.length ? ' -> ' + offenders.join(' | ') : ''));
    }

    // C14c - the ranked / practice / pairing matrix the onboarding doc promises is
    // what the server actually records. `pairing` is the only field that tells a
    // player WHY a win did not move their rating, so a documented value the
    // matchmaker never produces - or a row that contradicts the table - is worse
    // than no explanation. Checks live records, not just the docs.
    {
      const documented = { rating: [true, false], sparring: [false, true], code: [false, false], showcase: [false, false] };
      const seen = new Map();
      const contradictions = [];
      const all = await (await fetch(BASE + '/api/matches?limit=200')).json();
      for (const m of (all.matches || [])) {
        const key = String(m.pairing);
        seen.set(key, (seen.get(key) || 0) + 1);
        const want = documented[key];
        if (!want) { contradictions.push('pairing=' + key + ' 文档未定义'); continue; }
        if (m.ranked !== want[0] || Boolean(m.practice) !== want[1]) {
          contradictions.push(key + ' ranked=' + m.ranked + ' practice=' + m.practice);
        }
        if (m.ranked && m.opponentOfficial) contradictions.push('计榜局出现了官方基线对手');
      }
      const missing = Object.keys(documented).filter((k) => !seen.has(k));
      const docTable = fs.readFileSync(path.join(ROOT, 'docs/advanced.md'), 'utf8');
      const docPairs = [...docTable.matchAll(/^\s*\| `(rating|sparring|code|showcase)` \| `(true|false)` \| `(true|false)` \|/gm)];
      const docWrong = docPairs.filter((x) => {
        const want = documented[x[1]];
        return !(x[2] === String(want[0]) && x[3] === String(want[1]));
      });
      check('C14c ranked/practice/pairing 口径与文档表格一致，且只出现文档声明的四种 pairing',
        contradictions.length === 0 && docPairs.length === 4 && docWrong.length === 0,
        'records=' + [...seen].map(([k, v]) => k + ':' + v).join(' ') + ' 矛盾=' + contradictions.length
        + (contradictions.length ? ' -> ' + contradictions.slice(0, 2).join(' | ') : '')
        + ' 表格行=' + docPairs.length + ' 表格错=' + docWrong.length + ' 未观测到=' + (missing.join(',') || '无'));
    }

    // C15 - the copyable starter package stays in sync with the official SDK and passes its offline tests
    const sdkA = fs.readFileSync(path.join(ROOT, 'sdk/agent-client.mjs'), 'utf8');
    const sdkB = fs.readFileSync(path.join(ROOT, 'examples/starter/agent-client.mjs'), 'utf8');
    const unit = spawnSync(process.execPath, ['examples/starter/strategy.test.mjs'], { cwd: ROOT, encoding: 'utf8' });
    check('C15 示例包 SDK 副本同步 + 离线策略单测通过', sdkA === sdkB && unit.status === 0, 'sdkMatch=' + (sdkA === sdkB) + ' testExit=' + unit.status);

    // C16 - an invalid token must fail fast instead of hanging forever
    const bad = new AgentClient({ url: WS + '/ws/agent', token: 'ag_invalid', policy: templatePolicy, onLog: () => {} });
    const t0 = Date.now();
    const badConnect = await attempt(() => bad.connect());
    const rejected = !badConnect.ok;
    const elapsed = Date.now() - t0;
    check('C16 无效 token 快速报错而非挂起', rejected && elapsed < 4000, 'elapsedMs=' + elapsed);

    // C17 - literally run the command from the onboarding manual and finish a real match
    const demo = spawn(process.execPath, ['examples/starter/agent.mjs', '--base', BASE, '--mcp', session.mcp, '--ws', WS + '/ws/agent', '--token', reg.token, '--name', 'Doc Starter'], {
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
    const resList = await rpc(session.mcp, 'resources/list');
    const promptList = await rpc(session.mcp, 'prompts/list');
    const skillRes = await rpc(session.mcp, 'resources/read', { uri: 'afl://skill' });
    const skillText = (skillRes.contents && skillRes.contents[0] && skillRes.contents[0].text) || '';
    const skillHttp = await (await fetch(BASE + '/SKILL.md')).text();
    const configs = await (await fetch(BASE + '/skills/afl-league/mcp-configs.json')).json();
    check('C18 MCP resources / prompts / SKILL.md / 多客户端配置可直接喂给现成 Agent',
      resList.resources.length >= 8 && promptList.prompts.length >= 3 && skillText.includes('托管') && skillHttp.includes('submit_strategy') && configs.clients.length >= 6,
      'resources=' + resList.resources.length + ' prompts=' + promptList.prompts.length + ' skillBytes=' + skillText.length + ' clients=' + configs.clients.length);

    // C19 - the hosted (MCP-only) track really fights a full match
    const tpl = await callTool(session.mcp, 'get_strategy_template');
    const validation = await callTool(session.mcp, 'validate_strategy', { strategy: tpl.template });
    const simResult = await callTool(session.mcp, 'simulate_strategy', { strategy: tpl.template, opponents: ['brawler', 'zoner'], seeds: [101, 202] });
    // C19 is a different competitor: a service is bound to one slot, so the
    // hosted track needs its own player.
    const hosted = await onboardPlayer(AUTH_BASE, 'Verify Hosted');
    const hreg = await registerAgent(hosted.endpoint, { name: 'Verify Hosted', source: 'hosted' });
    // These go to the hosted player's OWN service: on a bound endpoint args.token
    // is ignored, so calling through another player's URL would have silently
    // submitted and queued the wrong agent.
    const sub = await callTool(hosted.endpoint, 'submit_strategy', { strategy: tpl.template, autoRequeue: false });
    await callTool(hosted.endpoint, 'join_queue', { mode: 'ranked' });
    let mine = { matches: [] };
    for (let i = 0; i < 150; i += 1) {
      mine = await callTool(hosted.endpoint, 'get_my_matches', { token: hreg.token });
      if (mine.matches.length) break;
      await delay(200);
    }
    const hm = mine.matches[0];
    check('C19 托管策略：模拟→校验→提交→入队→真实打完一局并留下版本指纹',
      validation.valid && simResult.games === 4 && sub.source === 'hosted'
      && sub.versionHash === validation.strategyHash.slice(0, 12)
      && Boolean(hm && hm.matchId && hm.roomId && hm.ranked),
      'winRate=' + simResult.overallWinRate + '% version=' + sub.versionHash + ' match=' + (hm ? hm.matchId : 'none') + ' room=' + (hm ? hm.roomId : 'none'));

    // C20 - private scrim room by code, unranked, with distinct fighters.
    // A service is bound to exactly one agent slot, so a challenge needs two players.
    const scrimHost = await onboardPlayer(AUTH_BASE, 'Scrim Host');
    const scrimGuest = await onboardPlayer(AUTH_BASE, 'Scrim Guest');
    const sh = await registerAgent(scrimHost.endpoint, { name: 'Scrim Host', source: 'hosted', fighterId: 'ember' });
    const sg = await registerAgent(scrimGuest.endpoint, { name: 'Scrim Guest', source: 'hosted', fighterId: 'tide' });
    await callTool(scrimHost.endpoint, 'submit_strategy', { strategy: tpl.template, autoRequeue: false });
    await callTool(scrimGuest.endpoint, 'submit_strategy', { strategy: tpl.template, autoRequeue: false });
    const scrim = await callTool(scrimHost.endpoint, 'create_room', { fighterId: 'ember' });
    const joined = await callTool(scrimGuest.endpoint, 'join_room', { roomCode: scrim.code });
    let scrimRows = { matches: [] };
    for (let i = 0; i < 150; i += 1) {
      scrimRows = await callTool(scrimHost.endpoint, 'get_my_matches', {});
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
      const roomsNow = await callTool(session.mcp, 'list_rooms');
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
    const fightersRes = await callTool(session.mcp, 'list_fighters');
    const fighters = fightersRes.fighters;
    const fHttp = await (await fetch(BASE + '/api/fighters')).json();
    const board2 = await callTool(session.mcp, 'get_leaderboard', {});
    const badAction = !(await attempt(() => callTool(session.mcp, 'validate_strategy', { strategy: { name: 'x', defaultAction: 'block', rules: [{ action: 'NUKE' }] } }))).ok;
    const badPath = !(await attempt(() => callTool(session.mcp, 'validate_strategy', { strategy: { name: 'x', defaultAction: 'block', rules: [{ when: { 'self.constructor': 1 }, action: 'block' }] } }))).ok;
    const badComparator = !(await attempt(() => callTool(session.mcp, 'validate_strategy', { strategy: { name: 'x', defaultAction: 'block', rules: [{ when: { 'derived.threat': { evil: 1 } }, action: 'block' }] } }))).ok;
    const teams = fHttp.teams || [];
    const rosterOk = fighters.length === 16 && teams.length === 4
      && teams.every((t) => t.fighters.length === 4)
      && fighters.every((f) => f.team && f.teamName && f.teamColor)
      && fighters.every((f) => f.id && f.palette && f.gear && f.signature);
    check('C22 16 位原创角色 / 4 支队伍进入数据链路，DSL 拒绝非法动作 / 原型字段 / 未知比较器',
      rosterOk && Boolean(fHttp.fighters[0].build) && board2.rows.every((r) => r.fighterId) && badAction && badPath && badComparator && fightersRes.count === fighters.length,
      'fighters=' + fighters.length + ' count=' + fightersRes.count + ' teams=' + teams.length + ' build=' + Boolean(fHttp.fighters[0].build) + ' reject=' + [badAction, badPath, badComparator].join('/'));

}
