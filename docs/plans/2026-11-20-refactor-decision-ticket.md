# Decision Ticket — 全项目软件工程规范重构

- id: `decision-refactor-2026-11-20`
- work-item: `refactor-engineering-standards-2026-11-20`
- status: decided
- decided-at: 2026-11-20
- decided-by: 用户确认（本会话）

## D1 — 禁止 try-catch，含存量

- **决策**：从现在起 `src/`、`frontend/src/`、`scripts/` 中禁止 `try { } catch`。存量 56 处（后端 36 + 前端 20）同样要清除。
- **依据**：用户明确确认"作为新硬规则"。审计事实：全仓（AGENTS.md / CLAUDE.md / GEMINI.md / docs / skills / .aios / .rex-harness）此前**不存在**此规则；工程规范原文只要求"用异常表达失败、错误携带上下文、不吞异常"。
- **被拒选项**：
  - 保留既有写法 —— 与用户确认冲突。
  - 只管新增代码、不追溯存量 —— 用户明确否掉。
- **后果**：每个切片都要把错误路径改为显式结果类型（如 `Result` / `{ ok, error }`）或边界层的统一错误映射；不能靠 try-catch 兜底。

## D2 — 全项目分批重构，按可验证纵向切片分步

- **决策**：用 7 个 `work-*` 工作项组成依赖图，不按文件列表机械排列。
- **依据**：目标是行为保持的结构治理；每个切片必须独立产出可验证结果。
- **被拒选项**：一次性全量重写 —— 约 1.5 万行、十几个文件，无法逐批验证，风险不可控。

## D3 — 先补 `config/standards.json` 作为门禁基线

- **决策**：work-1 落地行数/职责门禁配置，并记录当前基线（7 个超限后端文件、56 处 try-catch）。
- **依据**：`rex-engineering-standards` 明确"行数的单一事实源是 `config/standards.json` 的 `budgets`"；仓库当前没有该文件，因此任何"达标"判定都不可判定。

## D4 — 行为保持是硬完成条件

- **决策**：每个切片完成后必须跑通现有验收；不得靠弱化断言、删用例换取通过。
- **验证集合**：`pnpm build:web`、`pnpm lint:web`、`pnpm test:web`、`pnpm verify`、`pnpm verify:accounts`、`pnpm verify:security` 及对应领域脚本。
