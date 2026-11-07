// Hosted strategy track - one command, no AI client required.
// Runs the full MCP-only loop against a RUNNING league server:
//   validate -> simulate -> register -> submit -> join_queue -> wait for a real match -> report.
//
//   npm start                 # in another terminal
//   npm run hosted-demo       # here
//
// Override the target with AFL_BASE=http://host:port (or PORT=9000).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, listTools, callTool } from '../sdk/agent-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.AFL_BASE || 'http://127.0.0.1:' + (process.env.PORT || '8787');
const STRATEGY_FILE = path.join(ROOT, 'examples', 'hosted-agent', 'strategy.json');
const WAIT_LIMIT = 180; // seconds; a full match is 600 ticks x 100ms = 60s on default settings
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function line(label, value) {
  console.log('  ' + label.padEnd(22) + String(value));
}

function fail(err) {
  console.error('\n[hosted-demo] 失败：' + err.message);
  if (/fetch failed|ECONNREFUSED/i.test(err.message)) {
    console.error('  服务没在 ' + BASE + ' 上。先在另一个终端跑 `npm start`。');
  }
  process.exitCode = 1;
}

async function main() {
  const strategy = JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8'));
  console.log('\nAgent Fighting League · 托管策略赛道一键验证');
  console.log('目标服务  ' + BASE);
  console.log('策略文件  ' + path.relative(ROOT, STRATEGY_FILE) + '（' + strategy.name + '，' + strategy.rules.length + ' 条规则）\n');

  const init = await initialize(BASE);
  line('MCP 协议', init.protocolVersion + ' / ' + init.serverInfo.name + ' v' + init.serverInfo.version);
  const tools = (await listTools(BASE)).length;
  line('可用工具', tools + ' 个');

  // 1. Validate without saving: catches bad actions / field paths / comparators early.
  const validation = await callTool(BASE, 'validate_strategy', { strategy });
  line('校验', validation.valid ? '通过（' + validation.strategy.rules.length + ' 条规则，hash ' + validation.strategyHash.slice(0, 12) + '）' : '未通过');

  // 2. Offline simulation against real deterministic kernel - no ELO impact.
  const sim = await callTool(BASE, 'simulate_strategy', { strategy, opponents: ['brawler', 'zoner'], seeds: [101, 202] });
  line('离线模拟', sim.games + ' 局，胜率 ' + sim.overallWinRate + '%' + (sim.rows?.length ? '，' + sim.rows.length + ' 个内置基线' : ''));

  // 3. Register, submit, queue. source=hosted tells the league upfront we need no WebSocket.
  const reg = await callTool(BASE, 'register_agent', { name: 'hosted-demo', kind: 'rule', source: 'hosted' });
  line('注册', reg.agentId);
  const sub = await callTool(BASE, 'submit_strategy', { token: reg.token, strategy, autoRequeue: false });
  line('托管策略', 'source=' + sub.source + ' version=' + sub.versionHash);
  const queued = await callTool(BASE, 'join_queue', { token: reg.token, mode: 'ranked' });
  line('入队', queued.mode + (queued.realtimePath ? ' / ' + queued.realtimePath : ' / 无需 WebSocket'));

  // 4. Wait for a REAL ranked match to finish. No fake result, no shortcut.
  console.log('\n  等待真实对局结束（默认节拍约 60 秒，最多等 ' + WAIT_LIMIT + ' 秒）...');
  const started = Date.now();
  let mine = { matches: [] };
  let lastReport = 0;
  while (Date.now() - started < WAIT_LIMIT * 1000) {
    mine = await callTool(BASE, 'get_my_matches', { token: reg.token });
    if (mine.matches.length) break;
    const elapsed = Math.floor((Date.now() - started) / 1000);
    if (elapsed - lastReport >= 15) {
      lastReport = elapsed;
      const rooms = await callTool(BASE, 'list_rooms');
      const live = (rooms.rooms || []).filter((r) => r.status === 'running').map((r) => r.roomId + ':t' + (r.tick ?? '?')).join(', ');
      console.log('  ...已等 ' + elapsed + 's，进行中房间：' + (live || '无'));
    }
    await delay(1000);
  }

  const match = mine.matches[0];
  if (!match) {
    console.error('\n[hosted-demo] 等待超时：没有产生对局。检查服务日志或 `list_rooms`。');
    process.exitCode = 1;
    return;
  }

  await callTool(BASE, 'get_match_result', { matchId: match.matchId });
  const board = await callTool(BASE, 'get_leaderboard');
  const rank = (board.rows || []).findIndex((r) => r.id === reg.agentId) + 1;

  console.log('\n  本局结果');
  line('matchId', match.matchId);
  line('房间 / 模式', match.roomId + ' / ' + (match.ranked ? 'ranked' : 'scrim'));
  line('对手', match.opponent);
  line('胜负', match.result === 'win' ? '胜' : match.result === 'loss' ? '负' : '平');
  line('结束原因 / 拍数', (match.reason || '-') + ' / ' + match.ticks);
  line('积分变化', match.ratingDelta);
  line('策略版本', sub.versionHash);
  line('榜单名次', rank ? '#' + rank + ' / ' + board.rows.length : '暂无');
  console.log('\n  下一步：改 examples/hosted-agent/strategy.json 里的规则，重跑本命令对比胜率。');
  console.log('  复盘：get_replay("' + match.matchId + '") 或 npm run sim -- ' + match.matchId + '\n');
}

main().catch(fail);
