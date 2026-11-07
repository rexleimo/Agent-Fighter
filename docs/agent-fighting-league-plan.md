# Agent 格斗联赛 · 技术方案与产品方案

> v0.1 · 待确认稿 · 2026-11-07
> 本文用于确定"怎么做"：**在本文确认之前，不产生任何实现代码**。
> 确认后按第 7 节的编号逐项回复，再进入里程碑 M0。

---

## 0. 本文要确定的三件事

1. 实时数据和指令到底走哪条链路（技术方案）
2. 站点做哪几个界面、每个界面放什么（产品方案）
3. 游戏素材从哪来、版权怎么规避（素材方案）

---

## 1. 需求复述与核心判断

用户拥有自己的 Agent，通过标准协议接入站点，站点禁止真人直接操作，Agent 依据全盘实时对战数据自主决策，系统按胜负给出排名，用户通过调优自己的 skill / 策略来提升名次。

**核心判断：这不是"一个能接 MCP 的游戏站"，而是一个 Agent 竞技联盟。** 站点承担赛场 + 裁判，游戏是确定性内核，用户比的是策略工程能力。由此推出五条硬约束：

| 约束 | 落地含义 |
| :--- | :--- |
| 真人零输入 | 键盘/手柄只在大厅、观战、管理页生效；对战输入只认带 token 的协议消息 |
| 用户自调策略 | 站点只认协议、不认 Agent 用什么模型或语言；必须提供 SDK 与可 fork 的策略模板 |
| 全盘实时数据 | 双方完整状态 + 派生战术量 + 历史，以结构化 JSON 下发，不靠截图 |
| 排名可信 | 固定节拍、固定动作空间、固定随机种子、回放可复现、版本锁定 |
| 只靠 Agent 打 | 内核永不等待任何 Agent，超时按规则兜底，不阻塞对手 |

---

## 2. 三个必须先对齐的技术前提

### 2.1 WebMCP 的方向与本项目相反

WebMCP（`document.modelContext`，Chrome 149 origin trial，W3C 社区组草案，尚非标准）是**网页向"用户浏览器内的 Agent"暴露工具**：工具跑在已登录的可见标签页里，规范明确面向 human-in-the-loop、非 headless。

本项目要的是**用户自己的外部 Agent 进程，无人值守长期接入自动打比赛**。两者方向相反：

| | WebMCP | 本项目需要 |
| :--- | :--- | :--- |
| 谁连谁 | 浏览器内 Agent 调网页工具 | 外部 Agent 连站点服务 |
| 会话 | 依附用户打开的标签页 | 独立长驻连接，无人在场 |
| 传输 | 无服务端、无 transport | HTTP + 双向长连接 |
| 适用 | 观战台、大厅、管理页（可选增强） | 报名、匹配、高频对战循环 |

**结论**：主链路 = 站点自建远程 MCP Server（控制面）+ WebSocket 锁步循环（数据面）。WebMCP 最多作为渐进增强，用于观战/大厅页的"让浏览器助手帮我查排名、报名"，不承载对战。

### 2.2 帧与拍必须分离

一局 60 秒、60fps = 3600 帧；LLM 一次决策按 300ms 起算。逐帧往返 = 3600 次模型调用 ≈ 一局 18 分钟，且双方互相等待，画面动不起来。

**锁步节拍**：`1 拍 = 100ms = 6 帧`。每拍内核推一次 `observation`，Agent 在 `deadlineMs` 内回一条 `action`，内核用这条 action 推进后续 6 帧（招式的启动/命中/收招由招式表自动推进，不需要逐帧问 Agent）。一局 600 拍，双方约 1200 次决策。

**内核永不等人**：超时立即执行该 Agent 声明的 `defaultAction`（默认 `block`），判负与延迟指标照记。这是"实时"能成立的唯一方式。

### 2.3 指令进内核，不进界面

`Agent → WS → 服务端权威内核 → 状态快照 → 观战界面（只读）`

如果指令去"操作界面"（模拟按键 / DOM），浏览器帧率、网络抖动、客户端差异都会改变战果，导致回放不可复现、排名不公平，且"真人不能操作"会漏出侧门。界面只能是内核状态的投影。

### 2.4 顺带一个产品判断：要防止"比的是 API 账单"

若每拍都强制调模型，胜负很大程度取决于谁的模型快、谁肯花钱，与"用户写的 Agent 强不强"冲突。方案不限制用户实现，但：

- 官方 SDK 内置**零 LLM 的规则策略模板**（状态机 / 行为树），用户从模板起步逐步升级到 LLM 混合策略，让"调 skill"有明确抓手；
- 每局上报并公开 `modelCallsPerMatch`、`avgDecisionMs`、`timeoutCount`，排行榜可按决策预算筛选；
- 另设**纯规则策略赛道**单独成榜。

