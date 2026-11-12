# Web 架构

> 状态：v0.7 · React + TypeScript + Vite 前端 · Postgres + Drizzle 账号存储

## 1. 为什么换掉字符串模板

旧前端是 `innerHTML = '...' + value + '...'`。它有三个工程问题：

- **XSS 面**：每个插值都必须手写 `esc()`，漏一处就是注入；玩家显示名、战队名、MCP URL 都是用户输入。
- **状态与 DOM 脱节**：全量 `innerHTML` 重绘会丢焦点、输入和滚动位置；为了 busy 状态不重绘，只能打补丁。
- **没有组件边界**：`web/app.js` 到迁移前已接近 2000 行，登录、大厅、回放、Canvas 全混在一起。

新前端用 JSX（自动转义）、组件、类型和表单校验替代手写字符串。

## 2. 目录

```text
frontend/
  index.html              Vite 入口
  vite.config.ts          dev proxy + build -> web/dist
  src/
    main.tsx              QueryClient / Router / global styles
    App.tsx               路由与页面壳
    components/
      TopBar / Footer / Sprite
      account/            AuthCard / McpCard / AgentStatusCard / AdminPanel
      live/               StageCanvas / TeamStrip / Intermission
    pages/                Live / Lobby / Fighters / Board / Replay / Connect / Account / Guide
    hooks/                useAppState / useSpectator
    lib/                  typed fetch (`api`) + protocol types
    game/stage.js         imperative Canvas renderer (extracted from the old app)
    styles/app.css        auth / guide / app shell styles
    types/                ambient declarations for the shared JS renderer modules
  vitest.config.ts
```

`web/` 保留静态素材和可复用渲染模块：`assets/`、`sprite.js`、`rig.js`、`fx.js`、`impact-fx.js`、`audio.js`、`asset-store.js`、`styles.css`、`team.css`、`account.css`、`guide.css`。旧的 `web/app.js`、`web/team.js`、`web/account.js`、`web/index.html` 已删除。

## 3. 数据流

| 场景 | 通道 |
| :--- | :--- |
| 页面初始状态 / 大厅 / 榜单 / 图鉴 | `GET /api/state`、`/api/rooms`、`/api/fighters`、`/api/leaderboard`（TanStack Query） |
| 实时观战 | `WS /ws/spectate?room=<roomId>` → `hello / tick / match_start / round_start / intermission / match_end` |
| 回放 | `GET /api/matches` + `GET /api/replay/:id?render=1` |
| 玩家账号 | `/api/auth/*`、`/api/me/*`、`/api/admin/players/*`（Cookie session） |
| Agent 控制面 | `POST /mcp/<玩家 key>`，21 个 MCP 工具 |

## 4. 为什么 Canvas 不用 React 渲染

一局 600 拍、每拍 6 个渲染帧，60fps 画面如果每帧都进 React state，会产生大量无意义的 diff。做法是：

- React 负责页面结构、HUD、事件流、工具按钮、队伍条。
- `StageCanvas` 用 `useRef` 持有 canvas，`requestAnimationFrame` 从帧队列取帧，调用 `game/stage.js` 的 `draw()`。
- `useSpectator` 用 reducer 管 10Hz 的 tick 消息，帧队列放在 ref 里；Canvas 不阻塞 React 渲染。
- `game/stage.js` 是从旧 `app.js` 的 canvas 段落抽出来的命令式 renderer，React 只通过 props 更新 `showBoxes / showBones / ...` 和 match 上下文。

这是 Three.js / 游戏引擎在 React 里常见的集成方式：**DOM 归 React，像素归命令式渲染器**。

## 5. 账号数据

- **better-auth** 拥有 `user` / `account` / `session` / `verification`，负责密码哈希、登录、session 和 cookie（`src/auth.js`）。
- **`players`** 只存游戏档案：`role`、`agentId`、`mcpKey`，通过 `players.userId` 关联 better-auth 用户。
- **`src/players-postgres.js`** 读取档案时 `players join user`，把用户名 / 显示名映射出来。
- **没有 `DATABASE_URL`**：better-auth 不构造，auth / 玩家接口返回 503；游戏、观战、匿名 MCP 仍可跑，用于离线回归。

表结构、迁移和运维命令见 `docs/player-accounts.md`。

## 6. 开发与构建

```bash
pnpm dev:web       # Vite dev server，代理 /api /mcp /ws /assets 到 8787
npm start          # prestart: pnpm build:web；然后 Node 服务 web/dist
pnpm build:web     # tsc --noEmit + vite build -> web/dist
pnpm test:web      # Vitest + Testing Library
pnpm lint:web      # ESLint flat config
```

生产环境由 `src/server.js` 直接服务 `web/dist`：`/`、`/lobby`、`/fighters`、`/board`、`/replay`、`/connect`、`/account`、`/guide` 都回退到 `web/dist/index.html`；`/app/*` 是 Vite 的哈希资源；`/assets/*` 是游戏素材。

## 7. 后续

- 路由级 `React.lazy` 拆包（当前单包约 690KB）。
- 增加 React error boundary 与请求错误 toast。
- 把 `StageCanvas` 的工具状态持久化到 URL / localStorage。
- 账号表增加邮箱、找回密码、登录限流与审计日志；公网部署前必须有 HTTPS。
- 对局 / 队列 / 回放从 JSON 迁到 Postgres 前，先解决 `league.json` 整文件重写与回放文件数量增长。
