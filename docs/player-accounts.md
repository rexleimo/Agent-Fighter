# 玩家账号与专属 MCP 服务

> 状态：v0.7 · **better-auth** 负责认证 · Postgres 16 + Drizzle 存身份/档案 · 验收：`AFL_TEST_DATABASE_URL=... npm run verify:accounts`

## 1. 为什么改

旧链路把「人」和「Agent」混成了一个匿名 `register_agent`，后来又用了一套自写 scrypt + session。它有三个问题：

- 密码、session、cookie、CSRF 都要自己维护，越写越像半成品认证框架。
- 玩家账号和 Agent 混在一起，没有清晰的「身份 / 档案 / 绑定」边界。
- 管理后台没有真正的用户管理能力，改密码、踢 session、加角色都要手写 SQL。

现在用 **better-auth** 处理身份，游戏只保留自己的档案：

| 层 | 谁拥有 | 存在哪 |
| :--- | :--- | :--- |
| **认证身份** | better-auth | `user` / `account` / `session` / `verification` |
| **玩家档案** | 游戏 | `players`：role、status、agentId、mcpKey |
| **Agent** | 玩家档案 | `src/league.js` 的 Agent，仍由 `set_team` / `join_queue` 驱动 |
| **MCP 服务 key** | 玩家档案 | `players.mcp_key`，一个可轮换的 URL 凭证 |

## 2. 人的操作（只有两步）

1. **注册玩家**：`/?view=account` → 用户名 + 密码（+ 可选显示名）。不选战队、不填战队名。
2. **分配 MCP 服务**：登录后点「生成 MCP 服务链接」，或由管理员在「后台 · 玩家管理」里分配 / 轮换。把 `http://<站点>/mcp/<key>` 交给 Agent。

注册/登录由 better-auth 的标准端点处理：

| 端点 | 用途 |
| :--- | :--- |
| `POST /api/auth/sign-up/email` | 注册；页面用 `用户名@players.local` 作为内部登录邮箱 |
| `POST /api/auth/sign-in/username` | 用户名 + 密码登录（username 插件） |
| `POST /api/auth/sign-out` | 退出，better-auth 清理 session cookie |
| `GET /api/auth/get-session` | 调试用；应用侧读 `/api/me` |

管理员账号在首次启动时创建：

```bash
AFL_ADMIN_USERNAME=admin AFL_ADMIN_PASSWORD='choose-a-strong-password' npm start
```

首次启动会通过 `auth.api.signUpEmail` 创建 better-auth 用户，再把 `players.role` 提升为 `admin`。**`AFL_ADMIN_PASSWORD` 只在首次创建时使用；管理员已存在时不会自动改密码。** 未设置时会生成一次性密码并打印在服务端日志。

## 3. Agent 的操作

```text
get_my_profile
  → register_agent        （玩家 MCP 上幂等，返回同一个 Agent）
  → set_team(teamName, 3 fighters)
  → get_strategy_template → validate_strategy → simulate_strategy
  → submit_strategy
  → join_queue(format="team")
  → get_my_matches → get_replay → 迭代
```

玩家 MCP 服务会自动注入 token，所以 `set_team` / `submit_strategy` / `join_queue` / `get_my_matches` 等工具可以省略 `token`。如果显式传了别的 token，会被拒绝（`token does not belong to this MCP service`）。

`register_agent` 在玩家 URL 上是幂等的；匿名 `POST /mcp` 仍保留旧行为（每次调用新建 Agent），只用于本地调试与旧验收脚本。

## 4. 数据与接口

**主存储：Postgres 16 + Drizzle ORM。**

### better-auth 表（CLI 生成，`src/db/auth-schema.js`）

| 表 | 作用 |
| :--- | :--- |
| `user` | id、name、email、username、displayUsername、emailVerified |
| `account` | provider / accountId / password hash（better-auth 管理） |
| `session` | token、expiresAt、userId、ip、userAgent |
| `verification` | 邮箱验证 / 重置令牌 |

### 游戏档案（`src/db/schema.js`）

