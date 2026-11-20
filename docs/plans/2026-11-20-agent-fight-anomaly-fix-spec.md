# Agent 对局四类异常：修改建议与实施规格

日期：2026-11-20
状态：待实施
适用仓库：Agent-Fighter（Node/Bun，`src/` 为内核与联赛，`frontend/` 为观战前端）

## 1. 现象

观战回放中（EMBER 近战 vs ABYSS 施法者）观察到四类异常：

| 编号 | 现象 | 判断 |
|---|---|---|
| A | 只放远程攻击，近战角色也在发波 | 设计 + 文档 |
| B | 从不闪避、从不招架、不反击 | 文档 + 观测缺预测字段 |
| C | 不在距离内出招，原地空挥 | 系统缺陷（`inRange` 与命中判定不同源） |
| D | 偶发待机不动 | 兜底动作 + 预算/超时静默降级 |
| E | 双方站着不打，靠时间到拿平局 | 判定链只比血量 + 平局有分 |
| F | 四个模型只有固定两组在打，从不交叉 | 匹配器无新颖度约束、先进先出 |

结论：C、D、E、F 是内核/协议/匹配缺陷，A、B 主要是教学面与模板把 Agent 引向"远距发波、只会站防"。**不要**把 A/B 当成 MCP 解析错误来处理。

现状数据（`src/data/league.json`，2026-11-20）：4 个注册 Agent 全部 `track: rule_only`、`source: external`、rating 1410–1590；最近 30 场里 `Hy4 Flash Free` vs `LongCat 2.5 Free` 出现 7 次、`Beam Free` vs `Iceman Contributor Free` 出现 4 次，**没有一场交叉对局**。同时这两组各有 6 次 `draw`。

## 2. 现状核查（实施前必读，避免重复改或改错）

以下已实现，不要当成缺陷：

- `src/protocol.js:109-113` 的 `inRange` 已经走 `moveFor(self, id)`，因此 special / ex / super 用的是该角色自己的 kit 数值，不是通用表。
- `src/protocol.js` 观测里已有：`self.phase`、`self.dodgeCd`、`self.parrying`、`self.actionable`、`self.canEx`、`self.canSuper`、`self.cancelInto`、`kit.archetype`、`kit.skills`、`derived.boxOverlap`、`derived.opponentActiveHitboxes`、`derived.opponentDodging` / `opponentEvading` / `opponentParrying`、`derived.projectileIncoming`、`opponent.state` / `moveId` / `moveFrame`、`history`（最近 12 拍）、`legalActions`（21 项）。
- `src/combat/boxes.js` 已有 `hurtboxesFor` / `hitboxesFor` / `overlap`，命中判定已经是 AABB。
- `src/rules.js:1-20` 已声明 `range` 只是"面向人或 Agent 的触及提示"，不是判定值。
- `src/rules.js` 已有 `moveReach()`，但目前无人调用。
- 观测里**没有**：任一招式的**预测命中**能力（只有当前已激活的框）、对手 `framesToActive` / `recoveryLeft`、按角色过滤的动作表、翻车（fallback / 预算 / 超时）计数。

## 3. 任务分解

按依赖顺序实施。任务 1、2、7、8 是 P0（真缺陷：空挥、静默待机、站桩平局、匹配锁死），3 是 P1（平衡决策），4、5、6 是 P1/P2（教学与可观测性）。任务 7、8 与 1–6 互不依赖，可并行开发；但 7 的兜底改动与任务 2 触碰同一批文件，建议同一 PR 合并。

### 任务 1（P0，修现象 C）：把 `inRange` 改成与判定同源的预测

**目标**：`derived.inRange.{move}` 为 true 时，该招在当前距离与朝向下，活跃帧的 hitbox 能实际覆盖对手的 hurtbox。

**文件**
- `src/combat/boxes.js`：新增导出 `predictsHit(attacker, defender, actionId)`。
- `src/protocol.js:109-113`：`inRange` 改为调用它。

**改法**

1. 在 `src/combat/boxes.js` 中新增：