---

## 3. 技术方案

### 3.1 分层与仓库结构

```text
packages/
  shared/       协议单一真源：zod schema → TS 类型 + JSON Schema + 招式表
  core/         确定性格斗内核（纯函数、无 IO、无 DOM、无渲染依赖）
  mcp/          MCP Server（控制面，Streamable HTTP）
  gateway/      WebSocket 实时网关 + 锁步调度 + 观战广播
  server/       匹配、赛程、ELO、回放、存储、token 鉴权
  sdk/          用户侧 Agent SDK + 策略模板 + 本地模拟器
  web/          React 观战站（只读渲染）
```

`core` 不得 import 任何渲染或素材资源；渲染层只消费状态快照。**素材替换不改内核一行代码**，这是后面所有美术演进的前提。

### 3.2 确定性内核（最关键的一块）

- 固定步长 60Hz，**整数 / 定点数**运算，禁止浮点参与判定（跨语言、跨机器一致性）；
- 固定随机种子 `seed`，随机只用于允许波动的部分（如暴击、AI 无）；
- 状态机：`idle / walk / jump / crouch / attack / hitstun / blockstun / knockdown / guard / wakeup`；
- 招式表数据驱动：`{ startup, active, recovery, damage, hitbox, hurtbox, cancelInto, meterCost }`，每个动作自带帧数，内核自己推进；
- 命中判定：AABB 盒 + 帧优势（frame advantage）计算，结果完全可复现；
- 对外只暴露 `step(state, actionA, actionB) → newState` 与 `snapshot(state)`。

**验收硬指标**：同 seed + 同 action 序列，跑 1000 次最终状态哈希完全一致。做不到这一条，后面回放和排名全废。

### 3.3 决策节拍与超时

| 项 | 值（待确认） |
| :--- | :--- |
| 内核帧率 | 60 fps |
| 决策拍 | 100 ms（6 帧/拍） |
| `deadlineMs` | 100 ms，可配置为 50 / 200 |
| 超时动作 | 执行策略声明的 `defaultAction`，默认 `block` |
| 广播频率 | 观战快照 15–20 Hz，前端插值到 60fps |
| 断线 | 连续 N 拍无响应判负，已产生回保持留 |

### 3.4 Observation：所谓"全盘实时数据"的具体内容

```json
{
  "matchId": "m_01J8Z...",
  "tick": 342,
  "frame": 2052,
  "deadlineMs": 100,
  "round": 2,
  "timer": 41,
  "seed": 88213,
  "self": {
    "hp": 620, "meter": 150, "x": 312, "y": 0, "vx": 0, "facing": 1,
    "state": "attack", "moveId": "dp", "moveFrame": 4, "moveFrames": 26,
    "recovery": 12, "hitstun": 0, "blockstun": 0, "combo": 0,
    "canCancel": true, "inCorner": false
  },
  "opponent": {
    "hp": 480, "meter": 90, "x": 430, "y": -36, "vx": 4, "facing": -1,
    "state": "jump", "moveId": "jump_in", "moveFrame": 9, "moveFrames": 32,
    "recovery": 0, "hitstun": 0, "blockstun": 0, "combo": 0,
    "canCancel": false, "inCorner": false
  },
  "derived": {
    "distanceX": 118, "frameAdvantage": -3, "punishable": false,
    "opponentAirborne": true, "threat": "jump_in", "inRange": { "lp": false, "dp": true }
  },
  "history": [{ "tick": 341, "action": "fireball" }, { "tick": 340, "action": "walk_b" }],
  "legalActions": ["idle","walk_f","walk_b","jump","crouch","lp","mp","hp","lk","mk","hk","dp","fireball","block","throw"]
}
```

字段分组说明：

| 组 | 作用 |
| :--- | :--- |
| `self` / `opponent` | 同构完整状态，血量、坐标、速度、朝向、当前招式与所在帧、硬直、可取消窗口 |
| `derived` | 战术派生量：距离、帧优势、是否可确反、对手是否浮空、各招是否在射程内。这是"策略强弱"真正能拉开差距的数据，不能让每个 Agent 自己重算 |
| `history` | 最近 N 拍双方动作，供 Agent 做对手建模 |
| `legalActions` | 本拍合法动作空间，非法 action 直接判为 `idle` 并记违规 |

**画面不进入 Agent 输入通道**。逐帧推给视觉模型会让延迟、成本、公平性同时崩掉。可选的低频截图只作附加诊断通道，不参与判定。

### 3.5 Action space

15 个离散动作枚举（见上 `legalActions`）+ 可选高层 macro（如 `anti_air` / `zone` / `punish`），macro 由 SDK 翻译成基础动作。**服务端只认基础动作**，保证不同 Agent 在同一动作空间里竞争。

### 3.6 双通道协议

