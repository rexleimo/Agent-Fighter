# 首次部署体验优化（外部 DB 直连 + 首跑 setup）· Test design

> Activation: `06ecef51-da7e-47b9-af38-a415fb368ce1`
> Command: `software.testing.design` / `design-tests`
> Provider: `rex-test-design`
> Date: 2026-11-15
> 需求原文：「POSTGRES_PASSWORD 冗余，连接 URL 已含凭据；AFL_ADMIN_PASSWORD 应改为
> 首次部署 setup 设置页；AFL_ADMIN_USERNAME / AFL_ADMIN_PASSWORD 没有必要存在。」
> Decision Ticket: `docs/plans/2026-11-15-first-run-setup.decision.json`（D2 已按用户裁定修订）

## 0. 先查证：现状事实（不是猜测）

| 事实 | 证据 |
| :--- | :--- |
| 应用唯一 DB 入口是 `DATABASE_URL`；`POSTGRES_PASSWORD` 只被 compose db 容器消费 | `src/db/client.js:8-9`、`src/auth.js:10`、`docker-compose.yml` |
| admin 由启动时 env/随机密码硬建；已有 admin 则跳过 | `src/server.js:37` → `src/auth-bootstrap.js:8-50` |
| `verify-accounts.mjs` 依赖 env 建管，且**明确容忍非空库**（固定 admin + 随机玩家名） | `scripts/verify-accounts.mjs:19-23,125-126` |
| `verify-ladder.mjs` partC 同样依赖 env 建管 | `scripts/verify-ladder.mjs:206-207,304-305` |
| 认证限流档可直接复用（`/api/auth/*` 走 `limiters.auth`） | `src/server.js:299` |
| `verify-security.mjs` 以 `DATABASE_URL=''` 关闭账号跑严格参数 | 记忆 20261114165647529 + `scripts/verify-security.mjs` |
| 迁移可用 `drizzle-kit migrate` + `DATABASE_URL` 覆盖指向临时库 | `package.json db:migrate`、`drizzle.config.js` |
| 单实例架构，setup 竞态进程内锁即可闭环 | `docs/deployment.md` §7 |

## 1. Test scope contract

### 1.1 用户目标

1. 外部 DB 用户只配 `DATABASE_URL` + `BETTER_AUTH_SECRET` 就能起服务（compose 不再强制 `POSTGRES_PASSWORD`）。
2. 全新部署打开浏览器 → setup 页一次性创建管理员 → 直接进入已登录管理员会话。
3. `AFL_ADMIN_USERNAME` / `AFL_ADMIN_PASSWORD` 从运行时与文档中彻底消失。

### 1.2 明确非目标

- 不做多实例/水平扩展下的 setup 竞态（已知边界，单实例进程内锁）。
- 不改 better-auth 的登录/注册/session 机制本身。
- 不做「重置管理员/重开 setup」功能——锁死是特性。
- 不在本机验证 Docker 镜像构建（本机薄壳无 dockerd；只做 compose 插值校验）。
- 不动对战/联赛/回放任何行为。

### 1.3 范围内行为（可观察）

- `GET /api/setup/status` 的 `needsSetup` 真值表：auth 关闭→false；无 admin→true；有 admin→false。
- `POST /api/setup`：空库建号成功（种 session cookie、role=admin）；此后恒 409；弱密码 400；超 body 上限 413；限流档生效 429。
- 重启后（同库）setup 仍锁死。
- 既有验收（accounts 20/20、ladder、security 6/6、verify 9/9+C4）在**迁移到 setup API 建管后**全绿。
- compose 两种组合插值正确：app-only 缺 `DATABASE_URL` 报错；bundled override 提供默认连接串。

### 1.4 范围外行为

- 玩家自助注册/登录/MCP key 流程的语义（只作为回归边界，不得改期望值）。
- 前端其余页面；美术资产管线。

### 1.5 允许修改的测试缝

- 新增 `scripts/verify-setup.mjs`（真实 spawn + 临时 Postgres 库）。
- `scripts/verify-accounts.mjs` / `verify-ladder.mjs`：**仅改建管方式**（env → setup API，409 回退登录），断言数量与期望值不得减少或放宽（A1 语义改为「setup 建管或既有 admin 登录成功且 role=admin」）。
- `package.json` 增加 `verify:setup` 入口；`scripts/verify.js` 套件登记（如适用）。
- 前端冒烟为人工/浏览器观察，不新增 UI 自动化框架。

### 1.6 完成判据

- `bun scripts/verify-setup.mjs` 全绿（S1–S8）。
- `pnpm verify:accounts` 20/20、`pnpm verify:ladder` 全绿、`pnpm verify:security` 6/6、`bun scripts/verify.js` 9/9+C4b/c/d。
- `rg AFL_ADMIN src scripts docker-compose*.yml .env.example docs/deployment.md docs/player-accounts.md README.md` 零命中（历史计划文档除外）。
- compose 两组合 `docker compose config` 校验通过。

### 1.7 否定条款（防假通过）

- 禁止删除/跳过既有断言、放宽期望值、或用 mock 替换真实 HTTP/DB 来换取绿色。
- 禁止用「实现后写测试只测实现路径」反推目标；S1–S8 先于实现冻结。
- setup 锁死断言（S4/S5）不得以 404/403 等弱形式替代明确 409。

## 2. 验收行为 → 可观察断言映射