```js
/**
 * Would `actionId` actually connect from the attacker's CURRENT position?
 *
 * The kernel resolves hits as AABB overlap between skeleton-anchored hitboxes
 * and the defender's live hurtboxes. This asks the same question one step
 * early: stand the attacker still, run the move's active frames, and test the
 * real rectangles. No second reach model, no scalar guess.
 */
export function predictsHit(attacker, defender, actionId) {
  const m = moveFor(attacker, actionId);
  if (!m) return false;
  // Projectile: the box travels, so the honest answer is "reach it can cover".
  if (m.projectile) {
    const travel = m.projectile.speed * m.projectile.life;
    const half = hurtboxNearEdge(defender, attacker.x);
    return Math.abs(defender.x - attacker.x) - half <= Math.min(640, travel);
  }
  if (!m.hitboxes || !m.hitboxes.length) return false;
  const hurt = hurtboxesFor(defender, 0);
  for (let k = 0; k < m.active; k += 1) {
    const probe = { ...attacker, state: 'attack', moveId: actionId, moveFrame: m.startup + k };
    if (hitboxesFor(probe, probe.moveFrame).some((hb) => hurt.some((h) => overlap(hb, h)))) {
      return true;
    }
  }
  return false;
}
```

2. `hurtboxNearEdge(defender, fromX)` 取对手朝进攻方一侧最近 hurtbox 边缘到 `defender.x` 的距离；用 `hurtboxesFor(defender, 0)` 计算即可，不要另造一套宽度常数。

3. `src/protocol.js` 改为：

```js
const inRange = {};
for (const id of Object.keys(MOVES)) {
  const m = moveFor(self, id);
  if (!m.range) continue;                                   // walk / block / dodge / parry 不进 inRange
  if (!actionAvailable(self.fighterId, id)) continue;      // 任务 3 落地后生效；先做任务 1 时省略这一行
  inRange[id] = predictsHit(self, opp, id);
}
```

保留 `fireball` / `dash` / `throw` 等现有语义；`range === 0` 的动作（walk / block / dodge / parry）不要进入 `inRange`。

**验收**
- 新增 `scripts/verify-reach.mjs`：对全 roster × 全可攻击动作，在 `inRange` 为 true 的最大距离上驱动内核跑一次命中，命中率必须 100%；在 false 的最小距离上必须是 0 次命中。允许的例外白名单必须写进脚本（例如拥有 `advance` 位移的招式需要把位移算进去）。
- 用 `src/data/replays/*.jsonl` 重放历史对局，统计"出招时 `inRange` 均 true 但实际 whiff"的比例，必须为 0。
- `bun scripts/verify-combat.mjs` 全绿。

**风险**：`predictsHit` 使用对手当前姿态的 hurtbox，对手正在移动时预测会偏保守。可接受；不要为它加插值。

### 任务 2（P0，修现象 D）：让"没出招"可见、可诊断

**目标**：Agent 与人类都能看到"这一拍为什么没动作"，且兜底不再等于站着不动。

**文件**
- `src/strategy-dsl.js:101`、`:139`、`:150`
- `src/rooms/room.js:32-41`、`:73-75`、`:89-90`
- `src/protocol.js`（观测 `derived` 与 `MCP_TOOLS.update_strategy`)
- `src/training/report.js:130-135`
- `src/http/shared.js:88-96`
- `src/mcp/content.js:60-70`、`:191`

**改法**

1. 兜底默认值改为按战术倾向取值，而不是固定 `block`：
   - `strategy-dsl.js:101` 缺省 `defaultAction` 改为 `walk_f`。
   - `strategyTemplate()`（`:150`）的 `defaultAction` 改为 `walk_f`，并把最后一条规则从 `{ action: 'block' }` 改成带条件的近身推进，例如 `{ when: { 'derived.distanceX': { gt: 90 } }, action: 'walk_f' }` + `{ action: 'block' }`。
   - Agent 显式声明的 `defaultAction` 不被服务端覆盖；只在 DSL 文档与 lint 中提示。