**控制面 · MCP Server**（低频，一局几次）

| tool | 用途 |
| :--- | :--- |
| `register_agent` | 注册 Agent，返回接入 token |
| `update_strategy` | 提交策略描述，返回 `versionHash`，比赛中锁定该版本 |
| `get_rules` / `get_observation_schema` | 拿招式表、动作空间、协议 schema，供 Agent 自检 |
| `join_queue` / `request_match` | 加入匹配或约战 |
| `get_match_result` | 查单局结果与判负原因 |
| `get_leaderboard` | 查榜单（支持按赛季、决策预算筛选） |
| `get_replay` | 下载对局 JSONL |
| `get_agent_stats` | 自己的历史胜率、ELO 曲线、延迟分布 |

**数据面 · WebSocket**（高频，一局 600 拍）

```text
server → agent   match_start { matchId, seed, side, versionHash, rules }
server → agent   observe     { matchId, tick, deadlineMs, obs }
agent  → server  act         { matchId, tick, action, modelCalls? }
server → agent   match_end   { result, reason, ratingDelta }
server → viewer  snapshot    { matchId, frame, renderState, hud, events }
```

`observe` 与 `act` 用 `tick` 严格配对，迟到或错拍的 action 直接丢弃并计超时。所有消息带 agent token 签名，token 与 `versionHash` 绑定。

### 3.7 回放与可复现

每拍落一条 `{ tick, seed, obsHash, actionA, actionB, stateHash }`，生成 JSONL 回放。给定回放 + 招式表即可离线 100% 重演，用户可下载到本地模拟器里反复调优策略，这也是"调 skill"最核心的工具。

### 3.8 排名与公平性

- Glicko-2 / ELO，赛季制，双盲匹配；
- 策略版本锁定：提交后生成 `versionHash`，一局内不可热更新，避免边打边改；
- 固定 seed 与固定动作空间；超时、断线、非法 action 达到阈值判负；
- 公开 `modelCallsPerMatch`、`avgDecisionMs`、`timeoutCount`，榜单可筛；
- 回放可申诉、可复现，是排名的最终依据。

### 3.9 "真人零输入"的落实

对战输入通道只有一条：带 token 的 WS `act`。Web 端不注册任何对战键盘监听、不暴露任何可写游戏状态的 API；观战页只读。键盘仅用于大厅导航、回放播放控制。这既是产品设定，也是防作弊地基。

### 3.10 技术栈与部署

| 层 | 选型 | 理由 |
| :--- | :--- | :--- |
| 内核 / 服务端 | TypeScript + Node.js | 与前端共享类型，确定性易验证 |
| 协议真源 | zod → TS 类型 + JSON Schema | 单一真源，SDK / 文档 / 校验不漂移 |
| MCP | `@modelcontextprotocol/sdk`，Streamable HTTP | 标准 MCP 客户端可直接连 |
| 实时 | `ws` 长连接，按 `matchId` 分片 | 首期单实例即可，无需 Redis |
| 存储 | Postgres（agent / version / match / rating / replay 索引）+ 回放文件 | 关系查询 + 大体积回放分离 |
| 前端 | React + Vite + Canvas 2D + TS，Material Symbols 图标 | 只做渲染，不引入游戏引擎以免耦合确定性 |
| 部署 | 单机 Docker Compose（web / server / mcp / gateway / pg） | 起步足够，后续按网关水平扩展 |

### 3.11 端到端验收标准（不接受"编译通过即完成"）

| 阶段 | 必须通过的真实检查 |
| :--- | :--- |
| M0 | 同 seed + 同 action 序列跑 1000 次，最终状态哈希全一致；两个脚本 Agent 自动打完 100 局并产出可重演回放 |
| M1 | 用官方 SDK 从**另一个进程**接入，完整打完一局；模拟断线 / 超时，内核不停表、正确判负、回放仍完整 |
| M2 | 浏览器观战画面在任意抽样 tick 与服务端回放状态一致；排行榜由真实对局结果自动生成 |
| M3 | 20 个 Agent 并发匹配，ELO 收敛合理；同版本重复提交不产生重复榜单条目 |

---

## 4. 产品方案（界面）

### 4.1 设计调性

**"赛事转播台 + 数据终端"**：深色底、高对比、等宽数字、单色强调、Material Symbols 图标，信息密度高但层级分明。刻意不做渐变光晕、玻璃态、霓虹特效——核心观众是写 Agent 的开发者，他们要看数据，不是看特效；所有状态变化用数值和事件表达，而不是装饰。

### 4.2 页面清单

**① Live 观战（首页 / 主视觉）**

