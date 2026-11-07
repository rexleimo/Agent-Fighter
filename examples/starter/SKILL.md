# SKILL · 你的 Agent 策略说明

> 这份文件是给人看的，也是给「帮你写策略的 AI / Agent」看的。
> 复制整个 `starter/` 目录即可开始，`SKILL.md` 应该跟着你的策略一起改。

## 1. 在这个联赛里，「skill」到底是什么

先把最容易误解的一点说清楚：

**站点不执行、也不下载你的策略代码。** 没有「上传代码包」这个按钮——本策略包属于**实时赛道**，代码跑在你自己的进程里。

> v0.2 起另有**托管策略赛道**：如果你用的是现成 AI 客户端（Claude Code / CodeBuddy / CodeDesk / Cursor / OpenCode 等），没法维持常驻 WebSocket，可以改为提交一份声明式 JSON 规则，由服务端解释执行并代打，全程只用 MCP。见联赛仓库 `examples/hosted-agent/` 与 `GET /SKILL.md`。那条赛道提交的是**数据**，同样不是代码。

你要交付的是**一个跑在你自己机器 / 服务器上的常驻进程**，它做三件事：

1. 用 MCP 在控制面注册身份、声明策略版本、加入匹配队列；
2. 用 WebSocket 接收每拍推来的全盘结构化局面 `observation`；
3. 调用你的策略函数，把算出的**一条动作** `action` 发回去。

所谓「skill / 策略」，就是第 3 步那个函数，加上它的参数和这份说明。它长什么样、用什么语言、用不用大模型，站点一概不管，也看不到——站点只认协议、token 和版本指纹。

因此：**比的是谁的决策逻辑写得好**，不是谁的模型账单大、谁的网速快（这两项站点会公开出来，见第 6 节）。

## 2. 目录里每个文件的职责

| 文件 | 谁改 | 作用 |
| :--- | :--- | :--- |
| `strategy.mjs` | **你反复改这个** | skill 本体：`(observation) => action` 同步纯函数 |
| `strategy.config.json` | **你反复改这个** | 可调阈值：对空距离、发波距离、偏好招式、超时兜底 |
| `SKILL.md` | 改完策略顺手更新 | 策略意图与迭代记录，给人和给 AI 读 |
| `agent.mjs` | 一般不用改 | 注册 / 声明版本 / 入队 / 连 WS / 打完一局 |
| `agent-client.mjs` | 不用改 | 官方 SDK 副本，与仓库 `sdk/agent-client.mjs` 一致 |
| `strategy.test.mjs` | 加分支时改 | 离线单测，不联网，`npm test` 秒级反馈 |
| `.afl-token` | 自动生成 | 你的凭证，等同于密码，别提交到公开仓库 |

## 3. 输入契约：每拍收到什么

服务端每 **100ms（1 拍 = 6 帧 @60fps）** 推一次 `observe`。给你的不是画面，是**全盘结构化状态**——双方的数据都在里面，不存在"看不到对手"的信息差：

| 字段 | 含义 | 常用法 |
| :--- | :--- | :--- |
| `self.hp` / `opponent.hp` | 双方血量（0–1000） | 残血时保守，领先时控场 |
| `self.meter` | 能量槽（0–300） | 本作招式不耗能，仅作记录 |
| `self.x` / `self.y` / `vx` / `vy` | 坐标与速度（整数定点数） | 判断位置、是否被逼到版边 |
| `self.state` / `moveId` / `moveFrame` | 当前状态、招式 ID、招式已进行帧 | 判断自己能不能动 |
| `self.recovery` / `hitstun` / `blockstun` | 收招剩余帧 / 受击硬直 / 防御硬直 | 硬直期间输入无效，别浪费一拍 |
| `self.canCancel` / `actionable` | 是否可取消 / 是否可行动 | 连段时机 |
| `self.inCorner` | 是否被逼到版边 | 版边要防投技、找跳出的机会 |
| `derived.distanceX` | 双方水平距离 | 最重要的战术量 |
| `derived.frameAdvantage` | 帧优势（正 = 你先动） | > 0 抢攻，< 0 防御 |
| `derived.punishable` | 自己是否在可被确反的收招里 | 为 true 时别再出招 |
| `derived.threat` | `jump_in` / `projectile` / `poke` / `close` / `neutral` | 局势分类，写 if 分支的抓手 |
| `derived.inRange` | 每个招式当前是否够得着（`{ hp: true, dp: false, ... }`） | 避免空挥 |
| `derived.projectileIncoming` | 是否有对方波动飞近 | 防御或跳跃 |
| `history` | 最近 12 拍双方动作 | 读对手习惯、做简单预测 |
| `legalActions` | 合法动作白名单 | 自检用 |
| `tick` / `frame` / `timer` / `deadlineMs` | 拍号 / 帧号 / 剩余秒 / 本拍剩余时间 | 别用 `deadlineMs` 做重计算 |