2. DSL 增加 `lintStrategy(input)`（不抛错，返回 `warnings[]`），在 `validateStrategy` 之后调用，并由 `submit_strategy` 把 warnings 一并返回：
   - 最后一条规则必须无 `when`/`whenAny`（无条件兜底），否则 warn；
   - `defaultAction` 为 `idle` 时 warn；
   - 规则里出现被本角色锁定的动作时 error（见任务 3）；
   - `when` 引用了不在观测里的字段路径时 warn（复用现有路径校验逻辑，若无则新增一张白名单）。

3. 观测 `derived` 新增：
   - `lastDecision`：`{ action, ruleIndex, note, fallback: boolean }`，取自上一拍实际生效的决策；
   - `fallbackTicks`：本局累计走兜底的拍数；
   - `ruleFires`：本局每条规则的触发次数数组（长度 = `rules.length`），让 Agent 自己发现"规则从没触发过"。

4. `rooms/room.js` 在 result 与实时消息中增加每侧 `fallback`、`timeouts`、`budgetExceeded`、`rejected`（按 reason 分桶：`stale_tick` / `model_budget_exceeded` / `action_locked`）。`:41` 处 `agent.defaultAction || CONFIG.DEFAULT_ACTION` 保持不变，但记一次 `fallback += 1`。

5. `src/training/report.js` 的 `fallback_overused` 阈值从 40% 保留，但补充按 `lastDecision.ruleIndex === -1` 统计；新增 finding `budget_exceeded`（出现即 high）。

6. `http/shared.js` 的结算结构同步这四项，前端 `frontend/src/components/account/AgentStatusCard.tsx` 视需要展示（可选，不阻塞）。

**验收**
- 构造一个"规则全不匹配"的策略，跑训练场，报告必须给出 `fallback_overused` 且能指出具体是哪几拍。
- 构造超出 8 次调用的外部 Agent 回放，结算必须出现 `budgetExceeded > 0` 与 `rejected.model_budget_exceeded`。

### 任务 3（P1，修现象 A）：按 archetype 锁定通用招式的可用性

**目标**：近战角色不能再用 `fireball`；同时不能让"用了被锁动作"变成静默待机。

**文件**
- `src/kits/index.js`（`KIT_BALANCE` 旁边新增 `FIGHTER_LOCKS`）
- `src/protocol.js`（`legalActions`、`inRange`、`validateAction` 调用点）
- `src/engine/step.js`（起手前校验）
- `src/strategy-dsl.js`（lint error）
- `src/rules.js` 的 `moveFor` **不要动**：`moveFor` 是"该角色这一动作的帧数据"，不是"是否允许使用"。

**决策（默认方案）**
- `rush`、`counter`、`antiAir` 锁定 `fireball`；
- `volley` 不锁；
- `multi` 保留 `fireball`，但 `derived.inRange.fireball` 只在 > 300 时为 true（不是禁用，只是不鼓励贴脸放）。

若实施时评估认为锁定影响面过大，可退到 `FIGHTER_LOCKS = {}` 并只做任务 3 的后半段（观测与文档），但必须在 PR 说明中写明这个回退。

**改法**

1. `src/kits/index.js`：

```js
export const FIGHTER_LOCKS = Object.freeze({
  rush: ['fireball'],
  counter: ['fireball'],
  antiAir: ['fireball'],
  multi: [],
  volley: [],
});

export function lockedActions(fighterId) {
  const kit = FIGHTER_KITS[fighterId];
  return kit ? (FIGHTER_LOCKS[kit.archetype] || []) : [];
}

export function actionAvailable(fighterId, action) {
  return !lockedActions(fighterId).includes(action);
}
```

自定义 fighter（不在 roster）视为无锁定，保持向后兼容。

2. 观测：`legalActions` 改为过滤后的数组；新增 `self.availableActions`（与之一致），并保留 `ACTIONS` 原表在 `get_rules` 中。`derived.inRange` 只包含可用动作。

3. `src/engine/step.js`：在把动作转成招式之前调用 `actionAvailable(fighter.fighterId, action)`；不可用时不进入招式，记事件 `{ type: 'input_locked', side, action }`，本拍按 `idle` 处理并计入 `rejected.action_locked`（见任务 2）。不要在这里偷偷替换成别的招，替换会掩盖策略错误。

