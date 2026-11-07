#!/usr/bin/env node
// ============================================================================
// 一键上场脚本：注册 → 声明策略版本 → 入队 → 连实时通道 → 打完一局 → 打印结果
// 你通常不用改这个文件，改 strategy.mjs / strategy.config.json 就够了。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  initialize, registerAgent, updateStrategy, joinQueue, getAgentStats, AgentClient,
} from './agent-client.mjs';
import { strategy } from './strategy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const BASE = (arg('base', process.env.AFL_BASE || 'http://localhost:8787')).replace(/\/+$/, '');
const WS = arg('ws', BASE.replace(/^http/, 'ws') + '/ws/agent');
const NAME = arg('name', 'Starter Agent');
const NOTE = arg('note', 'starter strategy v1');
const TOKEN_FILE = path.join(HERE, '.afl-token');

function strategyHash() {
  const h = crypto.createHash('sha256');
  for (const f of ['strategy.mjs', 'strategy.config.json']) {
    h.update(f);
    h.update(fs.readFileSync(path.join(HERE, f)));
  }
  return h.digest('hex');
}

async function main() {
  console.log('联赛地址  ' + BASE);
  console.log('实时通道  ' + WS);
  console.log('策略指纹  ' + strategyHash().slice(0, 16) + '…  (strategy.mjs + strategy.config.json 的 sha256)');
  console.log('');

  await initialize(BASE);
  let token = arg('token', process.env.AFL_TOKEN || (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : ''));
  let agentId = null;

  if (!token) {
    const reg = await registerAgent(BASE, { name: NAME, kind: 'rule' });
    token = reg.token;
    agentId = reg.agentId;
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
    console.log('已注册    ' + reg.agentId + '  · token 已保存到 .afl-token（别提交到公开仓库）');
  } else {
    console.log('复用凭证  ' + token.slice(0, 10) + '…  （想换身份：删掉 .afl-token 或传 --token）');
  }

  try {
    const ver = await updateStrategy(BASE, {
      token, note: NOTE, strategyHash: strategyHash(), defaultAction: 'block',
    });
    console.log('策略版本  ' + ver.versionHash + '  · 已锁定到本局回放');
  } catch (e) {
    // 正在打比赛时服务器会拒绝改版本，这不是错误：用当前版本继续上场。
    console.log('策略版本  沿用当前版本（' + e.message + '）');
  }

  await joinQueue(BASE, token);
  console.log('已入队    等待匹配。当前若正在打演示局，最多需要等它结束（约 60 秒）。\n');

  let ticks = 0;
  const client = new AgentClient({
    url: WS,
    token,
    policy: strategy,
    defaultAction: 'block',
    onLog: (m) => console.log('[league] ' + m),
    onMatchStart: (m) => console.log(`[league] 开局 ${m.matchId} · 你在 ${m.side} 方 · 对手 ${m.opponent} · 每拍 ${m.tickMs}ms`),
    onTick: ({ tick, action, observation }) => {
      ticks += 1;
      if (tick % 50 === 0) {
        console.log(`  tick ${String(tick).padStart(3)} · 距离 ${String(observation.derived.distanceX).padStart(3)} · 威胁 ${observation.derived.threat.padEnd(10)} · 我方 HP ${observation.self.hp} → ${action}`);
      }
    },
  });

  try {
    await client.connect();
  } catch (e) {
    console.error('\n连接失败：' + e.message);
    console.error('排查：服务是否在跑？token 是否已失效（删 .afl-token 重试）？地址是否用了 ws:// 而不是 http://？');
    process.exit(1);
  }
  console.log('[league] 已连接，等待开赛…\n');

  let end;
  try {
    end = await client.waitForMatchEnd();
  } catch (e) {
    console.error('\n等待对局结束超时：' + e.message);
    console.error('如果服务刚重启或队列很长，可再加 --base 指向一个 AFL_TICK_MS=20 的加速实例。');
    process.exit(1);
  }

  const r = end.result;
  console.log('\n────────── 本局结果 ──────────');
  console.log('对局       ' + end.matchId);
  console.log('胜者       ' + (r.winner === 'draw' ? '平局' : r.winner) + ' · ' + (r.reason || ''));
  console.log('血量       A ' + r.hpA + ' : ' + r.hpB + ' B   ·   ' + r.ticks + ' 拍');
  console.log('积分变化   ' + end.ratingDelta);
  console.log('我的决策   ' + ticks + ' 拍 · 被拒 ' + client.rejects + ' 次');

  if (agentId) {
    try {
      const st = await getAgentStats(BASE, agentId);
      console.log('累计战绩   ' + st.wins + ' 胜 / ' + st.losses + ' 负 · 评分 ' + st.rating + ' · 版本 ' + st.versionHash);
    } catch { /* stats are optional */ }
  }
  console.log('\n下一步：打开 ' + BASE + '/?view=replay 看逐拍决策与 observation；');
  console.log('       改 strategy.config.json 的阈值 → npm test → npm start，对比胜率。');
  client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n运行失败：' + (e.stack || e.message));
  console.error('最常见原因：联赛服务没启动。先在另一个终端跑 npm start。');
  process.exit(1);
});
