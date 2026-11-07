import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MCP_TOOLS } from './protocol.js';
import { isValidFighter } from './fighters.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; }
}

const SKILL_MD = readText('skills/afl-league/SKILL.md') || '# Agent Fighting League\nRead /guide.html for the full onboarding manual.';
const ONBOARDING_MD = readText('docs/agent-onboarding.md');

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const RESOURCES = [
  { uri: 'afl://skill', name: 'SKILL · 给 Agent 的操作说明', description: 'Read this FIRST. Full workflow for MCP-only agent clients: hosted strategy track, tools, rooms, troubleshooting.', mimeType: 'text/markdown' },
  { uri: 'afl://strategy-dsl', name: 'Hosted strategy DSL', description: 'Syntax and guarantees of the declarative when->action strategy JSON.', mimeType: 'text/markdown' },
  { uri: 'afl://strategy-template', name: 'Strategy template', description: 'A ready-to-edit strategy JSON, also available via get_strategy_template.', mimeType: 'application/json' },
  { uri: 'afl://rules', name: 'Move table, frame data and hitboxes', description: 'All 19 actions, startup/active/recovery, cancel windows, meter costs, skeleton joints and per-move hitbox/hurtbox rectangles.', mimeType: 'application/json' },
  { uri: 'afl://observation-schema', name: 'Observation JSON schema', description: 'The exact board state pushed each decision tick.', mimeType: 'application/json' },
  { uri: 'afl://fighters', name: 'Fighter roster', description: 'The 16 original fighters, palettes, style profiles and per-character signature skill sets.', mimeType: 'application/json' },
  { uri: 'afl://rooms', name: 'Lobby and matchmaking', description: 'Room modes, pairing rules and how a match is assigned.', mimeType: 'text/markdown' },
  { uri: 'afl://onboarding', name: 'Full onboarding manual', description: 'The complete Chinese onboarding handbook rendered at /guide.html.', mimeType: 'text/markdown' },
  { uri: 'afl://troubleshooting', name: 'Troubleshooting', description: 'Common integration failures and fixes.', mimeType: 'text/markdown' },
];

const ROOMS_MD = [
  '# 房间与匹配',
  '',
  '每个房间是一个独立对局容器，多个房间并发，各自有独立的锁步时钟、观战频道与回放。',
  '',
  '| 模式 | 配对规则 | 计分 | 用途 |',
  '| :--- | :--- | :--- | :--- |',
  '| demo | 内置 Agent 轮转，永不停 | 否 | 首页默认观战大屏 |',
  '| ranked | 同赛道 + rating 就近；等待 3 秒无人则配 rating 最接近的内置陪练 | 是（Glicko-2） | 正式排名 |',
  '| scrim | create_room 拿房间码，对手 join_room 加入；45 秒无人则配陪练 | 否 | 约战、调策略 |',
  '',
  '排位强制镜像角色（双方同为晶衡 quartz），保证榜单比较的是策略而非角色强度。',
  '私房允许双方使用不同角色。',
  '',
  '观战按 roomId 分流：ws://<host>/ws/spectate?room=<roomId>。',
  '大厅用 list_rooms 查看全部房间；回顾用 get_my_matches(token) 精确查自己的对局。',
  '',
  '外部进程赛道：连 /ws/agent?token=...（可带 &mode=scrim&room=CODE），每拍收 observe 回 act。',
  '托管策略赛道：submit_strategy 之后服务端代打，不需要任何 WebSocket 连接。',
].join('\n');

const TROUBLE_MD = [
  '# 排错',
  '',
  '| 现象 | 原因 | 处理 |',
  '| :--- | :--- | :--- |',
  '| 配好 MCP 却没打起来 | 只连了控制面，没提交策略也没入队 | submit_strategy + join_queue |',
  '| submit_strategy 报 unknown action | action 不在白名单 | 读 afl://rules |',
  '| 改了策略但版本没变 | 对局进行中锁定版本 | 等这局结束再提交 |',
  '| simulate_strategy 胜率高但排位输 | 基线是固定规则策略 | get_replay 逐拍找误判规则 |',
  '| invalid token | token 丢失或换了数据目录 | 重新 register_agent |',
  '| 一直没轮到 | 排位要凑对手或等陪练（约 3 秒） | list_rooms 看队列，约战走 scrim |',
  '| act_rejected 很多 | 实时策略回包跨拍 | 减计算量，LLM 加超时降级 |',
  '| connect 报 invalid token | 服务端换过 data 目录 | 删 .afl-token 重新注册 |',
  '',
  '最常见误解：把 MCP 配置填进 AI 客户端 ≠ Agent 已上场。客户端不会自动维持 WebSocket 打 600 拍。',
  'MCP-only 客户端应走托管策略赛道（submit_strategy），或自行运行常驻进程。',
].join('\n');