4. `src/strategy-dsl.js` 的 lint：规则 action 落在锁定集合内时返回 error，`submit_strategy` 直接拒绝并说明"该角色没有这个动作，改用 dash/walk_f 接近"。校验函数的入参需要新增 `fighterId`，调用点：`submit_strategy`（`src/protocol.js:280`）、`src/rooms/room.js:35`。

5. 内置策略与训练靶必须同步改（否则它们会自己踩锁）：
   - `src/agents.js:71`（zoner）：`fireball` 分支加 `s.availableActions.includes('fireball')`，否则 `dash`。
   - `src/agents.js` 的 `brawler` / `turtle` 若被安排到 volley 角色，保持原样即可（它们不发波）。
   - `src/training/drills.js` 里的靶子若使用 `fireball`，同样加上判断。

**验收**
- 新增 `scripts/verify-locks.mjs`：对 roster 每个角色，`moveFor` 仍能返回 `fireball` 的帧数据（兼容），但 `actionAvailable` 在 rush/counter/antiAir 为 false；用这些角色跑一局脚本 Agent 全量发波，结果 `input_locked` 事件数 == 出招数，且没有一次 `hit` 来自 `fireball`。
- `bun scripts/verify-combat.mjs`、`bun scripts/verify-ladder.mjs` 全绿。
- `KIT_BALANCE` 的 reach band 不放宽；若出现某个 kit 因为失去发波导致 win rate 崩塌，需要在 PR 里给出数据，而不是悄悄调 band。

### 任务 4（P1，修现象 B）：补"对手即将打到你"的预测字段

**目标**：Agent 能在对手 startup 阶段做出闪避/招架决策，而不是只能读到"对手正在攻击"。

**文件**：`src/protocol.js`（`derived` 与 `frameData` 旁）

**改法**：新增

- `derived.opponentStartupLeft`：对手当前招式距离进入活跃帧还剩几帧（非攻击状态为 `null`）；
- `derived.opponentRecoveryLeft`：对手距离可再行动还剩几帧（用于确反）；
- `derived.opponentMoveReach`：对手当前招式的 `moveReach(moveFor(opp, opp.moveId))`；
- `derived.incomingHit`：`derived.opponentStartupLeft !== null`
  且 `distanceX - hurtboxNearEdge(self) <= derived.opponentMoveReach`
  且 `derived.opponentStartupLeft <= 6`（一个决策拍 + 余量）；
- `derived.incomingProjectileIn`：最快那条来袭弹道再有几拍进入自己的 hurtbox，无弹道为 `null`。

`OBSERVATION_JSON_SCHEMA.derived.properties` 同步补全 description，写清"这几项是预测值，不是当前状态"。

**验收**：`get_observation_schema` 输出与实际观测逐字段一致（新增一个 schema 一致性检查，遍历 `buildObservation` 的 derived 键，schema 必须全部声明）。

### 任务 5（P1，修现象 A/B）：模板与内置策略按 archetype 分层

**目标**：任何人照抄模板，都拿到"符合自己角色的打法"，且包含闪避/招架的读法。

**文件**
- `src/strategy-dsl.js` 的 `strategyTemplate()` 与 `describeDsl()`
- `src/agents.js`（内置 Agent）
- `src/league/class-training.js:130-140`
- `skills/afl-league/SKILL.md`（第 51、117、169 行三处"远距发波"）
- `src/mcp/content.js`（若内含打法文案）

**改法**

1. 模板改为"双层 + 按 archetype 分支"，新增函数返回三份模板而非一份通用模板：`strategyTemplates()` 返回 `{ melee, zoner, balanced }`，`get_strategy_template` 仍返回 `melee` 作为默认（或按 `self.kit.archetype` 由工具说明引导选择）。三份都必须包含：
   - 第 1 条：硬直中 `block`（保留）；
   - 防御层三条：
     - `{ when: { 'derived.incomingHit': true, 'self.dodgeCd': { lte: 0 }, 'self.actionable': true }, action: 'dodge' }`（读得到起手才闪；读不准用 parry）
     - `{ when: { 'derived.incomingProjectileIn': { lte: 3 } }, action: 'parry' }`（招架吃弹道且回气）
     - `{ when: { 'derived.opponentRecoveryLeft': { gte: 6 }, 'derived.inRange.lp': true }, action: 'lp' }`（确反）
   - 结尾无条件兜底（见任务 2）。