| # | 验收行为 | 公共入口 | 断言 |
| :-- | :--- | :--- | :--- |
| S1 | 全新库进入 setup 待命 | spawn server（临时空库，已 migrate，无 AFL_ADMIN_*）→ `GET /api/setup/status` | 200 且 `needsSetup===true` |
| S2 | setup 建管成功即登录 | `POST /api/setup {username,password,displayName}` | 2xx；响应种 session cookie；携 cookie `GET /api/me` → `player.role==='admin'` |
| S3 | 建管后状态关闭 | `GET /api/setup/status` | `needsSetup===false` |
| S4 | 一次性锁死 | 再次 `POST /api/setup`（不同用户名） | 409；库中 admin 数不变（用 `GET /api/admin/players` 以 S2 cookie 验证仅 1 admin） |
| S5 | 重启仍锁死 | kill + 重 spawn 同库 → status + POST | `needsSetup===false`；POST 409 |
| S6 | 输入校验 | 空库阶段 POST 弱密码（<8 位） | 400；随后合法 POST 仍成功（失败不留半状态） |
| S7 | auth 关闭时不暴露 setup | spawn `DATABASE_URL=''` → status | `needsSetup===false`；POST 503 |
| S8 | 限流/体限真实生效 | 严格参数 spawn（低 `AFL_RATE_AUTH`、小 `AFL_MAX_BODY_BYTES`）→ 连发 POST / 超大 body | 429+Retry-After；413 |
| S9 | 既有账号流程零回归 | `pnpm verify:accounts`（建管已迁移 setup API） | 20/20，A1 语义更新但强度不降 |
| S10 | 天梯真实 matchmaking 零回归 | `pnpm verify:ladder` | 全绿 |
| S11 | compose 外部 DB 路径 | `DATABASE_URL=... BETTER_AUTH_SECRET=... docker compose --env-file /dev/null -f docker-compose.yml config` | 插值成功、无 db 服务；缺 BETTER_AUTH_SECRET 时非零退出；缺 DATABASE_URL 时容器启动 guard 非零退出（compose 逐文件先插值后合并，override 默认值救不了主文件 :?，故 DB 必填改为启动期硬校验，行为仍是拒绝启动） |
| S12 | compose 自带 DB 路径 | `BETTER_AUTH_SECRET=... docker compose --env-file /dev/null -f docker-compose.yml -f docker-compose.bundled-db.yml config` | db+app 两服务、depends_on 健康条件、默认连接串一致（只需 secret 一个必填值） |

## 3. 测试缝选择与最小纵向切片

- **缝：真实进程 + 真实 Postgres**（沿用 verify-accounts 模式：freePort + spawn `process.execPath src/server.js` + 独立 `AFL_DATA_DIR`）。不用 supertest/mock——setup 的价值恰在跨重启持久与真实 cookie。
- **空库构造**：在 `AFL_TEST_DATABASE_URL` 同一 PG 实例上 `CREATE DATABASE afl_setup_<run>` → spawn `bun run db:migrate`（env 覆盖 DATABASE_URL）→ 跑 S1–S6 → `DROP DATABASE`。可独立清理，不碰 dev 库。
- **最小纵向切片**：S1→S2→S4（待命→建管→锁死）独立可失败，代表了本目标的全部新风险面；S5 证明锁死是持久语义而非内存标志。
- **UI 冒烟**（S2/S3 的浏览器侧）：needsSetup 引导跳转 → 表单建号 → 跳 /account 已登录 → 刷新不回 setup。人工观察记录截图。
- **已有 sediment**：accounts A1–A20、ladder partC、security 6 项全部保留为回归边界；仅建管前置步骤迁移，断言不动。

## 4. Testability 预判（供 decide-testability 阶段）

S1–S8 均为**新用户可观察行为**（现状：无 `/api/setup/*` 路由 → 404；env 建管使空库启动后 `needsSetup` 概念不存在）。预期 `behavior-delta`：公共入口 `GET /api/setup/status` 在空库场景当前返回 404，可真实复现失败。RED receipt 在 decide-testability 阶段用 `rex-harness receipt` 采集，本阶段不预造。

## 5. REFACTOR 审查记录（2026-11-15）

- **测试差异审查**：`verify-accounts.mjs` / `verify-ladder.mjs` 仅迁移建管前置（env → `POST /api/setup`，409 回退登录）；A1 断言保持 `role==='admin'` 强度并**新增** `assert.equal(setup.res.status, 409)`；无任何断言删除/跳过/放宽。`verify-setup.mjs` 为新增 S1–S8 行为断言，全部走公共 HTTP。
- **S11 口径修正（如实记录）**：compose 逐文件先插值后合并，override 默认值无法满足主文件 `:?`；`DATABASE_URL` 必填改为容器启动期 guard（`test -n` 非零退出），`BETTER_AUTH_SECRET` 仍为 config 期 `:?`。拒绝启动的行为不变，已实测 guard 触发。
- **清理**：移除 verify-setup.mjs 未使用的 `assert` import；lint:web 零告警、test:web 4/4。
- **回归证据**：verify-setup 9/9（receipt:1cbaeef3）、accounts 20/20、ladder 53/53、security 6/6、verify 28/28（含实时段）、UI 冒烟三态截图（/tmp/afl-account.png 建管即登录、/tmp/afl-setup-locked.png 锁死态）。
