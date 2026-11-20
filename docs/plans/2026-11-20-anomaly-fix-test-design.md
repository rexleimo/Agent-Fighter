# 对局异常修复：测试范围契约与验收映射（ADD + 测试设计）

对应 spec：`docs/plans/2026-11-20-agent-fight-anomaly-fix-spec.md`
日期：2026-11-20
Capability：`software.testing.design`（activation `1e3b3831-a068-40a8-b2fc-0a7d96bdd3ee`）

## 1. 测试范围契约

- **用户目标**：修复观战回放中 6 类真实异常（空挥 C、静默待机 D、站桩平局 E、匹配锁死 F、近战发波 A、不会闪避招架 B），全部由内核/协议/匹配真实行为验证，不靠文档勾选。
- **非目标**：不改命中判定公式（`hitboxesFor × hurtboxesFor` 的 AABB）；不改 `ACTIONS` 顺序；不改 `moveFor` 语义；不把单人天梯从镜像 `quartz` 改成各用角色（spec §8 范围外）；不迁移已存在 agent 的 `defaultAction`。
- **范围内行为**：`derived.inRange.*` 的预测命中；按 archetype 的动作锁定；对手起手/收招预测字段；兜底可见性计数；消极判罚与四级时间到判定；匹配对手打分/复赛暂缓/陪练抑制/默认观战轮换。
- **范围外行为**：AI 模型质量、前端像素级样式、网络传输、新增第二套距离模型。
- **允许修改的测试缝**：4 个新增可执行脚本 `scripts/verify-{reach,locks,stall,pairing}.mjs`（公共入口：`engine.js`/`protocol.js`/`rooms` 能力）；现有 `verify-combat/ladder/team`；`src/data/replays/*.jsonl` 只读回放校验；`get_observation_schema`/`get_rules` 数据接口。
- **完成判据**：spec §6 六条 + §5 全部门禁 + 4 个新脚本全绿 + 2.1 回放 stateHash 逐帧一致 + `/review` 无未处理项。

## 2. 验收行为 → 可观察断言（行为而非调用次数）

| 编号 | 验收行为（用户可观察） | 公共入口/场景 | 断言 | 证据脚本 |
|---|---|---|---|---|
| A1 | `inRange[m]` 为 true 时该招在真实盒子上命中 | 全 roster × 全攻击招，最大 true 距离实测 | true 距离命中率 100%；false 最小距离 0 命中 | `verify-reach.mjs` |
| A2 | 历史回放出招时 `inRange` 真却空挥 | `src/data/replays/*.jsonl` 重放统计 | 比例 = 0 | `verify-reach.mjs` |
| B1 | 近战角色发不出 `fireball` | rush/counter/antiAir 角色跑全量发波脚本 Agent | `input_locked` 事件数 == 发波出招数；无 fireball 命中 | `verify-locks.mjs` |
| B2 | 被锁动作不静默替换 | 同上 | 被锁拍按 idle 处理，记 `rejected.action_locked` | `verify-locks.mjs` |
| C1 | 规则全不匹配时报告指出兜底 | 训练场无匹配策略 | `fallback_overused` finding + 具体拍号 | `verify-ladder.mjs` / 训练报告 |
| C2 | 超 8 次调用结算暴露预算拒绝 | 外部 Agent 回放超预算 | `budgetExceeded > 0` 且 `rejected.model_budget_exceeded` | 结算结构单测 |
| D1 | 对手起手可读 | `get_observation_schema` vs `buildObservation` 逐字段 | 新增 `derived.*` 5 项全部声明；已有 17 键不缺声明 | schema 一致性检查 |
| E1 | 双方全程不出手 → 双负 | `runMatch(block vs block)` | `winner='double_loss'`、`reason='time_up_stall'`、双方 `stall_penalty>0` | `verify-stall.mjs` |
| E2 | 积极方胜、消极方被罚 | block vs (walk_f+lp) | 积极方胜；消极方有 `stall_penalty` | `verify-stall.mjs` |
| E3 | 防对手进攻不算消极 | fireball vs 持续 block | 防守方不被判消极 | `verify-stall.mjs` |
| E4 | 2.1 回放逐帧复现 | 20 个 2.1 replay 重放 | `stateHash` 全部一致 | `verify-stall.mjs` + `verify-ladder.mjs` |
| F1 | 4 Agent 48 场覆盖全部组合 | 4 注册 Agent 错峰开局 | 6 种组合各 ≥4 次；连遇同对手 ≤20%；被派陪练 0 次 | `verify-pairing.mjs` |
| F2 | 2 Agent 复赛不卡死 | 2 人场景 | `REMATCH_HOLD_MS` 后正常复赛 | `verify-pairing.mjs` |