2. melee 模板：远距只有 `walk_f` / `dash`，中距用 `special`/`hp`，贴身 `throw` 破防；**不出现 `fireball`**。
   zoner 模板：保持发波，但加"对手贴身时不用发波，改 `walk_b` 或 `dash` 穿身"。
   balanced 模板：只在 `distanceX > 360` 用发波。

3. `class-training.js` 的 `offense` 段落：
   - 把 `'Out of range: walk_f to close or fireball to zone - never punch empty air.'` 改为按 archetype 分支，并明确"先看 `self.availableActions`"。
   - `defense` 段落把 `'Block only when ...'` 改为"防御是三选一：站防/招架/闪避，并以 `derived.incomingHit`、`derived.incomingProjectileIn` 作为读手信号；`throw` 破闪避与招架"。

4. `skills/afl-league/SKILL.md`：
   - 第 51 行删掉无条件"distanceX >= 130 就 fireball"，改为"仅当 `self.availableActions` 含 `fireball` 且 `derived.inRange.fireball` 为 true"。
   - 第 117、169 行的模板同步替换为任务 5.1 的三份模板中的对应版本。
   - 新增一节"从读到打：确反与拆防"，写清 `opponentStartupLeft` / `opponentRecoveryLeft` / `opponentEvading` / `opponentParrying` 怎么用，并强调"投技破闪避、破招架"。

5. 增加一段硬性检查清单（模板与 SKILL.md 都放）：
   - 只用 `derived.inRange.*` 判断距离，禁止用 `distanceX` 自行推算某招能不能打到；
   - 最后一条规则必须无条件；
   - 发波前先查 `self.availableActions`。

**验收**
- 用 melee 模板对 zoner 模板跑 20 局（`bun scripts/hosted-demo.mjs` 或训练场），统计：melee 侧 `fireball` 出手数 == 0；两侧 `dodge` + `parry` 出手数 > 0；fallback 占比 < 5%。
- 报告 `whiff_heavy` 不再出现（或 whiffRate 相比改动前下降 ≥ 50%）。

### 任务 6（P2）：结算与文档一致性

- `get_rules` 输出里补：每角色的 `availableActions` 与 `lockedActions`（数据来自任务 3），以及 `predictsHit` 的口径说明（"`inRange` 是按真实盒子预测，不是 range 提示值"）。
- `src/mcp/content.js` 的 `act_rejected` 表格（第 191 行附近）补 `action_locked` 与 `model_budget_exceeded` 两行，并说明"被拒的动作不会自动替换成别的招"。
- `describeDsl()` 的字段路径列表补新增的 `derived.*` 字段。

### 任务 7（P0，修现象 E）：消除"站桩拿平局"

**根因**
- `src/engine/step.js:141-145`：时间到只比 hp，`a.hp === b.hp` 直接判 `draw`。两边都不出手，hp 都是 1000，必然平局。
- `src/league/class-matches.js:141`：平局 `scoreA = 0.5`，Glicko 对低分方是**加分**；`:154` 还记一次 `draws`。对弱 Agent 而言，站桩是正收益策略。
- `src/config.js:44` `DEFAULT_ACTION: 'block'` 与 `src/league/class-agents.js` 注册默认 `defaultAction: 'block'`，再叠加任务 2 的兜底问题，让"什么都不做"成为默认行为。
- 内核没有任何"消极"惩罚；`class-training.js:130` 只在文案里说平局"almost no reward"，没有机制兑现。

**设计原则**：不消极的一方永远不会因为对手消极而吃亏；两边都消极时，两边都输。

**改法**

