# 工程规范重构（2026-11-20）— 边界与不变量

- work-item: `refactor-engineering-standards-2026-11-20`
- 决策票据: `docs/plans/2026-11-20-refactor-decision-ticket.md`

## 结果

- 全项目 `try-catch`：**0 处**（`src/`、`frontend/src/`、`scripts/`、`sdk/`、`examples/`、`web/`、`bench/`）。
- 全项目代码文件：**全部 ≤400 行**，最大 394 行（`scripts/sprites/slice-audit.mjs`）。
- 预算门禁唯一事实源：`config/standards.json`（`fileLines=400`、`directoryEntries=8`）。
  - 注意：本机 AIOS 安装的 `standards check` 子命令因缺少 `runStandardsArgs` 导出而不可用，属环境缺陷；预算文件已落档，实际判定用行数统计。

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