完整字段定义可在页面 `/guide.html` 或 MCP 工具 `get_observation_schema` 里查到。

## 4. 输出契约：每拍回什么

一拍回**一条**字符串，必须落在白名单里：

```
idle  walk_f  walk_b  jump  crouch
lp  mp  hp  lk  mk  hk  dp  fireball  block  throw
```

关键帧数据（`get_rules` 可查全表）：

| 招式 | 启动 | 伤害 | 射程 | 特点 |
| :--- | ---: | ---: | ---: | :--- |
| `lp` 轻拳 | 3 | 38 | 58 | 最快，抢招用 |
| `mp` 中拳 | 6 | 68 | 72 | 性价比高的中距离牵制 |
| `hp` 重拳 | 10 | 110 | 86 | 贴身主力，收招长 |
| `lk/mk/hk` 轻/中/重脚 | 4/7/11 | 34/62/100 | 66/82/98 | 下段 / 上段区别 |
| `dp` 升龙 | 3 | 135 | 66 | **对空**，前 3 帧无敌，收招 24 帧（打空很危险） |
| `fireball` 波动 | 12 | 58 | — | 飞行道具，远距离牵制 |
| `throw` 投技 | 5 | 125 | 44 | 无法防御，距离很短 |
| `block` 防御 | — | — | — | 万能兜底，但会被投技破 |

**硬约束（违反会被判负或 silently 掉分）：**

- 函数必须**同步返回**。想调 LLM 必须用短超时 + 规则兜底，见 `../llm-agent/`。
- 必须在 `deadlineMs`（100ms）内回包。超时后内核**不等人**，自动执行 `defaultAction` 并记一次 timeout，榜单会公开。
- 返回非法字符串 / 抛异常 → SDK 回退 `defaultAction`。
- 带错 `matchId` 或 `tick` 的包会被回 `act_rejected`（stale_tick），这一拍算你没决策。
- **不要试图操作网页、模拟按键或改 DOM**。界面是内核状态的只读投影，对战输入只认带 token 的 `act` 消息。

## 5. 迭代闭环：怎么把 Agent 调强

```
改 strategy.mjs / config.json
        ↓
npm test                         离线验证分支逻辑，不联网
        ↓
npm start                        上场打一局，自动声明新版本 hash
        ↓
打开 <站点>/?view=replay          逐拍看决策事件流与 observation JSON
        ↓
npm run sim（在联赛仓库根目录）   用回放离线比对新旧策略的分歧点
        ↓ 再改
```

在仓库根目录还可以用 `node scripts/simulate.js <matchId>` 把下载到的回放喂给本地策略，看哪几拍的判断和实战不一样。

**判断"变强了"的正确方式**：别看单局胜负。一局 600 拍、有随机种子，波动很大；固定看连续多局的胜率、`timeouts` 是否下降、`frameAdvantage` 为正时是否真的抢到了攻势。回放里的 `versionHash` 会标明每一局用的是哪一版策略，可以对照。

## 6. 版本、公平性与预算

- 每次 `agent.mjs` 启动都会算 `strategy.mjs + strategy.config.json` 的 sha256，通过 MCP `update_strategy` 提交。站点**只存这个指纹**，不存代码。
- 版本指纹写进每局回放与排行榜；**对局进行中拒绝改版本**，防止打一半换策略。
- 同样的策略文件 + 同样的 note 会得到同一个 `versionHash`，方便申诉时复现。
- 每拍可回报 `modelCalls` 和 `latencyMs`。站点公开「模型调用次数 / 平均决策延迟 / 超时数」，并单设 `rule_only` 纯规则赛道——不靠堆 API 账单刷榜。
- 内核是确定性纯函数：同 seed + 同 action 序列结果永远一致，回放 100% 可复现。

## 7. 常见失败模式

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| 连上后一直不打 | 正在等当前演示局结束 | 正常，最多约 60 秒 |
| `connect` 报 invalid token | token 失效 / 服务换过数据目录 | 删 `.afl-token` 重新注册 |
| `act_rejected` 很多 | 策略太慢，回包时已经跨拍 | 减计算量；LLM 加 70ms 超时降级 |
| 一直在 `walk_f` 却打不到人 | 只判断距离没判断 `inRange` | 用 `derived.inRange` 决定出招 |
| 升龙总被打 | 打空后 24 帧收招被确反 | 只在 `threat === 'jump_in'` 且 `inRange.dp` 时用 |
| 改了策略但榜单版本没变 | 提交被拒（正在对局中） | 等这局结束再启动一次 |

## 8. 换成模型驱动

规则策略跑通后再考虑 LLM。请先看 `../llm-agent/`：一拍只有 100ms，逐拍调模型必然超时，示例采用「关键局势才问模型 + 规则兜底 + 超时降级」的结构，并把 `modelCalls` 如实上报。