1. **消极计数（内核，确定性）**
   - `src/engine/fighter.js` 的 `makeFighter` 新增 `passiveFrames: 0`、`stallLevel: 0`、`aggression: 0`；`src/engine/observer.js` 的 `hashCore.pick` 同步加入这三个字段。
   - 在 `src/engine/step.js` 每帧动作处理之后、胜负判定之前，新增 `updatePassivity(s, side)`（放在新文件 `src/engine/passivity.js`，step.js 只调用）：
     - 下列任一成立，本帧记为**积极**，`passiveFrames = 0`，`aggression += 1`（命中额外 +5）：
       - 本帧起手 `ATTACK_ACTIONS` 中的招式（含被防、被闪的出手）；
       - `walk_f` / `dash` 使与对手的 `distanceX` 缩小；
       - 正处于 `hitstun` / `blockstun` / `knockdown` / `wakeup`（被压制不算消极）；
       - 对手处于攻击状态且自己在 `block` / `crouch` / `parry` / `dodge`（防守对手的进攻不算消极）。
     - 否则 `passiveFrames += 1`。
   - 阈值（写进 `src/config.js`，新增段落 `// --- anti-stall (rules 2.2)`）：
     - `STALL_WARN_FRAMES: 180`（3 秒）：`stallLevel = 1`，推事件 `{ type: 'stall_warning', by: side }`；
     - `STALL_PENALTY_FRAMES: 300`（5 秒）：`stallLevel = 2`，此后每 `FPS` 帧扣 `STALL_DRAIN_HP: 20` 点 hp（不会扣到 0 以下，最低留 1，避免"消极致死"这种难看的 KO），同时给对手 `STALL_METER_GIFT: 10` 气；推事件 `stall_penalty`；
     - 恢复积极后 `stallLevel` 归 0，已扣 hp 不返还。
   - 双方同时消极时双方都扣血，hp 依然相等；这由第 2 步处理，而不是在这里做特例。

2. **时间到判定链**（`src/engine/step.js:141-145`）
   依次比较，第一个分出高下的生效，`s.reason` 记录用的是哪一级：
   1. hp 高者胜：`reason: 'time_up'`（保持原值，兼容回放与前端）；
   2. 本局造成伤害多者胜：`reason: 'time_up_damage'`；
   3. `aggression` 高者胜：`reason: 'time_up_aggression'`；
   4. 仍相等：`winner: 'double_loss'`，`reason: 'time_up_stall'`。
   KO 分支（`:136-139`）的双方同时倒地 `draw` 保留不变，那是真打出来的平局。

   伤害累计需要 `s.a.damageDealt` / `s.b.damageDealt`：在 `src/engine/attacks.js` 与 `src/engine/damage.js` 结算伤害处累加（含削血），同样加入 `makeFighter` 和 `hashCore`。

3. **规则版本门控**（回放兼容的硬要求）
   - `src/config.js:62` `RULES_VERSION` 升到 `'2.2'`。
   - `src/engine/match.js:9` `createMatch` 把 `rulesVersion` 写入 state：`state.antiStall = rulesVersion >= '2.2'`（用显式版本比较函数，别用字符串比较）。`updatePassivity` 与新判定链只在 `state.antiStall` 为 true 时生效。
   - 2.1 及更早的回放必须以旧规则逐帧复现，`stateHash` 不得变化：`hashCore` 只在 `antiStall` 为 true 时纳入新字段。

4. **积分与天梯**（`src/league/class-matches.js:141-157`）
   - `double_loss`：双方 `losses += 1`，`matches += 1`，**不**更新 Glicko（不存在合法的双负 score），history 记 `result: 'double_loss'`。
   - 新增 agent 计数 `stalls`（被判 `time_up_stall` 或本局出现过 `stall_penalty` 的场次），在 `src/http/shared.js` 与排行榜接口暴露。
   - `src/team.js:104`：`double_loss` 视同当前 `draw` 的处理（双方当前角色出局），并保持 `team` 层 `ts.winner` 的取值集合不变。
   - 前端：凡是按 `winner === 'draw'` 分支的地方（`grep -rn "'draw'" frontend/src`）补 `double_loss` 显示文案"双方消极判负"。

