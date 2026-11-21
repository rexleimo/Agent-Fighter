# 部署指南 · Dokploy

目标版本：`d59bcde`（fix: 战斗日志显示所有攻击招式出招与命中）
适用：Agent Fighting League（Node/Bun 服务 + React 前端 + Postgres）

Dokploy 自带 Git 拉取、Docker 构建、域名/TLS、托管 Postgres。本指南基于仓库
现有的 `Dockerfile`（EXPOSE 8787）、`/healthz` 健康端点与实际启动约定整理。

---

## 0. 关键差异（先看，避免踩坑）

与裸 `docker compose` 相比，Dokploy 部署有两个必须手动处理的点：

1. **数据库迁移要显式补上。** Dockerfile 的 `CMD` 是 `bun src/server.js`，
   **不含 `db:migrate`**。裸 compose 是靠 `docker-compose.yml` 里的 `command`
   补上迁移的。Dokploy 若直接跑 Dockerfile，迁移不会自动执行 → 用 command
   覆盖（见 §3 方式 A）。
2. **`/app/data` 卷要显式挂载。** 对局 replay / league 数据写在容器 `/app/data`。
   Dokploy 容器重建会丢数据 → 在 UI 里挂一个持久卷到 `/app/data`（见 §7）。

---

## 1. 前置：创建 Postgres 数据库

1. Dokploy → **Databases** → New → **PostgreSQL**
2. 名称如 `afl-db`，数据库名 `afl`，设置用户/密码
3. 创建后，从连接信息里拿到形如下面的**内部网络**连接串（不是 localhost）：
   ```
   postgres://user:pass@<dokploy-db-host>:5432/afl
   ```

## 2. 创建 Application

1. Dokploy → **Applications** → New → **Application**
2. Git 配置：
   - Provider：GitHub（账号 `rexleimo`）
   - Repository：`rexleimo/Agent-Fighter`
   - Branch：`main`
   - Commit：固定 `d59bcde`（避免下次 push 悄悄变更上线版本）
3. Build 设置：
   - Build Type：**Dockerfile**（自动检测根目录 `Dockerfile`）
   - Dockerfile Path：`./Dockerfile`
4. 容器端口：**8787**（Dokploy 自动映射到域名 80/443）

## 3. ⚠️ 环境变量 + 迁移

### 3.1 环境变量（Application → Environment）

```bash
DATABASE_URL=postgres://user:pass@<dokploy-db-host>:5432/afl
BETTER_AUTH_SECRET=<openssl rand -hex 32 生成>
BETTER_AUTH_URL=https://你的域名
BETTER_AUTH_TRUSTED_ORIGINS=https://你的域名
AFL_TRUST_PROXY=1
```

- `BETTER_AUTH_SECRET`：本地执行 `openssl rand -hex 32` 生成，妥善保存。
- `AFL_TRUST_PROXY=1`：Dokploy 的 Traefik 在前面反代，必须开，否则限流拿到的是代理 IP。

### 3.2 迁移（二选一，推荐方式 A）

**方式 A（推荐）— 覆盖启动 command**
Application → **Advanced** → Command / EntryPoint 覆盖：
```sh
sh -c 'bun run db:migrate && bun src/server.js'
```
每次启动幂等迁移，行为与 `docker-compose.yml` 一致。

**方式 B — Post Deployment hook**
若 Dokploy 版本支持 post-deploy 脚本，先执行一次 `bun run db:migrate`。
不如方式 A 稳（方式 A 每次启动都迁移）。

> 无构建期密钥需求：Dockerfile 没有 `ARG`/`RUN` 引用任何 secret，所有敏感值都是运行时环境变量。

## 4. 域名 + TLS

1. Application → **Domains** → 添加域名（如 `afl.example.com`）
2. 开启 **HTTPS**（Dokploy 集成 Let's Encrypt，自动申请证书）
3. 确认 `BETTER_AUTH_URL` / `BETTER_AUTH_TRUSTED_ORIGINS` 与域名完全一致（含 `https://`）

## 5. 健康检查

Application → **Health Check**：
- Path：`/healthz`
- Method：GET
- Interval：30s

（Dockerfile 内已有 HEALTHCHECK，Dokploy 侧再配一份便于自动重启/摘流量。）

## 6. 首次初始化

部署成功后访问 `https://你的域名/setup`，创建管理员账号。
该账号一次性创建、永久锁死，无需环境变量配置。

## 7. 数据持久化

- 数据库在 Dokploy 的 Postgres 容器卷里（跟随 Dokploy 备份策略）。
- 对局 replay / league 数据写在 app 容器 `/app/data`：
  Dokploy → Application → **Volumes** → 挂载持久卷到 `/app/data`（如 `afl-data: /app/data`），
  否则容器重建会丢 replay 与 league.json。

## 8. 上线前验证

```bash
curl https://你的域名/healthz     # 返回 ok
curl https://你的域名/api/state    # 返回 server 状态 JSON（含 version 0.14.1）
```
然后：`/setup` 建管理员 → 玩家入口注册 Agent → 验证一场对战。

## 9. 本次上线包含

- 修复四类对局异常（空挥 / 站桩平局 / 匹配锁死 / 不会闪避招架）
- rules 2.2 反消极判罚 + double_loss
- 对手打分匹配器 + 复赛暂缓（实测连续同对手 0%，最大组合占比 7.1%）
- `get_rules()` 发布真实 reach / 角色打法 + 两个踩坑文档（advanced.md §5.6 / SKILL.md §0.1）
- 观战战斗日志修复（普通招式出招/命中现在可见）

## 10. 回滚

Dokploy → Application → 把 Git 的 Commit 切回上一个稳定版（如 `d6b9e22`），
Redeploy。数据库卷与 `/app/data` 卷不动。

## 11. 已知边界

- `scripts/pk/` 是本地模型压测工具，已 gitignore，不进镜像，不参与部署。
- 前端资源由 Dockerfile 的 build 阶段重新执行 `pnpm build:web` 编译进
  `web/dist`（`web/dist` 在 `.dockerignore` 中被排除），不会用到旧产物。
- 上线前建议对 Postgres 与 `/app/data` 卷各做一次快照备份。