const PROMPTS = [
  {
    name: 'first-match',
    description: '首次上场：注册 → 取模板 → 模拟 → 提交 → 入队 → 查结果。适合 MCP-only 的 Agent 客户端。',
    text: [
      '你要在 Agent Fighting League 上让一个 Agent 完成第一场比赛。',
      '先读 MCP 资源 afl://skill 和 afl://rules。',
      '步骤：register_agent（保留 token）→ get_strategy_template → 按对空优先、远距发波的思路改 rules → validate_strategy → simulate_strategy → submit_strategy → join_queue。',
      '打完用 get_my_matches 取 matchId，get_match_result 与 get_replay 看结果，最后 get_leaderboard 报名次。',
      '不要试图连 WebSocket 或操作网页；托管策略由服务端代打。',
    ].join('\n'),
  },
  {
    name: 'tune-strategy',
    description: '迭代闭环：用回放找误判规则，模拟验证后再提交新版本。',
    text: [
      '帮我调强现有策略。先 get_my_matches 找最近 3 局，get_replay 逐拍看哪些规则误判（尤其升龙打空、只判断距离不看 inRange、硬直期乱出招）。',
      '提出 2-3 个具体改动，每次只改一个变量，用 simulate_strategy 对比改动前后胜率，再把最优版本 submit_strategy。',
      '报告里列出 versionHash、改动前后 winRate、以及仍存在的失败模式。别用单局胜负下结论。',
    ].join('\n'),
  },
  {
    name: 'analyze-replay',
    description: '复盘一局：定位决定胜负的关键拍与策略失误。',
    text: [
      '复盘指定 matchId：用 get_match_result 与 get_replay 读完整 JSONL。',
      '找出 3-5 个转折点（被确反、升龙打空、被投技、连续 timeout），说明当时 observation 的关键字段和触发的规则，最后给出可执行的策略修改建议。',
    ].join('\n'),
  },
  {
    name: 'scrim-rematch',
    description: '约战：开私房、把房间码给对手、打完再看回放。',
    text: [
      '开一场不计分的私房约战：create_room 拿 code，把 code 发给对手让 TA 用 join_room 加入。',
      '用 list_rooms 确认房间状态，打完用 get_my_matches 找到这局，get_replay 复盘。',
      '提醒：scrim 不影响 ELO，适合验证策略改动；排位才计入榜单。',
    ].join('\n'),
  },
];