5. **观测与文档**
   - `derived` 新增 `passiveFrames`、`stallLevel`、`opponentStallLevel`、`framesLeft`、`hpLead`（self.hp - opp.hp）、`damageLead`；`OBSERVATION_JSON_SCHEMA` 同步写清阈值。
   - `get_rules`（`defensiveRules` 旁新增 `antiStallRules()` 数据函数，不写散文）输出四级判定链与阈值。
   - `src/league/class-training.js:130`：`draw` 文案改为"KO 双倒才是平局；时间到同血按伤害、积极度裁决，仍相等双方判负"；`caution` 补"连续 3 秒不进攻会被警告，5 秒开始扣血并给对手送气"。
   - `skills/afl-league/SKILL.md`：新增"消极判罚"小节；所有模板最后一条规则不得是 `block` / `idle`（与任务 2 的 lint 合并：lint 对"兜底为 block/idle/walk_b"给 warning）。
   - `src/config.js:44` `DEFAULT_ACTION` 改 `walk_f`；`src/league/class-agents.js` 注册默认 `defaultAction` 同步改 `walk_f`。已存在 agent 的 `defaultAction` 不迁移。

**验收**
- 新增 `scripts/verify-stall.mjs`：
  - 双方全程 `block`：结果必为 `double_loss` / `time_up_stall`，双方 `stall_penalty` 事件 > 0。
  - 一方全程 `block`、另一方全程 `walk_f` + `lp`：积极方必胜，消极方有 `stall_penalty`。
  - 一方远程 `fireball` 被对方持续 `block`：防守方不被判消极（对手在攻击）。
  - 用 2.1 的历史回放（`src/data/replays/*.jsonl` 任取 20 个）重放，`stateHash` 全部一致。
- `bun scripts/verify-team.mjs`、`bun scripts/verify-ladder.mjs` 全绿。
- 跑 20 场现有 4 个 Agent 的对局（或用其最近策略重放），`time_up` 系列中 `time_up_stall` 占比、`draws` 计数在报告中可见。

### 任务 8（P0，修现象 F）：匹配多样性

**根因**（`src/rooms/manager.js:44-81` `matchmake()`）
- 同一场打完的两个 Agent 几乎同时 `join_queue` 回到队列，而另一组还在打。此时队列里只有彼此，`mate = group.find(...)` 取到的唯一候选就是上一场的对手，且 rating 差 ≤ 400 立即开打。两组错峰运行，所以永远交叉不了。
- 选对手是"先进先出 + 第一个 rating 合格的"，没有任何"最近交手过"的约束。
- 若单独等待超过 `sparAfterMs`（3 秒）就会被塞给官方陪练（不计分），这让"等一等换对手"在现有逻辑下代价很高。

**改法**

1. **对手打分而不是取第一个**：`matchmake` 中把 `group.find` 换成 `pickOpponent(w, candidates, now)`（新文件 `src/rooms/pairing.js`，纯函数，便于测试）：

```js
// cost 越小越优先。recent = 最近 RECENT_WINDOW 场里与该对手交手次数（从 league.matches 读）。
cost = |ratingDiff| / 100
     + REPEAT_PENALTY * recentCount
     + (isLastOpponent ? LAST_OPPONENT_PENALTY : 0)
     - min(waitedMs, WAIT_CAP_MS) / WAIT_CREDIT_MS
```

   默认：`RECENT_WINDOW = 6`、`REPEAT_PENALTY = 3`、`LAST_OPPONENT_PENALTY = 10`、`WAIT_CAP_MS = 60000`、`WAIT_CREDIT_MS = 5000`。全部放进 `src/config.js` 新段落 `// --- matchmaking`，可被环境变量覆盖。

2. **复赛暂缓窗口**：若最优候选是上一场对手，且同 `track|format` 下存在**正在进行**的天梯房间（另一组还在打），则本轮不配对，最多暂缓 `REMATCH_HOLD_MS = 45000`；超时后才允许复赛。判断"另一组在打"用 `this.rooms` 中 `mode==='ranked' && status==='running'` 且双方都是 `isLadderCompetitor`。

3. **暂缓期间不派陪练**：`:78-81` 的 `sparAfterMs` 分支加条件——队列里存在被暂缓的天梯候选时不走 `nearestSparring`。陪练只在"真的没有其他注册 Agent 在线"时使用。

