/**
 * Curated document directory for the skills.sh-style library (/library).
 *
 * The allowlist IS the security boundary: only these public, agent-facing
 * files are indexed, and their content is served by the existing read-only
 * static subtrees (/docs/, /skills/, /examples/) which already reject path
 * traversal. Nothing here reads tokens, replays or player data.
 *
 * Stats are cached per file and invalidated by mtime, so editing a doc shows
 * up on the next request without a server restart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DOC_ENTRIES = [
  {
    path: 'skills/afl-league/SKILL.md', title: 'AFL 联赛操作技能', category: 'skill', audience: 'Agent',
    description: '给 AI Agent 读的完整操作说明：身份心智模型、建队、策略 DSL、匹配赛制、实时赛道与排错。',
    keywords: 'skill mcp 接入 建队 策略 匹配 排错 托管',
  },
  {
    path: 'docs/agent-onboarding.md', title: '完整对接手册', category: 'doc', audience: 'Agent + 开发者',
    description: '权威全文：两条通道、observation 字段字典、action 帧数据、策略写法、版本回放与部署口径。',
    keywords: 'observation 字段 报文 帧数据 部署 websocket 字典',
  },
  {
    path: 'examples/starter/SKILL.md', title: '实时赛道策略契约', category: 'skill', audience: 'Agent',
    description: 'starter 策略包的 SKILL：observation → action 决策函数的契约、版本指纹与边界。',
    keywords: 'starter 实时 websocket 策略 契约 指纹',
  },
  {
    path: 'examples/starter/README.md', title: '实时赛道示例包', category: 'example', audience: '开发者',
    description: '自包含策略包：注册、入队、实时对战、结算全写好，只需改 strategy.mjs 与阈值。',
    keywords: 'starter 示例 进程 npm 实时',
  },
  {
    path: 'examples/hosted-agent/README.md', title: '托管赛道示例', category: 'example', audience: 'Agent + 开发者',
    description: 'MCP-only 托管策略赛道：建队、提交 JSON 策略、报名组队排位的完整 curl 流程。',
    keywords: '托管 hosted json 策略 curl 报名',
  },
  {
    path: 'examples/hosted-agent/strategy.json', title: '示例策略 JSON', category: 'config', audience: 'Agent',
    description: '可直接提交的声明式策略：对空优先、远距发波的有序规则表。',
    keywords: '策略 json 规则 DSL 示例 提交',
  },
  {
    path: 'examples/llm-agent/README.md', title: '大模型 Agent 示例', category: 'example', audience: '开发者',
    description: '关键局势问模型 + 60ms 硬超时 + 规则兜底的实时赛道接法。',
    keywords: 'llm 模型 超时 兜底 预算',
  },
  {
    path: 'docs/player-accounts.md', title: '玩家账号与 MCP 服务', category: 'doc', audience: '人类 + Agent',
    description: '玩家注册、MCP 服务链接生成、身份绑定与管理口径。',
    keywords: '账号 注册 mcp key 玩家 登录',
  },
  {
    path: 'docs/web-architecture.md', title: '前端架构', category: 'doc', audience: '开发者',
    description: 'React 前端与观战渲染管线的结构说明。',
    keywords: '前端 react 渲染 架构 观战',
  },
  {
    path: 'docs/asset-library.md', title: '素材库与资产管线', category: 'doc', audience: '开发者',
    description: 'sprite / plate 两条资产管线、校验门禁与版权口径。',
    keywords: '素材 sprite 资产 管线 版权 校验',
  },
  {
    path: 'docs/agent-fighting-league-plan.md', title: '联赛总体规划', category: 'doc', audience: '开发者',
    description: '联赛的设计蓝图：赛制、内核、赛道与里程碑。',
    keywords: '规划 赛制 设计 蓝图 里程碑',
  },
  {
    path: 'skills/afl-league/mcp-configs.json', title: 'MCP 客户端配置集', category: 'config', audience: '人类',
    description: '8 类现成客户端的 MCP 配置模板与存放位置。',
    keywords: 'mcp 配置 claude cursor opencode 客户端 模板',
  },
  {
    path: 'skills/afl-league/README.md', title: '技能包说明', category: 'skill', audience: '开发者',
    description: 'afl-league 技能包的结构与分发说明。',
    keywords: '技能包 skill 分发 结构',
  },
];

const statCache = new Map();

function fileStats(rel) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  const hit = statCache.get(rel);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;
  const text = fs.readFileSync(abs, 'utf8');
  const entry = {
    mtimeMs: st.mtimeMs,
    bytes: st.size,
    lines: text.length ? text.split('\n').length : 0,
  };
  statCache.set(rel, entry);
  return entry;
}

/** Manifest for GET /api/docs. Throws only if an allowlisted file is missing. */
export function docsManifest() {
  const docs = DOC_ENTRIES.map((entry) => {
    const stats = fileStats(entry.path);
    return { ...entry, url: '/' + entry.path, lines: stats.lines, bytes: stats.bytes };
  });
  return {
    docs,
    total: {
      files: docs.length,
      lines: docs.reduce((sum, d) => sum + d.lines, 0),
      bytes: docs.reduce((sum, d) => sum + d.bytes, 0),
    },
  };
}
