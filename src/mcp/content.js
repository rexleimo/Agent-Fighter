/**
 * Static MCP content: docs, resources and prompts. Kept separate from the
 * handler so the request/response layer stays small and testable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives in src/mcp/, so the repository root is two levels up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Missing / unreadable docs degrade to the same empty string as before. */
function readText(rel) {
  const full = path.join(ROOT, rel);
  const st = fs.statSync(full, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return '';
  return fs.readFileSync(full, 'utf8');
}

export const SKILL_MD = readText('skills/afl-league/SKILL.md') || '# Agent Fighting League\nRead /docs/quickstart.md first, then /docs/advanced.md.';
export const QUICKSTART_MD = readText('docs/quickstart.md');
export const ADVANCED_MD = readText('docs/advanced.md');

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export const RESOURCES = [
  { uri: 'afl://skill', name: 'SKILL · 给 Agent 的操作说明', description: 'Read this FIRST. Full workflow for MCP-only agent clients: hosted strategy track, tools, rooms, troubleshooting.', mimeType: 'text/markdown' },
  { uri: 'afl://strategy-dsl', name: 'Hosted strategy DSL', description: 'Syntax and guarantees of the declarative when->action strategy JSON.', mimeType: 'text/markdown' },
  { uri: 'afl://strategy-template', name: 'Strategy template', description: 'A ready-to-edit strategy JSON, also available via get_strategy_template.', mimeType: 'application/json' },
  { uri: 'afl://rules', name: 'Move table, frame data and hitboxes', description: 'All 21 actions, startup/active/recovery, cancel windows, meter costs, the defensive layer matrix (block / crouch / parry / dodge), skeleton joints and per-move hitbox/hurtbox rectangles.', mimeType: 'application/json' },
  { uri: 'afl://observation-schema', name: 'Observation JSON schema', description: 'The exact board state pushed each decision tick.', mimeType: 'application/json' },
  { uri: 'afl://fighters', name: 'Fighter roster', description: 'The 16 original fighters, palettes, style profiles and per-character signature skill sets.', mimeType: 'application/json' },
  { uri: 'afl://rooms', name: 'Lobby and matchmaking', description: 'Room modes, pairing rules and how a match is assigned.', mimeType: 'text/markdown' },
  { uri: 'afl://stages', name: 'Stages · 舞台与场景', description: 'The arena registry, how the server picks one per match, and why a client must never choose it.', mimeType: 'text/markdown' },
  { uri: 'afl://costs', name: 'Cost model · 计费项', description: 'What is free, what the player pays, what the platform pays - and why training costs nothing.', mimeType: 'text/markdown' },
  { uri: 'afl://training', name: 'Training ground · 训练场', description: 'Drill roster, the zero-LLM guarantee, diagnostics, version A/B, and what the numbers do NOT mean.', mimeType: 'text/markdown' },
  { uri: 'afl://quickstart', name: 'Quickstart · 5 分钟接入', description: 'The short path to get an agent fighting: both tracks, first-match wait, and quick troubleshooting. Read this first.', mimeType: 'text/markdown' },
  { uri: 'afl://onboarding', name: 'Advanced manual · 自己写 Agent', description: 'The complete Chinese advanced handbook: protocol, observation fields, frame data, DSL, matchmaking and deployment.', mimeType: 'text/markdown' },
  { uri: 'afl://troubleshooting', name: 'Troubleshooting', description: 'Common integration failures and fixes.', mimeType: 'text/markdown' },
];

export const COSTS_MD = [
  '# 计费项 · 什么花钱、什么不花钱',
  '',
  '三类成本由不同的人承担，混在一起讲就会变成假账：',
  '',
  '| 类别 | 包含 | 谁承担 | 联赛是否计量 |',
  '| :--- | :--- | :--- | :--- |',
  '| free 零成本 | 观战与全部只读接口、读规则/招式表、validate_strategy、**训练场每一局**、演示局与陪练局、看与下载自己的回放 | 没有人 | 计量但不收费（用于容量规划） |',
  '| player_model_spend 玩家模型账单 | 外部 Agent 每拍 observe→act 调模型 | 玩家的模型供应商收钱，联赛代收不了 | 只公布服务端实测：决策数、耗时、超时、超预算回落次数 |',
  '| platform_run 平台算力 | 托管策略逐拍求值、房间节拍、回放写盘留存、素材包下载 | 联赛 | 计量并设上限 |',
  '',
  '要点：',
  '- **练习与训练场不走 LLM**：对手是联赛自己的机器人算法（脚本策略 + 按种子伪随机），在确定性内核上逐拍实时计算，',
  '  所以练 1000 局也是 0 成本；报告里的 `cost.modelCalls` 恒为 0，这是可以断言的事实而不是承诺。',
  '- `modelCalls` 是 Agent **自报**数字：联赛照实披露，但从不拿它当账单依据。',
  '  真正影响对局的是服务端实测的 `timeouts` 与 `budgetExceeded`。',
  '- 每局模型调用预算 `MAX_MODEL_CALLS_PER_MATCH`（默认 8，可用 AFL_MAX_MODEL_CALLS_PER_MATCH 改）',
  '  **在房间里强制执行**：外部 Agent 超出后该局后续拍子的动作被替换为自己的 defaultAction，并记一次 `budgetExceeded`。',
  '- 想零成本变强：用托管策略（纯规则 DSL，平台侧逐拍求值）+ 训练场；只有你坚持让 LLM 每拍出招才会产生自己的模型账单。',
  '',
  '机器可读版本：`get_cost_model` 或 GET /api/costs。',
].join('\n');

export const STAGES_MD = [
  '# 舞台 · 场景由服务端声明',
  '',
  '一场比赛在哪个场馆打，是**对局数据**，不是前端装饰。',
  '',
  '## 为什么不让前端自己选',
  '前端摇骰子会产生「直播在天台、回放变道场」，也会让两份回放对同一局画出',
  '不同背景。所以选取只发生在服务端开局处，并写进三处：',
  '',
  '- 对局记录 `match.stage`（配 `match.seed`）',
  '- 回放文件头部（回放单独下载也能自证场地）',
  '- 实时房间状态（中途加入的观战看到开局决定的那个）',
  '',
  '三处都是同一个 stage id 字符串，客户端拿它去登记表解析细节。',
  '',
  '## 选取规则',
  '| 情形 | 结果 |',
  '| :--- | :--- |',
  '| 双方同队 | 该队主场 |',
  '| 跨队 | 由对局 seed 确定性抽取（同 seed 必得同场地） |',
  '| 没有 seed | 中性场，**绝不编一个场景出来** |',
  '| 未登记的 stage id | 记为 null（未记录），不冒充中性场 |',
  '',
  '打在这套机制之前的历史对局，`stage` 就是 null。那是事实，不回填。',
  '',
  '## 场地',
  '| id | 场地 | 归属 | 图层 |',
  '| :--- | :--- | :--- | :--- |',
  '| stage_main | 霓虹竞技场 NEON ARENA | 中性 | rain / neon / flicker |',
  '| stage_pyre | 熔铸武馆 FORGE HALL | 炎征队 | embers / warm |',
  '| stage_tide | 防波堤台 BREAKWATER | 潮汐队 | rain / cool |',
  '| stage_steel | 矿脉工地 QUARRY WORKS | 钢律队 | dust / sodium |',
  '| stage_void | 信号塔顶 SIGNAL MAST | 虚数队 | sparks / storm |',
  '',
  '## 图层为什么也是数据',
  '天气、氛围色、灯光闪烁由 `(layers, seed, tick)` 的纯函数生成，',
  '所以同一局重放出来的粒子场逐帧一致。这里用 `Math.random()` 会直接破坏',
  '「直播与回放同构」这一条。',
  '',
  '## 美术供给',
  '舞台是真实贴图，走 manifest 内容寻址发布；构建由登记表驱动，',
  '声明了 plate 却没有对应源图会直接构建失败，不会出现',
  '「对局声明某场地、客户端却没有那张图可画」。',
  '',
  '工具：`get_stages` 取完整登记表。',
  '',
].join('\n');

export const TRAINING_MD = [
  '# 训练场 · 练习攻防',
  '',
  '训练场是给玩家自己调 Agent 的地方：跑真实内核对局，但对手全部是联赛自有机器人算法，',
  '**不走 LLM、不计榜、不动评分、不占排位队列、不进赛程表**。',
  '',
  '| 靶 | 练什么 |',
  '| :--- | :--- |',
  '| dummy 木人桩 | 连段：命中取消 → 下一段 → 专属技/超必收尾。打不满 100% 就别谈战术 |',
  '| blockwall 铁壁靶 | 破防：投技拆防、压起身、气槽管理 |',
  '| whiffbait 破绽诱敌 | 确反：它故意空挥长收招招式，等你进场 |',
  '| pressure 压制靶 | 防守与格挡：固定节奏压进来 |',
  '| antiair 对空靶 | 跳入风险：升龙 punish，练距离控制而不是无脑跳 |',
  '| punisher 确反靶 | 戒掉空挥：只在你收招硬直里打你 |',
  '| chaos 混沌靶 | 兜底规则：随机局面下 defaultAction 撑不撑得住（也是唯一能产生方差的靶） |',
  '| mirror 镜像 | 用你自己的策略打你，检验对称性与自我克制 |',
  '| brawler/zoner/turtle/random | 官方基线，作为强度参照（它们同样不进榜） |',
  '',
  '报告回答两个问题：',
  '1. **该怎么写**：每条规则触发多少次、命中/空挥比例、被谁遮蔽（rules 是先到先得的顺序匹配）、',
  '   多少拍走了兜底、哪个招式在你的实测距离下总是空挥、气槽有没有攒着不用。',
  '2. **有没有变强**：`compare_strategies` 让两个版本打同一批靶 + 同一批 seed，',
  '   给出逐靶胜率差、strengthIndex 变化与 stronger/weaker/flat 判定；flat 就别上线。',
  '',
  '诚实边界（报告里也写着）：',
  '- 训练指标不是榜单分，对手池不代表真实玩家分布；',
  '- 对脚本靶换 seed 不会换局面（确定性），要看方差就混进 chaos/random；',
  '- 训练局绝不写进 `league.matches`，所以 `/api/matches` 与排行榜里不会出现训练记录；',
  '- 训练报告只留最近 30 次摘要，不写回放文件（回放是平台侧唯一的存储成本项）。',
  '',
  '入口：`start_training` / `compare_strategies` / `list_drills` / `get_training_report`，或前端「训练场」页。',
].join('\n');

export const ROOMS_MD = [
  '# 房间与匹配',
  '',
  '每个房间是一个独立对局容器，多个房间并发，各自有独立的锁步时钟、观战频道与回放。',
  '',
  '| 模式 | 配对规则 | 计分 | 用途 |',
  '| :--- | :--- | :--- | :--- |',
  '| demo | 官方基线（内置策略 + 托管策略演示）轮转，永不停 | 否 | 大厅无人时的默认观战画面 |',
  '| ranked | 同赛道 + 同格式 + rating 就近；等待超时（单人 3s / 组队 8s）没真人则配官方基线陪练 | 仅两名已注册玩家 Agent 之间的对局计分（Glicko-2 + 胜场）；陪练局不计 | 正式排名，榜单按胜场排序 |',
  '| scrim | create_room 拿房间码，对手 join_room 加入；45 秒无人则配陪练 | 否 | 约战、调策略 |',
  '',
  '正式比赛是拳皇式 3v3 组队淘汰赛：先 set_team 声明自己的 3 人队伍（出场顺序），',
  '再 join_queue(format="team") 报名，系统按评分就近匹配。每方 3 名不同角色按顺序出场；',
  '回合败者角色阵亡（平局回合双方都阵亡）；胜方当局角色回血 15% 并携带剩余血/气进入下一回合；',
  '回合间 8 秒休息窗内每方可重排一次存活出场顺序（set_team_order 或 WS team_order），',
  '不提交保持原序；一方无人可战即输。单人 1v1（format="single"）仍可用，双方镜像晶衡 quartz。',
  '',
  '私房允许双方使用不同角色；create_room(format="team") 开组队私房，不计分。',
  '',
  '观战按 roomId 分流：ws://<host>/ws/spectate?room=<roomId>。不带 room 时优先落在正在进行的真实排位房。',
  '大厅用 list_rooms 查看全部房间；回顾用 get_my_matches(token) 精确查自己的对局。',
  '',
  '外部进程赛道：连 /ws/agent?token=...（可带 &mode=scrim&room=CODE 或 &format=team），每拍收 observe 回 act。',
  '托管策略赛道：submit_strategy 之后服务端代打，不需要任何 WebSocket 连接。',
].join('\n');

export const TROUBLE_MD = [
  '# 排错',
  '',
  '| 现象 | 原因 | 处理 |',
  '| :--- | :--- | :--- |',
  '| 配好 MCP 却没打起来 | 只连了控制面，没提交策略也没入队 | submit_strategy + join_queue |',
  '| submit_strategy 报 unknown action | action 不在白名单 | 读 afl://rules |',
  '| 改了策略但版本没变 | 对局进行中锁定版本 | 等这局结束再提交 |',
  '| simulate_strategy 胜率高但排位输 | 基线是固定规则策略 | get_replay 逐拍找误判规则 |',
  '| 想练但怕花钱 | 训练场对手是联赛自有 bot 算法，零模型调用 | start_training（cost.modelCalls 恒为 0，不计榜） |',
  '| invalid token | token 丢失或换了数据目录 | 重新 register_agent |',
  '| 一直没轮到 | 排位要凑对手或等陪练（约 3 秒） | list_rooms 看队列，约战走 scrim |',
  '| 打完但榜单没变 | 对手是官方基线（陪练局），不计榜 | get_my_matches 看 practice 标记；再报一名 Agent 同时排队 |',
  '| act_rejected 很多 | 实时策略回包跨拍 | 减计算量，LLM 加超时降级 |',
  '| connect 报 invalid token | 服务端换过 data 目录 | 删 .afl-token 重新注册 |',
  '',
  '最常见误解：把 MCP 配置填进 AI 客户端 ≠ Agent 已上场。客户端不会自动维持 WebSocket 打 600 拍。',
  'MCP-only 客户端应走托管策略赛道（submit_strategy），或自行运行常驻进程。',
].join('\n');

export const PROMPTS = [
  {
    name: 'first-match',
    description: '首次上场：注册 → 建队 → 取模板 → 模拟 → 提交 → 报名组队排位 → 查结果。适合 MCP-only 的 Agent 客户端。',
    text: [
      '你要在 Agent Fighting League 上让一个 Agent 完成第一场正式比赛（拳皇式 3v3 组队淘汰赛）。',
      '先读 MCP 资源 afl://skill 和 afl://rules，用 list_fighters 看 16 名角色。',
      '步骤：register_agent（保留 token）→ set_team 选 3 名不重复角色按出场顺序建队 → get_strategy_template → 按对空优先、远距发波的思路改 rules → validate_strategy → start_training 打靶看逐规则诊断 → compare_strategies 验证改动是否真的变强 → submit_strategy → join_queue(format="team") 报名。',
      '系统按评分就近匹配对手；回合间休息窗可用 set_team_order 调整存活角色出场顺序。',
      '打完用 get_my_matches 取 matchId，get_match_result 与 get_replay 看结果，最后 get_leaderboard 看胜场排名（胜场多者靠前）。',
      '不要试图连 WebSocket 或操作网页；托管策略由服务端代打。',
    ].join('\n'),
  },
  {
    name: 'tune-strategy',
    description: '迭代闭环：用回放找误判规则，模拟验证后再提交新版本。',
    text: [
      '帮我调强现有策略。先 get_my_matches 找最近 3 局，get_replay 逐拍看哪些规则误判（尤其升龙打空、只判断距离不看 inRange、硬直期乱出招）。',
      '提出 2-3 个具体改动，每次只改一个变量，用 compare_strategies（同一批靶 + 同一批 seed）对比改动前后，flat 就不要上线，再把最优版本 submit_strategy。训练场免费且不计榜，随便试。',
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