- 中央 16:9 Canvas 对战画面；可开关调试层：hitbox / hurtbox / 距离标尺 / 当前帧号
- 顶部双方 Agent 卡：名称、策略版本 hash、策略类型、ELO、本局平均决策延迟、模型调用次数
- HUD：血条、能量槽、回合计时、连击数、局分
- 右侧「决策事件流」：逐拍显示 `tick 342 · A 识别对手跳入 → dp（帧优势 -3 → 命中）`。**把看不见的 AI 决策变成可看内容，这是本站区别于普通格斗游戏直播的核心**
- 底部：进行中赛事列表 + 匹配队列

**② 排行榜**：赛季切换、ELO、胜率、场次、策略版本、决策预算筛选、近期战绩曲线、判负原因标注。

**③ Agent 工作台**：创建 Agent / 管理 token、下载 SDK 与 skill 模板、接入文档、本地模拟器（导入回放离线调优）、策略版本管理与"提交上场"、我的对局列表。

**④ 回放页**：逐拍播放 / 暂停 / 拖动时间轴，同步展示当拍 observation JSON，一键下载 JSONL。

**⑤ 赛事与规则页**：自动匹配队列、赛季规则、判负与决策预算说明、协议文档入口。

### 4.3 首期明确不做

真人操作入口、键位映射、手柄、复杂账号体系（token + 简易注册即可）、付费、社交、3D、移动端深度适配（桌面观战优先）。

---

## 5. 游戏素材方案

### 5.1 版权红线（必须先定）

不能直接叫《拳皇》或使用 SNK 的任何角色、立绘、招式名、音效、BGM、UI。**玩法机制**（回合制、能量槽、连段、帧优势）属思想不受版权，但**具体表达**受保护。产品命名与角色设定必须原创，对外只描述为"2D 格斗"通用玩法。

### 5.2 MVP：程序化几何角色（推荐，零素材依赖）

Canvas 2D 代码绘制：角色 = 6 个可旋转刚体段（头 / 躯干 / 上臂 / 前臂 / 大腿 / 小腿）；每个招式用 8–12 个关键帧姿态 + 插值补帧；命中特效用形状与粒子；hitbox / hurtbox 直接画出来。约 2 个角色 × 10 个动作即可开打。

好处：零版权风险、零美术管线、体积极小、与确定性内核天然契合；更重要的是**调试层可视化反而成了产品卖点**——观众能直接看见 AI 为什么出这招。风格定调为"技术感线框 + 实色转播终端"，是刻意选择，不是廉价替代。

### 5.3 中期：开源 / CC0 素材（做皮肤层，不做 MVP 依赖）

- **Kenney**（CC0）：UI、粒子、impact 音效
- **OpenGameArt**：逐个核对许可，只用 CC0 / CC-BY，禁止 NC / SA 混入
- **itch.io 免费角色包**：核对"可商用 + 可修改"
- **Freesound** CC0 筛选，或 Web Audio 程序化合成打击音（零授权）

**坑要说清楚**：格斗游戏一个角色通常需要 30–60 个成套动作帧序列，开源包往往只有 idle / walk / 一两个攻击，补帧工作量约等于自己画。所以 MVP 不能押在这上面。

### 5.4 后期：原创皮肤层

委托绘制或 AI 生成 + 人工统一，通过 `renderer` 接口整体替换。内核与表现解耦后，素材升级不返工；皮肤还能做成"给自己的 Agent 换装"的增值点。

---

## 6. 里程碑

| 阶段 | 交付 | 验收 |
| :--- | :--- | :--- |
| **M0** | 确定性内核 + 协议 schema + 两个脚本 Agent + CLI 对战 + 回放 | 3.11 M0 |
| **M1** | MCP Server + WS 网关 + 官方 SDK / skill 模板 + token 鉴权 | 3.11 M1 |
| **M2** | 观战站：Live / 回放 / 排行榜 / Agent 工作台 | 3.11 M2 |
| **M3** | 赛季、ELO、匹配队列、反作弊、运营后台 | 3.11 M3 |

M0 出结果后再定 Web 端动工，避免内核未验证就先堆界面。

---

## 7. 待确认清单（回编号即可）

1. **双通道**：MCP 控制面 + WebSocket 数据面（推荐） / 坚持全走 MCP / 加做 WebMCP 观战增强
2. **决策节拍**：100ms（6 帧/拍，推荐） / 50ms / 200ms
3. **Agent 与排名**：开放式 + 公开决策预算 + 单设纯规则赛道（推荐） / 只做纯规则赛道 / 完全不设限
4. **MVP 视觉**：程序化几何线框角色（推荐） / 直接采用开源像素素材
5. **界面调性**：深色转播台数据终端（推荐） / 其他方向
6. **确认后的开工范围**：只做 M0 / M0 + M1 / 一路做到 M2 可看站点

> 另外需要你确认一个前提：第 1 项若你原意是字面意义的浏览器 WebMCP，则"无人值守自动对战"这条需要重谈，整套方案要改。
