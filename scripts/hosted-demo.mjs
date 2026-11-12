// Hosted strategy track - one command, no AI client required.
// Runs the full MCP-only loop against a RUNNING league server:
//   validate -> simulate -> register -> set_team -> submit -> join_queue(team) -> wait for a real match -> report.
//
//   npm start                 # in another terminal
//   npm run hosted-demo       # here
//
// Override the target with AFL_BASE=http://host:port (or PORT=9000).
//
// The control plane is player-bound, so this needs YOUR service key:
//   1. sign in on the site (or POST /api/auth/sign-up/email)
//   2. GET /api/me/mcp              -> your single MCP URL
//   3. AFL_MCP_URL=http://host:port/mcp/<key> npm run hosted-demo
// It deliberately does not create an account for you in the background.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, listTools, callTool } from '../sdk/agent-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.AFL_BASE || 'http://127.0.0.1:' + (process.env.PORT || '8787')).replace(/\/+$/, '');
const MCP = (process.env.AFL_MCP_URL || '').replace(/\/+$/, '');
const STRATEGY_FILE = path.join(ROOT, 'examples', 'hosted-agent', 'strategy.json');
const WAIT_LIMIT = 420; // seconds; a team match is up to 5 rounds x 60s + 4 x 8s intermissions
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// One place that turns a match record into the kind of game it actually was.
function matchKind(m) {
  if (m.ranked) return '排位 ranked';
  if (m.practice) return m.pairing === 'sparring' ? '陪练 sparring' : '陪练 ' + (m.pairing || 'practice');
  if (m.pairing === 'showcase') return '演示 showcase';
  if (m.pairing === 'code') return '私房 scrim';
  return '非计榜' + (m.pairing ? ' / ' + m.pairing : '');
}

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

  if (!/\/mcp(\/|$)/.test(MCP)) {
    // A player key is required. Say exactly how to get one, and where to put it.
    console.error([
      '需要你的玩家 MCP 服务地址（控制面绑定玩家，不存在匿名入口）。',
      '  1. 在网站注册/登录（或 POST ' + BASE + '/api/auth/sign-up/email）',
      '  2. GET ' + BASE + '/api/me/mcp，读出 mcp.url',
      "  3. AFL_MCP_URL=" + BASE + "/mcp/<key> npm run hosted-demo",
    ].join('\n'));
    process.exitCode = 1;
    return;
  }

  const init = await initialize(MCP);
  line('MCP 协议', init.protocolVersion + ' / ' + init.serverInfo.name + ' v' + init.serverInfo.version);
  const tools = (await listTools(MCP)).length;
  line('可用工具', tools + ' 个');

  // 1. Validate without saving: catches bad actions / field paths / comparators early.
  const validation = await callTool(MCP, 'validate_strategy', { strategy });
  line('校验', validation.valid ? '通过（' + validation.strategy.rules.length + ' 条规则，hash ' + validation.strategyHash.slice(0, 12) + '）' : '未通过');

  // 2. Offline simulation against real deterministic kernel - no ELO impact.
  const sim = await callTool(MCP, 'simulate_strategy', { strategy, opponents: ['brawler', 'zoner'], seeds: [101, 202] });
  line('离线模拟', sim.games + ' 局，胜率 ' + sim.overallWinRate + '%' + (sim.rows?.length ? '，' + sim.rows.length + ' 个内置基线' : ''));

  // 3. Register, build a roster, submit, enter the team ladder. source=hosted needs no WebSocket.
  const reg = await callTool(MCP, 'register_agent', { name: 'hosted-demo', kind: 'rule', source: 'hosted' });
  line('注册', reg.agentId);
  const roster = await callTool(MCP, 'set_team', { token: reg.token, team: ['ember', 'tide', 'basalt'] });
  line('自建队伍', roster.team.join(' → '));
  const sub = await callTool(MCP, 'submit_strategy', { token: reg.token, strategy, autoRequeue: false });
  line('托管策略', 'source=' + sub.source + ' version=' + sub.versionHash);
  const queued = await callTool(MCP, 'join_queue', { token: reg.token, mode: 'ranked', format: 'team' });
  line('报名', 'ranked / ' + (queued.format || 'team') + (queued.realtimePath ? ' / ' + queued.realtimePath : ' / 无需 WebSocket'));

  // 4. Wait for a REAL ranked team match to finish. No fake result, no shortcut.
  console.log('\n  等待真实组队对局结束（最多 5 回合，默认节拍最长约 5 分钟，最多等 ' + WAIT_LIMIT + ' 秒）...');
  const started = Date.now();
  let mine = { matches: [] };
  let lastReport = 0;
  while (Date.now() - started < WAIT_LIMIT * 1000) {
    // Must be your own service: on a bound endpoint the agent is whoever the
    // key resolves to, and BASE (anonymous) would be refused outright.
    mine = await callTool(MCP, 'get_my_matches');
    if (mine.matches.length) break;
    const elapsed = Math.floor((Date.now() - started) / 1000);
    if (elapsed - lastReport >= 15) {
      lastReport = elapsed;
      const rooms = await callTool(MCP, 'list_rooms');
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

  await callTool(MCP, 'get_match_result', { matchId: match.matchId });
  const board = await callTool(MCP, 'get_leaderboard');
  const rank = (board.rows || []).findIndex((r) => r.id === reg.agentId) + 1;

  console.log('\n  本局结果');
  line('matchId', match.matchId);
  // Read the fields the league publishes instead of guessing from one boolean:
  // ranked=false alone cannot tell a sparring match apart from a private scrim,
  // and labelling sparring as "scrim" would misreport what the player played.
  line('房间 / 性质', match.roomId + ' / ' + matchKind(match) + ' / ' + (match.format || 'single'));
  line('对手', match.opponent + (match.opponentOfficial ? '（官方基线，不计榜）' : ''));
  line('胜负', match.result === 'win' ? '胜' : match.result === 'loss' ? '负' : '平');
  line('结束原因 / 拍数', (match.reason || '-') + ' / ' + match.ticks);
  line('积分变化', match.ratingDelta);
  line('策略版本', sub.versionHash);
  line('榜单名次', rank ? '#' + rank + ' / ' + board.rows.length : '暂无');
  console.log('\n  下一步：改 examples/hosted-agent/strategy.json 里的规则，重跑本命令对比胜率。');
  console.log('  复盘：get_replay("' + match.matchId + '") 或 npm run sim -- ' + match.matchId + '\n');
}

main().catch(fail);