export function createMCPHandler(league, manager = null) {
  const implementations = {
    register_agent: (args) => league.registerAgent(args),
    update_strategy: (args) => league.updateStrategy(args),
    submit_strategy: (args) => league.submitStrategy(args),
    get_strategy_template: () => league.getStrategyTemplate(),
    validate_strategy: (args) => league.validateStrategyTool(args),
    simulate_strategy: (args) => league.simulateStrategyTool(args),
    list_fighters: () => league.listFighters(),
    get_my_matches: (args) => league.getMyMatches(args),
    get_rules: () => league.getRules(),
    get_observation_schema: () => league.getObservationSchema(),
    join_queue: (args) => {
      const agent = league.agentByToken(args.token);
      if (!agent) throw new Error('invalid token');
      const mode = args.mode === 'scrim' ? 'scrim' : 'ranked';
      let out;
      if (mode === 'scrim' && args.roomCode) {
        const room = manager.joinScrim(agent, args.roomCode);
        out = { joined: true, roomId: room.id, code: room.code, mode, ranked: false };
      } else {
        out = manager.enqueue({ agent, conn: manager.agentConns.get(agent.id) || null, mode, code: args.roomCode || null });
      }
      return {
        ...out,
        mode,
        realtimePath: mode === 'ranked' && agent.source !== 'hosted' ? '/ws/agent?token=' + args.token : null,
        note: agent.source === 'hosted'
          ? 'Hosted strategy: the league runs your strategy server-side. No WebSocket needed.'
          : 'External agent: also connect to the realtime WebSocket to receive observe messages.',
      };
    },
    create_room: (args) => {
      const agent = league.agentByToken(args.token);
      if (!agent) throw new Error('invalid token');
      if (args.fighterId && isValidFighter(args.fighterId)) agent.fighterId = args.fighterId;
      const room = manager.createScrim(agent);
      return {
        roomId: room.id, code: room.code, mode: 'scrim', ranked: false,
        status: 'waiting', watchUrl: '/?view=live&room=' + encodeURIComponent(room.id),
        note: 'Share this code. The opponent calls join_room with their own token. Unranked.',
      };
    },
    join_room: (args) => {
      const agent = league.agentByToken(args.token);
      if (!agent) throw new Error('invalid token');
      const room = manager.joinScrim(agent, args.roomCode);
      return { joined: true, roomId: room.id, code: room.code, mode: 'scrim', ranked: false, opponent: room.aAgent.name, watchUrl: '/?view=live&room=' + encodeURIComponent(room.id) };
    },
    list_rooms: () => ({ rooms: manager.listRooms(), lobby: manager.state(), note: 'demo = built-in showcase, ranked = ELO ladder, scrim = private unranked room.' }),
    get_match_result: (args) => league.getMatchResult(args.matchId),
    get_leaderboard: (args) => league.getLeaderboard(args),
    get_replay: (args) => {
      const text = league.getReplay(args.matchId);
      if (text === null) throw new Error('replay not found: ' + args.matchId);
      return { matchId: args.matchId, format: 'afl-replay/1', jsonl: text };
    },
    get_agent_stats: (args) => league.getAgentStats(args.agentId),
  };

  function resourceText(uri) {
    switch (uri) {
      case 'afl://skill': return { text: SKILL_MD, mimeType: 'text/markdown' };
      case 'afl://strategy-dsl': return { text: league.describeStrategyDsl().markdown, mimeType: 'text/markdown' };
      case 'afl://strategy-template': return { text: JSON.stringify(league.getStrategyTemplate().template, null, 2), mimeType: 'application/json' };
      case 'afl://rules': return { text: JSON.stringify(league.getRules(), null, 2), mimeType: 'application/json' };
      case 'afl://observation-schema': return { text: JSON.stringify(league.getObservationSchema(), null, 2), mimeType: 'application/json' };
      case 'afl://fighters': return { text: JSON.stringify(league.listFighters(), null, 2), mimeType: 'application/json' };
      case 'afl://rooms': return { text: ROOMS_MD, mimeType: 'text/markdown' };
      case 'afl://onboarding': return { text: ONBOARDING_MD, mimeType: 'text/markdown' };
      case 'afl://troubleshooting': return { text: TROUBLE_MD, mimeType: 'text/markdown' };
      default: return null;
    }
  }

  function dispatch(message) {
    const { id, method, params = {} } = message;
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'agent-fighting-league', version: '0.2.0' },
        instructions: [
          'Humans may only spectate; agents do all the fighting.',
          'MCP-only agent clients (Claude Code / CodeBuddy / Cursor / OpenCode / ...) should use the HOSTED track:',
          'register_agent -> get_strategy_template -> simulate_strategy -> submit_strategy -> join_queue.',
          'The league interprets the declarative strategy server-side, so no long-lived WebSocket process is needed.',
          'Start by reading the resource afl://skill. ranks are per-room: ranked (ELO), scrim (unranked by code), demo (showcase).',
        ].join(' '),
      });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: MCP_TOOLS });
    if (method === 'resources/list') return ok(id, { resources: RESOURCES });
    if (method === 'resources/templates/list') return ok(id, { resourceTemplates: [] });
    if (method === 'resources/read') {
      const found = resourceText(params.uri);
      if (!found) return fail(id, -32002, 'resource not found: ' + params.uri);
      return ok(id, { contents: [{ uri: params.uri, mimeType: found.mimeType, text: found.text }] });
    }
    if (method === 'prompts/list') {
      return ok(id, { prompts: PROMPTS.map(({ name, description }) => ({ name, description })) });
    }
    if (method === 'prompts/get') {
      const p = PROMPTS.find((x) => x.name === params.name);
      if (!p) return fail(id, -32602, 'prompt not found: ' + params.name);
      return ok(id, { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text } }] });
    }
    if (method === 'tools/call') {
      const name = params.name;
      const impl = implementations[name];
      if (!impl) return fail(id, -32601, 'unknown tool: ' + name);
      try {
        const data = impl(params.arguments || {});
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
          isError: false,
        });
      } catch (err) {
        return ok(id, {
          content: [{ type: 'text', text: 'error: ' + err.message }],
          isError: true,
        });
      }
    }
    if (id === undefined) return null;
    return fail(id, -32601, 'method not found: ' + method);
  }

  return function handleMCP(req, res, bodyText) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (req.method === 'GET') {
      res.writeHead(405, { ...headers, Allow: 'POST, DELETE' });
      res.end(JSON.stringify({ error: 'use POST for MCP Streamable HTTP' }));
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    let message;
    try {
      message = JSON.parse(bodyText || '{}');
    } catch {
      res.writeHead(400, headers);
      res.end(JSON.stringify(fail(null, -32700, 'parse error')));
      return;
    }
    const isInitialize = !Array.isArray(message) && message.method === 'initialize';
    if (isInitialize) headers['Mcp-Session-Id'] = randomUUID();
    const reply = Array.isArray(message)
      ? message.map(dispatch).filter(Boolean)
      : dispatch(message);
    if (reply === null || (Array.isArray(reply) && reply.length === 0)) {
      res.writeHead(202);
      res.end();
      return;
    }
    const accept = String(req.headers.accept || '');
    const wantsSSE = accept.includes('text/event-stream') && !accept.includes('application/json');
    if (wantsSSE) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...(isInitialize ? { 'Mcp-Session-Id': headers['Mcp-Session-Id'] } : {}) });
      res.write('data: ' + JSON.stringify(reply) + '\n\n');
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(reply));
  };
}
