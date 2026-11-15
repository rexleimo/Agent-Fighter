# 首次部署体验优化：外部 DATABASE_URL 直连 + 首跑 setup 页面

> AIOS Planning Contract (schema v3)
> created: 2026-11-15T05:30:49.641Z
> client: pi
> source: mcp:aios_plan_start
> Provider: rex-planning（software.planning.sequence / activation 46740bc3）
> Decision Ticket: `docs/plans/2026-11-15-first-run-setup.decision.json`
> Delivery Ticket: `docs/plans/2026-11-15-first-run-setup.delivery.json`

## Objective

用户上线评审发现两个部署体验问题（均已查证）：

1. **`POSTGRES_PASSWORD` 冗余**：应用只读 `DATABASE_URL`（`src/db/client.js:8`、
   `src/auth.js:10`）；`POSTGRES_PASSWORD` 只服务于 compose 附带的 db 容器。
   自带外部 PG 的用户被迫配一个多余密码并起一个多余容器。
2. **管理员靠环境变量硬建**：`src/server.js:37` 启动即 `bootstrapAdmin`，
   无首跑引导。应改为 WordPress/Ghost 式一次性 setup 页面；
   `AFL_ADMIN_PASSWORD` 降级为可选 headless 覆盖（自动化部署用）。

## 已确认事实（查证于 2026-11-15）

| 事实 | 证据 |
|---|---|
| 应用唯一 DB 入口是 `DATABASE_URL` | `src/db/client.js:8-9`、`src/auth.js:10` |
| `POSTGRES_PASSWORD` 仅 compose db 容器初始化 + 拼 URL 用 | `docker-compose.yml` |
| admin 启动时硬建；已有 admin 则跳过；无 env 时随机密码打日志 | `src/auth-bootstrap.js:8-50` |
| admin 权限面：列玩家(含 MCP key)/开账号/发 MCP key | `src/server.js:468-535` |
| SPA 路由白名单在 server.js，前端页面在 `frontend/src/pages/` | `src/server.js:32` |
| 认证限流档已存在，可复用给 setup 端点 | `src/server.js:299`（`limiters.auth`） |
| 单实例架构（内存+文件），setup 竞态可用进程内锁闭环 | `docs/deployment.md` §7 |

## 关键决策（详见 Decision Ticket）

- **D1 compose 拆分**：`docker-compose.yml` 只留 app，`DATABASE_URL` 必填（`:?`）；
  自带 db 移入 override 文件 `docker-compose.bundled-db.yml`（含 db、depends_on、
  默认 URL）。不用 profile：`depends_on` 引用带 profile 的服务在未启用时会报错，
  override 文件是 compose 官方推荐组合方式。
- **D2 setup 语义（用户 2026-11-15 拍板修订）**：`needsSetup = auth 已配置 && 库中无 admin`。
  **彻底移除 `AFL_ADMIN_USERNAME` / `AFL_ADMIN_PASSWORD`**，setup 页（API）是唯一建管入口；
  `verify-accounts.mjs` / `verify-ladder.mjs` 迁移到 setup API 建管。
- **D3 setup API**：`GET /api/setup/status`（免鉴权，返回 `{needsSetup}`）；
  `POST /api/setup`（走 auth 限流档 + body 上限；进程内互斥 + 建号前二次
  `findAdmin()` 复查；已有 admin 一律 409；成功即种 admin session cookie）。
  admin 一旦存在永久锁死，无任何重开机制。
- **D4 前端**：新增 `/setup` 页（React），App 启动查 status，needsSetup 时引导跳转；
  成功后跳 `/account`。`/setup` 加入 `SPA_ROUTES`。
- **D5 兼容**：已有部署（库里已有 admin）行为零变化；env 建管路径整体删除，
  文档（deployment/player-accounts/README/.env.example/compose）同步清理。

## Work items（纵向切片，依赖图见 Delivery Ticket）

- **work-compose**（独立）：compose 拆分 + `.env.example` 更新。
  验证：`docker compose config` 两种组合均通过插值校验（本机无 dockerd，
  构建验证留待标准 Docker 主机，见已知边界）。
- **work-setup-api**（独立，关键路径）：`auth-bootstrap.js` 改造 +
  `/api/setup/*` 端点 + 进程内锁。验证：`scripts/verify-setup.mjs`（新增）。
- **work-setup-ui**（依赖 work-setup-api 的接口冻结）：`Setup.tsx` + 路由 +
  status 引导。验证：`pnpm build:web` + 浏览器冒烟（needsSetup → 建号 → 锁死）。
- **work-docs**（依赖 work-compose + work-setup-api 定稿）：`docs/deployment.md`
  重写快速开始（外部 DB / 自带 DB 两条路径）+「密钥 vs 公开配置」表。
- **work-verify**（依赖 work-setup-api；UI 冒烟依赖 work-setup-ui）：
  `verify-setup.mjs` 全场景 + 回归 `verify` 9/9、`verify:security` 6/6、
  `verify:accounts` 20/20。

关键路径：work-setup-api → work-setup-ui → work-verify。
work-compose 与 work-setup-api 可并行。

## Tasks（scaffold 映射）

- [x] **t1-understand**: 目标重述 + 约束查证（上表）
- [x] **t2-plan**: 执行图 + 决策/交付 ticket 落盘
- [x] **t3-implement**: work-compose / work-setup-api / work-setup-ui / work-docs（.env.example 待用户手动，安全门拦截）
- [x] **t4-verify**: work-verify 全量证据（见下）

## Progress

- status: done（rex 工作流 786a8af5 已 completed；唯一待办：用户手动应用 .env.example）

## Decision Log

- 2026-11-15 D1–D5 如上；Decision Ticket 独立落盘。

## Acceptance

- 外部 DB 用户只需 `DATABASE_URL` + `BETTER_AUTH_SECRET` 即可 compose 起服务。
- 全新部署打开浏览器即进 setup 页，一次性建 admin，之后 409 锁死。
- 全仓运行时不再读 `AFL_ADMIN_*`；验收脚本走 setup API；已有部署零变化。
- 验收证据：verify-setup 全绿 + verify/security/accounts 回归全绿。

## Verification evidence

- verify-setup 9/9：receipt:749edc32（GREEN）、receipt:1cbaeef3（REFACTOR 后）
- verify-accounts 20/20、verify-ladder 53/53、verify-security 6/6、verify 28/28（含实时段）、lint:web 0、test:web 4/4
- compose S11/S12：--env-file /dev/null 实测两路径插值 + 必填拒绝 + 启动 guard
- UI 冒烟三态：/tmp/afl-account.png（建管即登录 admin）、/tmp/afl-setup-locked.png（锁死态）；根路径自动引导 /setup 实测
- 双轴审查：docs/plans/2026-11-15-first-run-setup.review.json（pass-with-findings：P-1 .env.example 待手动；S-1/S-2/P-2 判断级）
