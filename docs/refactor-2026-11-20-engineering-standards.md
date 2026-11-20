# 工程规范重构（2026-11-20）— 边界与不变量

- work-item: `refactor-engineering-standards-2026-11-20`
- 决策票据: `docs/plans/2026-11-20-refactor-decision-ticket.md`

## 结果

- 全项目 `try-catch`：**0 处**（`src/`、`frontend/src/`、`scripts/`、`sdk/`、`examples/`、`web/`、`bench/`）。
- 全项目代码文件：**全部 ≤400 行**，最大 394 行（`scripts/sprites/slice-audit.mjs`）。
- 预算门禁唯一事实源：`config/standards.json`（`fileLines=400`、`directoryEntries=8`）。
- 分层门禁事实源：同一文件的 `layers` 段（外层→内层 `composition → adapters → application → domain`，
  25 条路径前缀）。结构来源见 `docs/add-2026-11-20-layer-architecture.md`。
  - 注意：本机宿主入口实测 `aios standards check` 报 `runStandardsArgs is not a function`
    （`rex-harness/bin` 下也无可用的同入口），属环境缺陷，故本次未能执行 standards check；
    预算与分层声明均已落档，CI 也未接入该入口以免常亮误报。实际判定用行数统计 + lint/test。

## 新边界

**服务端**
- `src/server.js`（93 行）— 组装入口；HTTP 接线在 `src/http/*`（index/shared/static/auth-routes/me-routes/training-routes/admin-routes/public-routes/mcp-routes/ws-wiring）。
- `src/auth-entry.js` — 认证入口策略：验证码校验、注册/登录端点选择、错误映射；`server.js` 只做 HTTP 适配。
- `src/captcha.js` — 一次性算术挑战的生成与消费。
- `src/json-result.js` — 非抛出 JSON 解析（`parseJsonResult`），替代各处的 try-catch + JSON.parse。
- 领域分层：`src/league/*`、`src/rooms/*`、`src/engine/*`、`src/training/*`、`src/combat/*`、`src/mcp/*`；原入口文件保留为编排与 re-export，对外 API 名与签名不变。

**前端**
- `frontend/src/lib/types.ts` 统一 re-export，领域类型在 `types/{core,leaderboard,training,account,ui}.ts`。
- `frontend/src/lib/json.ts` — Result 化 JSON 解析。
- `frontend/src/game/stage.js` 改为入口，`game/stage/{shared,art,pose,body,overlay,scene}.js` 承载绘制。

**验收脚本**
- `scripts/lib/no-throw.mjs`（`attempt`/`parseOr`/`withFinally`）、`scripts/lib/captcha-auth.mjs`。
- `scripts/verify-parts/*` 承载 C4–C23 各段；入口脚本保持原路径与 CLI 行为。

## 不变量与刻意取舍

- `safePolicy`（`src/engine/match.js`）与 `simulateReplay`（`src/simulator.js`）：在禁止 try-catch 的前提下，同步捕获任意策略函数抛错在 JS 中不可能。
  - `safePolicy` 位于逐拍热路径，保持同步，合约改为「策略必须自行返回而非抛错」（非函数/非法动作仍回落）。
  - `simulateReplay` 不在热路径，改为 `async`，用 Promise settlement 恢复「抛错计为分歧」的原语义；两个调用方已同步改为 `await`。
- 裸端点 `/api/auth/sign-up/email`、`/api/auth/sign-in/username` 保持 403；所有内部 harness 通过 `fetchCaptcha()` + `/api/register`、`/api/login` 完成认证。
- `verify:assets` 的「live does not preload gallery cards」在 HEAD 基线即失败（HUD 使用 card 变体做头像），已用临时 worktree 证实为存量问题；未弱化该断言。

## 验证证据（最终）

| 命令 | 结果 |
| :--- | :--- |
| `pnpm verify` | 21/21 PASS |
| `pnpm verify:accounts` | 25/25 PASS |
| `pnpm verify:combat` | 76/76 PASS |
| `pnpm verify:ladder` | ALL PASS 53 checks |
| `pnpm verify:team` | 15/15 PASS |
| `pnpm verify:security` | 6/6 PASS |
| `pnpm verify:setup` | 9/9 PASS |
| `pnpm verify:facing` | PASS / ledger clean |
| `pnpm build:web` / `lint:web` / `test:web` | PASS（10 tests） |
| `pnpm assets:check` | PASS（21 assets） |
| `pnpm bench:selftest` | 15/15 PASS |

### 本次补充验证

| 命令 | 结果 |
| :--- | :--- |
| `node -e "JSON.parse(...)"`（standards.json + package.json） | PASS |
| `bash -n .github/hooks/pre-commit` | PASS |
| `pnpm lint:web` | PASS |
| `pnpm test:web` | PASS（2 files / 10 tests） |
| `aios standards check --root . --json`（宿主入口） | 不可用：`runStandardsArgs is not a function`（环境缺陷，非门禁红） |

## 架构层决策（本次补充）

完整决策、适用条件与权衡见 `docs/add-2026-11-20-layer-architecture.md`。要点：

- **依赖倒置**：`src/auth-entry.js` 的 `createAuthEntry({ credentialGateway, captchaStore })` 只依赖端口；
  `src/auth-gateway.js` 把 better-auth 抛错翻译为 typed Result；`src/server.js` 在组合根接线。
- **HTTP 适配器合并为深层模块**：薄转发文件（index / me-routes / training-routes / admin-routes /
  mcp-routes / ws-wiring）收敛为 `src/http/{api,router,realtime,shared,static}.js`（最大 314 行，
  仍在 400 行预算内）。
- **组合替代继承**：`src/rooms/`、`src/league/`、`src/http/` 已无 `extends`，共享行为改为显式持有协作者。
- **layers 门禁**：`config/standards.json` 声明四层与 25 条路径前缀；引擎只拦内层→外层反向边，
  未登记路径 SKIP（不猜测、不豁免）。`src/auth-gateway.js` 作为端口适配器归入 adapters。
- **被拒选项**：按行数机械拆分（会产生无语义浅模块）、继续用继承、只在文档里写规范（无门禁即无约束）。

## 工具链基线状态（§6）

| 基线项 | 状态 | 落地位置 |
| :--- | :--- | :--- |
| Lint / 格式化配置 | 既有 | `eslint.config.js` + `pnpm lint:web`（未另起炉灶） |
| Pre-commit hooks（lint + 快速测试） | 本次新增 | `.github/hooks/pre-commit` → `pnpm check:fast`；`pnpm hooks:install` 一次性激活 |
| CI（lint + 静态检查 + 全量测试） | 本次新增 | `.github/workflows/ci.yml`：`lint:web` → `tsc --noEmit` → `test:web` → `pnpm verify` |
| 测试框架 + 核心路径测试 | 既有 | vitest（10 tests）+ `pnpm verify` 验收套件 |
| 结构化日志 | 部分（缺项已记） | 既有 `[afl]` 前缀 `console.log`/`console.error`，可检索但无正式分级；按 §6「已有仓库」条款记录，不擅自并行引入日志框架 |

`package.json` 只新增 `check:fast`、`hooks:install` 两个脚本，未改动任何既有脚本定义；
未引入新依赖。`.github/hooks/pre-commit` 需在每个 clone 执行一次 `pnpm hooks:install`
才会被 git 使用（git 配置不随仓库提交）。