| 列 | 说明 |
| :--- | :--- |
| `id` | `ply_...` 应用档案 ID |
| `user_id` | FK → `user.id`，unique，cascade |
| `role` | `player` / `admin` |
| `status` | `active` |
| `agent_id` | 绑定的联赛 Agent |
| `mcp_key` | 专属 MCP URL key，unique |
| `mcp_issued_at` | 签发时间 |
| `created_at` / `last_login_at` | 时间戳 |

`players` 不存用户名、密码、session；这些都在 better-auth 表里。读取玩家时 `players join user`，把 `username` / `displayName` 映射出来。

```bash
pnpm install
cp .env.example .env
pnpm db:up        # docker run 启动独立 afl-pg（端口 55433）
pnpm db:down      # 停止容器（保留 volume）
pnpm db:reset     # 删除容器与 volume，重新开始
pnpm db:generate  # 改 schema 后生成迁移
pnpm db:migrate   # 应用迁移
pnpm db:studio    # Drizzle Studio
```

### 应用 API

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/me` | 当前玩家 + Agent + MCP 状态（需 better-auth session） |
| POST | `/api/me/mcp` | 生成 / 轮换自己的 MCP 服务 |
| GET | `/api/me/agent` | 队伍、排队、房间、最近对局 |
| GET | `/api/admin/players` | 管理员：玩家列表 |
| POST | `/api/admin/players` | 管理员：通过 better-auth 创建玩家 |
| POST | `/api/admin/players/:id/mcp` | 管理员：分配 / 轮换 MCP |

**没有 `DATABASE_URL` 时**：`auth` 不构造，`/api/auth/*`、`/api/me*`、`/api/admin/*` 返回 503；`/api/state`、观战、匿名 MCP 和游戏回归测试照常跑。这是为了本地游戏开发和离线验收，不是生产模式。

- 密码：由 better-auth 的 email/password 流程哈希和校验，`players` 不接触明文或哈希。
- 会话：better-auth 的 HttpOnly cookie，`session` 表持久化；退出时删除并清 cookie。
- MCP key：`mcp_` + 24 随机字节 base64url；轮换时 `players.mcp_key` 更新，旧 key 立即失效。
- 公开接口不返回密码字段；只有玩家本人与管理员能看到自己的 MCP key。

## 5. 兼容与迁移

- **v0.7 是认证 breaking change**：旧的 `players.password_hash` / `sessions` 表已删除；旧 scrypt 密码哈希不能直接迁到 better-auth。升级时必须重建 `user` / `account` / `session` 表，玩家重新注册或走密码重置。当前项目处于 pre-release，开发库直接重建即可。
- 旧的 `POST /api/enter`、`POST /api/token`、`POST /api/team` **已删除**（请求返回 404），全局 `POST /mcp` 只在未配置账号库时作为本地开发沙箱存在：一旦启用账号，匿名 `/mcp` 返回 401。
  这三条曾经在本文件里被写成「保留的兼容入口」，而代码里根本没有——那是文档在替不存在的能力背书。现在由 `npm run verify` 的 C14b 直接抓 HTTP 状态码与文档措辞，防止再次漂移。
  迁移方式：注册即 Better Auth 账号 → `GET /api/me/mcp` 取你自己的服务 URL → 一切动作走 `/mcp/<key>`（建房、约战、换队、报名都不需要 token 参数）。
- 旧 `data/league.json` 里的 Agent 没有 `playerId` / `teamName`，加载时按缺省值处理；内置 Agent 继续回填队伍。
- `set_team` 的 `teamName` 是可选参数；已有调用不变。
- 排行榜与 `/api/agents` 的 `teamName` 字段不变。

## 6. 安全边界

- better-auth 负责密码哈希、session、cookie 与 CSRF origin 校验；`BETTER_AUTH_SECRET` 必须至少 32 字符，公网必须 HTTPS。
- 还没有邮箱验证、找回密码、OAuth、登录限流与审计日志；公网部署前要补。
- 管理员可以创建玩家、分配 MCP，但不能读取玩家密码（better-auth 只存哈希）。
- MCP URL 等同于该玩家的服务凭证；泄露后由本人或管理员轮换即可。