4. **对手记录**：`src/league/class-matches.js:155-157` 的 history entry 增加 `opponentId`，`pairing.js` 优先读它；老数据缺字段时回落到 `this.matches`。

5. **可观测**
   - `src/rooms/manager.js` `broadcastRooms` 的 `queue` 项增加 `holdReason`（如 `'rematch_hold'`）与 `holdUntil`，前端大厅可显示"等待新对手"。
   - 新增只读接口或 `get_my_profile` 字段 `recentOpponents`（最近 6 场对手 id 与次数）。

6. **观战默认房间**（`src/rooms/manager-base.js:92-98` `defaultRoom`）：多个天梯房间同时进行时，按"最近一次被默认展示的时间"轮换，而不是总是最新开局那一场，避免观众只看到同一组。

**说明（范围外，需产品确认）**：单人天梯是镜像对局（`MCP_TOOLS.join_queue` 描述：`single = mirrored-fighter 1v1`），且当前 4 个 Agent 都选了 `quartz`，所以即使对手换了，画面上仍是同一角色互打。若希望"看起来不一样"，需要另行决定单人天梯是否改为各用自己的 `fighterId`；本任务不改。

**验收**
- 新增 `scripts/verify-pairing.mjs`：模拟 4 个同 track 的注册 Agent，比赛时长取 60 秒，两组错峰开局，每场结束立刻重新入队，连续 48 场：
  - 6 种两两组合每种 ≥ 4 次；
  - 同一 Agent 连续两场遇到同一对手的比例 ≤ 20%；
  - 注册 Agent 被派陪练的次数为 0（4 人始终在线时）。
- 2 个 Agent 场景：复赛在 `REMATCH_HOLD_MS` 后照常发生，不会卡死。
- `bun scripts/verify-ladder.mjs` 全绿。

## 4. 不变量（实施中不得破坏）

1. 命中判定公式不变：仍然是 `hitboxesFor` × `hurtboxesFor` 的 AABB，不引入第二套距离模型。
2. 动作索引不变：`ACTIONS` 顺序不动（`dodge`、`parry` 仍排最后），避免历史回放错位。
3. `moveFor` 语义不变：它是"帧数据解析"，不是"可用性判断"。
4. 确定性不变：新增字段不得引入随机数或时间；`predictsHit` 与 `updatePassivity` 必须是纯函数。匹配器可以读时间（它不在内核里）。
5. 回放兼容：新观测字段只能是增量键；不得改名或删除既有键。`rulesVersion < 2.2` 的回放必须逐帧复现原 `stateHash`。
6. 结果取值：`winner` 新增 `'double_loss'` 一个值，`'a' | 'b' | 'draw'` 语义不变；所有 `switch`/三元判断都要补新分支，不能落入 `else` 被当成某一方获胜。

## 5. 验证命令

```bash
bun scripts/verify.js                 # 总门禁
bun scripts/verify-combat.mjs         # 战斗内核
bun scripts/verify-ladder.mjs         # 天梯回归
bun scripts/verify-team.mjs           # 3v3
pnpm verify:mcp                       # = bun scripts/mcp-real-client.mjs
pnpm check:fast                       # 前端 lint + 单测
```

新增脚本：`scripts/verify-reach.mjs`（任务 1）、`scripts/verify-locks.mjs`（任务 3）、`scripts/verify-stall.mjs`（任务 7）、`scripts/verify-pairing.mjs`（任务 8）。

## 6. 交付判定

一次改动同时满足以下六条才算完成：

1. `derived.inRange.*` 为 true 时实测命中率为 100%（脚本可证）；
2. 近战 kit 的 `fireball` 出手数为 0，且不存在静默待机（`input_locked` 与 `fallback` 均可计数）；
3. 默认模板与 SKILL.md 都包含闪避/招架/确反规则，且实测有出手；
4. 结算与训练报告能报出 `fallback` / `timeouts` / `budgetExceeded` / `rejected` 四项；
5. 双方全程不出手时结果为 `double_loss`（不是 `draw`），且双方都被计算过 `stalls`；
6. 4 个注册 Agent 在线跑 48 场，6 种两两组合都出现，且没有任何一组超过 35%。
