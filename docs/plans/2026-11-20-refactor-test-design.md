# Test Design — 全项目软件工程规范重构

- work-item: `refactor-engineering-standards-2026-11-20`
- capability: `software.testing.design` · provider: `rex-test-design`

## 测试范围契约

- **用户目标**：在不改变可观察行为的前提下，按工程规范重构全项目——业务逻辑分层封装、消除全部 try-catch（含存量）、文件行数达标、前端类型与组件职责清晰。
- **明确非目标**：不改游戏规则与业务语义；不改对外 API 契约；不做新功能；不提交/发布。
- **范围内行为**：认证（登录/注册/验证码/登出）、玩家与 MCP 服务绑定轮换、对战与榜单公开只读、安全响应头与限流、前端用户中心交互。
- **范围外行为**：UI 视觉重设计、性能优化、依赖升级。
- **允许修改的测试缝**：公共 HTTP 入口 `/api/*`、`/mcp/*`；前端 `pnpm build:web` / `lint:web` / `test:web`；现有 `scripts/verify-*.mjs` 验收脚本；静态检查（`grep` try-catch、行数、`aios standards check`）。
- **完成判据**：全量 verify 集合与基线一致全绿；try-catch grep 为 0；standards check 可运行；build/lint/test 全绿；无断言弱化、无用例跳过。

## 验收行为 → 可观察断言

| # | 验收行为 | 可观察断言（公共入口） | 稳定入口 |
| :--- | :--- | :--- | :--- |
| A1 | 注册仍可用 | `verify:accounts` A3e/A4：解出验证码后注册成功、档案 role=player | `POST /api/register`, `GET /api/me` |
| A2 | 登录仍可用 | A1/A4/A17：管理员与玩家登录 200，错误密码 401 | `POST /api/login` |
| A3 | 验证码防绕过仍有效 | A3a–A3d：裸 better-auth 端点 403，缺验证码 400 `CAPTCHA_INVALID` | `POST /api/auth/sign-*`, `/api/login` |
| A4 | MCP 仍绑定玩家 | A6–A16、A19：签发/轮换、旧 key 401、匿名被拒 | `/mcp/<key>` |
| A5 | 公开只读仍匿名 | A20：榜单与 state 匿名 200 且口径完整 | `GET /api/leaderboard`, `/api/state` |
| A6 | 安全面不变 | `verify:security`：413 / 429 真实触发 | HTTP 状态码 |
| A7 | 前端可构建可检查 | `build:web` / `lint:web` / `test:web` 零退出 | CLI |
| A8 | try-catch 清零 | `grep -rnE '\btry[[:space:]]*\{' src frontend/src scripts` 无输出 | 静态检查 |
| A9 | 行数达标 | `aios standards check --root . --json` 无新增越界 | 静态检查 |
| A10 | 行为保持（每批） | 改前基线全绿，改后同一集合全绿，断言逐条一致 | 全量 verify 集合 |

## 最小纵向切片

选 **work-1（门禁基线）+ work-2（认证入口分层与去 try-catch）**：它同时命中"分层错误"与"我新增 try-catch"两个本轮被指出的问题，能独立失败、独立回退，且被 `verify:accounts` 的 A1–A4、A17 完整覆盖——足以代表整体目标，不需要先动全部十几个文件。

## 否定条款

- 禁止删除断言、跳过用例、放宽期望、只测 mock 换取通过。
- 禁止用内部调用次数替代用户可观察行为。
- 禁止把静态 grep 通过当作行为通过——它只覆盖 A8/A9，不替代 A1–A7。
- 当前是行为保持型重构，没有新用户可观察行为；进入 `decide-testability` 时只能提交 `behavior-preserving-hardening`，并附带真实场景的零退出 baseline receipt。