## 3. 测试缝与最小纵向切片

- **稳定公共入口**：`engine.js` 的 `createMatch/runMatch/replayMatch`、`protocol.js` 的 `buildObservation/OBSERVATION_JSON_SCHEMA`、`rooms` 能力的 `matchmake/presence`、各 `verify-*.mjs` 脚本。这些是内核对外边界，隔离风险且不依赖私有字段。
- **最小纵向切片**：E 类用一次 `runMatch(block, block)` 全程跑满即可同时证明消极计数、时间到链、事件产出、双负结果——这是能独立失败又足以代表"站桩拿平局"的最短路径。
- **禁止假通过**：不得删除/跳过/放宽断言；不得只测 mock；`predictsHit` 必须用真实 `hitboxesFor×hurtboxesFor×overlap`；回放兼容必须用真实历史 replay 文件逐帧比对 stateHash，不得用当前代码自产回放自证。

## 4. RED 候选（behavior-delta）

- 公共入口：`runMatch({ policyA: ()=>'block', policyB: ()=>'block' })`（engine.js）
- setup：seed 7，双方全程 `block` 直到 600 tick 时间到
- 精确命令：`aios rex receipt --root <repo> -- node --input-type=module -e "import { runMatch } from './src/engine.js'; ... assert winner==='double_loss' && reason==='time_up_stall'"`
- 预期：`winner='double_loss'`、`reason='time_up_stall'`
- 实际观察：`{"winner":"draw","reason":"time_up"}`，进程 exit 1
- 失败原因：时间到判定链只比 hp；hp 相等直接 `draw`，双方全程不出手必然平局
- **receiptRef**：`receipt:c2ceced7-fbec-4bf0-9afe-344f7977da85`（真实执行回执，exit 1）

## 5. 否定条款与既有 sediment

- 完成判据以 spec §6 六条为准，缺任一执行证据不得勾选；
- 不得把"文档已更新"当作"行为已修复"；
- 既有 sediment：本仓库已有 `verify-combat.mjs`（76 项绿）、`verify-ladder.mjs`（38 项绿），作为回归基线；用户对 scoring/offense 的未提交文档改动（`README.md`/`SKILL.md`/`class-training.js`）属于既有工作，实施时在其之上增量，不覆盖。

## 6. 实施中发现的 spec 与真实代码偏差（已在实施中修正，记录于此）

1. `submit_strategy` 校验在 `class-agents.js:166`，不在 `protocol.js:280`；`rooms/room.js` 不调用 `validateStrategy`。
2. 动作→招式转换在 `engine/fighter.js` 的 `startMove/tickFighter`，不在 `step.js`；`step.js` 只做 `validateAction`。
3. `predictsHit` 探针必须重置 `hasHit/spentHit/hitIds/spentHitIds`，否则命中后预测恒为 false。
4. 新字段必须经 `src/combat.js` 再导出，`protocol.js` 才能 import。
5. `OBSERVATION_JSON_SCHEMA.derived` 当前就漏声明 4 个既有键，任务 4 的一致性检查须先补齐基线。
6. 回放重放 `renderReplay/replayMatch` 绕过 `createMatch`，必须从 `replay.rulesVersion` 派生 `antiStall`，否则 2.2 新规则不生效、2.1 回放哈希失配。
7. 无现成版本比较函数，需新增 `versionAtLeast(v,'2.2')`。
8. `block` 的内核状态名是 `guard`；`team.js:110` 是 `double_loss` 的第二个崩溃点（spec 只提 `:104`）。
9. 前端 `queued` 项在 `presence()`（`manager.js:192-204`）构造，不在 `broadcastRooms()`。
10. 历史 replay 的对手 id 已存在于 `this.matches`（`m.a.id/m.b.id`），无需为配对强依赖新增 history.opponentId（仍按 spec 补上作为可观测字段）。
