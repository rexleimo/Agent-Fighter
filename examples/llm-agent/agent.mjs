#!/usr/bin/env node
// ============================================================================
// 模型驱动策略示例（可选进阶）
//
// 关键事实：一拍只有 100ms。逐拍调 LLM 必然超时，超时会被内核记违规并自动
// 执行 defaultAction —— 那样你的 Agent 实际上一直在挨打。
//
// 所以这里用三段式：
//   1. 只在「关键局势」问模型（威胁变化 / 每 N 拍），其余拍走规则策略；
//   2. 模型调用 60ms 硬超时，失败立刻用规则策略兜底；
//   3. 如实上报 modelCalls，榜单会公开，别靠堆调用刷分。
//
// 没配 API key 也能跑：自动降级成纯规则策略，方便先验证链路。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initialize, registerAgent, updateStrategy, joinQueue, AgentClient,
} from '../starter/agent-client.mjs';
import { strategy as ruleStrategy, ACTIONS } from '../starter/strategy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const BASE = (arg('base', process.env.AFL_BASE || 'http://localhost:8787')).replace(/\/+$/, '');
const WS = arg('ws', BASE.replace(/^http/, 'ws') + '/ws/agent');
const LLM_BASE = (process.env.AFL_LLM_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
const LLM_KEY = process.env.AFL_LLM_KEY || '';
const LLM_MODEL = process.env.AFL_LLM_MODEL || 'gpt-4o-mini';
const ASK_EVERY = Number(process.env.AFL_ASK_EVERY || 10);
const LLM_TIMEOUT_MS = 60;
const TOKEN_FILE = path.join(HERE, '.afl-token');

const SYSTEM_PROMPT = `You are a fighting game AI. Reply with EXACTLY ONE action id, nothing else.
Allowed: idle, walk_f, walk_b, jump, crouch, lp, mp, hp, lk, mk, hk, dp, fireball, block, throw.
Rules: dp is an anti-air with 3 invulnerable frames but 24 recovery frames - only use it when the opponent is jumping in and in range. fireball is for long distance. Use derived.inRange before attacking. Block when projectileIncoming or in hitstun. Prefer hp at close range, mp at mid range.`;

let lastThreat = null;
let lastAdvice = null;
let calls = 0;
let fallbacks = 0;

function shouldAsk(obs) {
  if (!LLM_KEY) return false;
  if (obs.deadlineMs < 80) return false;
  if (obs.derived.threat !== lastThreat) return true;
  return obs.tick % ASK_EVERY === 0;
}

function compact(obs) {
  return {
    tick: obs.tick, hp: [obs.self.hp, obs.opponent.hp],
    distanceX: obs.derived.distanceX,
    frameAdvantage: obs.derived.frameAdvantage,
    threat: obs.derived.threat,
    inRange: obs.derived.inRange,
    projectileIncoming: obs.derived.projectileIncoming,
    self: { state: obs.self.state, moveId: obs.self.moveId, recovery: obs.self.recovery, hitstun: obs.self.hitstun, canCancel: obs.self.canCancel },
    opponent: { state: obs.opponent.state, moveId: obs.opponent.moveId, hitstun: obs.opponent.hitstun },
    history: obs.history.slice(-4),
  };
}

async function askModel(obs) {
  const res = await fetch(LLM_BASE + '/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_KEY },
    body: JSON.stringify({
      model: LLM_MODEL, temperature: 0.2, max_tokens: 8,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(compact(obs)) },
      ],
    }),
  });
  if (!res.ok) throw new Error('llm http ' + res.status);
  const data = await res.json();
  const text = String(data.choices?.[0]?.message?.content || '').trim().toLowerCase();
  if (!ACTIONS.includes(text)) throw new Error('llm returned invalid action: ' + text);
  return text;
}

async function policy(obs) {
  // 硬直期间连模型都不必问，输入本来就不生效。
  if (obs.self.hitstun > 0 || obs.self.blockstun > 0) return { action: 'block', modelCalls: 0 };
  const threatChanged = obs.derived.threat !== lastThreat;
  lastThreat = obs.derived.threat;
  if (shouldAsk(obs)) {
    try {
      lastAdvice = await askModel(obs);
      calls += 1;
      return { action: lastAdvice, modelCalls: 1 };
    } catch {
      fallbacks += 1; // 超时 / 报错 / 返回非法动作，一律降级
    }
  }
  // 模型刚给过建议且局势没变，可以复用一拍，避免每拍都问。
  if (!threatChanged && lastAdvice && obs.derived.distanceX < 120) {
    return { action: lastAdvice, modelCalls: 0 };
  }
  return { action: ruleStrategy(obs), modelCalls: 0 };
}

async function main() {
  if (!LLM_KEY) {
    console.log('[llm] 未设置 AFL_LLM_KEY → 降级为纯规则策略，链路照样可以完整跑通。');
    console.log('[llm] 想启用模型：AFL_LLM_KEY=sk-xxx AFL_LLM_BASE=https://... AFL_LLM_MODEL=xxx node agent.mjs\n');
  } else {
    console.log('[llm] 模型 ' + LLM_MODEL + ' @ ' + LLM_BASE + ' · 超时 ' + LLM_TIMEOUT_MS + 'ms · 每 ' + ASK_EVERY + ' 拍或局势变化时询问\n');
  }

  await initialize(BASE);
  let token = arg('token', process.env.AFL_TOKEN || (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : ''));
  if (!token) {
    const reg = await registerAgent(BASE, { name: arg('name', 'LLM Agent'), kind: LLM_KEY ? 'hybrid' : 'rule' });
    token = reg.token;
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
    console.log('[llm] 已注册 ' + reg.agentId);
  }
  try {
    await updateStrategy(BASE, { token, note: 'llm hybrid: ask on key states, rule fallback', defaultAction: 'block' });
  } catch (e) { console.log('[llm] 版本沿用当前值（' + e.message + '）'); }
  await joinQueue(BASE, token);

  const client = new AgentClient({
    url: WS, token, policy, defaultAction: 'block',
    onLog: (m) => console.log('[league] ' + m),
    onMatchStart: (m) => console.log('[league] 开局 ' + m.matchId + ' · ' + m.side + ' 方'),
  });
  try { await client.connect(); } catch (e) { console.error('连接失败：' + e.message); process.exit(1); }
  const end = await client.waitForMatchEnd();
  console.log('\n结果 ' + end.result.winner + ' · ' + end.result.ticks + ' 拍 · 积分 ' + end.ratingDelta);
  console.log('模型调用 ' + calls + ' 次 · 超时/降级 ' + fallbacks + ' 次 · 决策 ' + client.actCount + ' 拍');
  client.close();
  process.exit(0);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
