# 部署指南（最小可安全部署）

v0.12.0 起内置生产加固层（`src/security.js`）与部署打包（`Dockerfile` /
`docker-compose.yml`）。**服务运行时为 Bun >= 1.4**（通过 Node 兼容层跑 `node:http` /
自研 WebSocket / `pg` / better-auth，已全量验收）；pnpm 仍是包管理器与前端构建链。
本文档说明如何把联赛安全地暴露到网络，以及各加固旋钮的含义。

本地不用 Docker 时：`pnpm install && pnpm db:up && pnpm db:migrate && pnpm start`
（`start` = `bun src/server.js`，`prestart` 先构建 React 站点）。

> 适用范围：内部 / 受邀制 / 基准平台部署开箱即用；公网公开服务建议按本文收紧限流并置于
> TLS 反向代理之后。**水平扩展不在本档范围**（见末尾「已知边界」）。

## 1. 快速开始（Docker Compose）

```bash
# 密钥必填，无 insecure 默认值
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export AFL_ADMIN_PASSWORD="$(openssl rand -hex 16)"
# 可选：自定义数据库密码 / 对外地址
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export BETTER_AUTH_URL="https://league.example.com"

docker compose up -d --build
```

compose 会启动 Postgres 16 与应用两个服务；应用容器先跑 `pnpm db:migrate` 再启动，
`/app/data`（`league.json` + 回放）与数据库各自挂载命名卷持久化。应用以**非 root**
用户运行，内置 `HEALTHCHECK` 轮询 `/healthz`。

## 2. 加固旋钮（环境变量）

| 变量 | 默认 | 作用 | 公网建议 |
|---|---|---|---|
| `AFL_MAX_BODY_BYTES` | `1048576`（1 MiB） | 请求体字节上限，超限返回 **413** 并关闭连接，防内存耗尽 | 按最大合法请求体收紧（策略 DSL 很小，可降至 `262144`） |
| `AFL_RATE_AUTH` | `300` /分钟/IP | 认证端点（`/api/auth/*`）限流，超限 **429 + Retry-After**，防暴力破解 | 收紧到 `10`–`30` |
| `AFL_RATE_GLOBAL` | `3000` /分钟/IP | 其余请求全局限流 | 按容量收紧到 `300`–`600` |
| `AFL_TRUST_PROXY` | `0` | 为 `1` 时信任 `X-Forwarded-For` 取真实客户端 IP | 置于反代之后时设 `1` |

默认值偏宽松，以兼容正常对战与 bundled 测试套件；**公网部署务必收紧**（尤其 `AFL_RATE_AUTH`）。
限流为单实例内存滑窗，多实例需共享存储（见已知边界）。设 `AFL_RATE_*=0` 可关闭对应层。

## 3. TLS 反向代理（公网必需）

应用本身只跑 HTTP；公网暴露请置于 TLS 反代之后。nginx 示例：

```nginx
server {
  listen 443 ssl http2;
  server_name league.example.com;
  ssl_certificate     /etc/letsencrypt/live/league.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/league.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # WebSocket（观战 / Agent 通道）
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
}
```

反代之后设 `AFL_TRUST_PROXY=1`，限流才能看到真实客户端 IP（否则所有请求都算在反代 IP 上）。
当请求经 TLS 到达（`X-Forwarded-Proto: https`）时，应用自动下发
`Strict-Transport-Security: max-age=31536000; includeSubDomains`。

## 4. 安全响应头

每个响应都带：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、
`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`（禁摄像头/麦克风/定位）、
以及一条保守 `Content-Security-Policy`（禁 object/外链 framing，允许内联样式脚本与 ws(s) 连接）。
CSP 目前含 `'unsafe-inline'` 以兼容现有前端；确认前端可改用 nonce/hash 后可进一步收紧。

## 5. 健康检查

`GET /healthz`（别名 `/api/health`）免鉴权、不限流，返回
`{ status, version, uptimeSec, accounts }`，供负载均衡 / 编排存活探针使用。

## 6. 验收

```bash
pnpm verify:security   # 6 项：healthz / 安全头 / 条件 HSTS / 413 / 全局 429 / 认证 429
pnpm verify            # 9/9 + C4b/C4c/C4d 版本与探针门禁
pnpm verify:mcp        # 官方 SDK 真实客户端 15/15（需玩家 MCP URL）
pnpm verify:accounts   # 账号流程 20/20（需 AFL_TEST_DATABASE_URL）
```

`verify:security` 用严格参数（小 body 上限、低限流）独立 spawn 服务，证明 413/429 真的会触发。

## 7. 已知边界（本档不覆盖）

- **单实例持久化**：对局 / 队列 / 回放是内存 + 文件（`data/league.json` 同步写盘 + JSONL），
  限流也是内存滑窗。**不能水平扩展**；多实例需把状态与限流搬进 DB/Redis（架构级改动）。
- **WebSocket 连接数 / 背压**：WS 通道已要求合法 token + 玩家身份，但尚无连接数上限与背压保护。
- **可观测性**：尚无指标导出（Prometheus 等）与结构化日志；线上排障依赖 stdout。
- **CSP**：含 `'unsafe-inline'`，待前端 nonce/hash 化后收紧。

这些是公网大规模商业服务前的后续加固项，不影响受邀制 / 基准平台部署。