# ADD — 分层架构与工具链门禁（2026-11-20）

- 状态：accepted
- 关联：`docs/refactor-2026-11-20-engineering-standards.md`、`docs/plans/2026-11-20-refactor-decision-ticket.md`
- 规范来源：`rex-engineering-standards` §1（Clean Architecture 边界）、§2（深层模块）、§4.1（`layers` 量化门）、§6（工具链基线）、§7（ADD）

## 上下文

上一轮重构已把全仓代码压到 400 行预算内、清掉 try-catch，但「边界」仍只是文档叙述：
没有声明分层，`standards check` 的依赖方向规则会 SKIP；HTTP 由一批薄路由文件串联；认证策略与
better-auth 直接耦合；房间/联赛对象靠继承复用。本次把这些事实落成可执行约束。

## 决策

### D1 依赖倒置：`auth-entry` 通过端口依赖认证

`createAuthEntry({ credentialGateway, captchaStore })`（`src/auth-entry.js`）持有验证码生命周期与
「先消费挑战再提交凭据」的策略，只调用 `credentialGateway.isConfigured()` / `.submit()`。
`createAuthGateway()`（`src/auth-gateway.js`）在 adapters 层把 better-auth 的抛错翻译成
application 层期望的 typed Result。组合根 `src/server.js` 负责把两者接起来。

- 适用条件：application 策略需要框架/存储能力，且不希望策略知道框架类型。
- 权衡：多出一个端口对象与一次组合接线；换来策略可独立测试、框架细节止于适配边界。

### D2 HTTP 适配器合并为深层模块

原先的 `index/me-routes/training-routes/admin-routes/mcp-routes/ws-wiring` 等薄转发文件合并为
`src/http/{api,router,realtime,shared,static}.js`：一个较小接口（请求分发 + WS 连接）后面藏住
路由细节。`src/server.js` 只做组装、监听与关停。

- 适用条件：一组文件只做转发、没有各自的信息隐藏时。
- 权衡：单文件行数上升（最大 `api.js` 314 行），仍在 400 行预算内；换来调用链变短、改动收口。

### D3 组合替代继承

房间与联赛的共享行为改为显式持有协作者（如 `RoomManager` 聚合状态与策略），`src/rooms/`、
`src/league/`、`src/http/` 中已无 `extends`。

- 适用条件：复用的是行为片段而非可替换的 is-a 类型。
- 权衡：少量显式委托代码；换来爆炸半径局部化，避免基类牵一发动全身。

### D4 `layers` 门禁

`config/standards.json` 新增 `layers`：`order` 外层→内层为
`composition → adapters → application → domain`，`prefixes` 把源码路径映射到四层。
引擎只判**内层指向外层**的反向边；未列出的路径不猜测分层（SKIP，非豁免）。

- 适用条件：依赖方向是可数事实，应交给机器判定而非人肉 review。
- 权衡：需要维护一份路径声明（新增顶层源文件时可能漏登记）；换来边界漂移会被检出。
- 结构来源：宿主 `config/standards.json` 的 `layers` 段、`scripts/tests/foundation/standards/layer-dependency.test.mjs`
  与 `AGENTS.md`「Layer Direction Gate」（`order` 外层→内层 + `prefixes` 路径前缀→层名，
  前缀按最长匹配；`src`/`src/kernel` 示例证明目录前缀可覆盖同名入口文件）。

### D5 工具链基线（§6）

- `.github/hooks/pre-commit`：跑 `pnpm check:fast`（= `lint:web` + `test:web`），
  通过 `pnpm hooks:install` 一次性激活 `core.hooksPath=.github/hooks`，不引入 husky 或新依赖。
- `.github/workflows/ci.yml`：lint → TypeScript 静态检查 → 全量单测 → `pnpm verify` 全量验收，
  全部复用仓库既有脚本与已有工具链。
- 未把 `standards check` 接进 CI：本机宿主入口实测报 `runStandardsArgs is not a function`，
  接进去会把红灯变成常亮误报；门禁声明已落档，待入口修复后再接。

## 被拒选项

- **按行数机械拆分**：只为降行数把大文件切成 `a_utils` / `a_v2` 之类浅模块，违反 §2 与 §4
  「禁止无语义拆分」。行数只是信号，不是拆分依据。
- **继续用继承**：基类改动影响全部子类，与「一起变化的东西聚拢」相悖，且无法表达组合式的
  能力拼装。
- **只在文档里写规范**：没有 `layers` 声明时依赖方向规则 SKIP，规范会退化成无人执行的口号；
  没有 hook/CI 时 lint 与测试靠自觉（§6）。

## 完成判据

`config/standards.json` 为合法 JSON；`pnpm lint:web`、`pnpm test:web` 保持通过；
新增脚本只追加不改写；本 ADD 与重构记录同步更新。
