# Standards + Spec Review — auth-entry 抽取批次

- fixed-point: `f7c7069` → HEAD `088e3ad`（三点 diff 非空，17 files changed）
- spec 来源：`docs/plans/2026-11-20-refactor-engineering-standards-2026-11-20.md`、`docs/plans/2026-11-20-refactor-decision-ticket.md`

## Standards

依据：`rex-engineering-standards`（§1 边界、§2 深层模块、§4 文件粒度）+ Fowler smell 基线 12 条。

- **hard finding**：无。仓库内没有比工程规范更具体的成文编码标准；新文件均在粒度预算内（`auth-entry.js` 48 行、`captcha.js` 90 行、`useCaptcha.ts` 26 行）。
- **judgement — Middle Man**：`isConfigured()` 只是 `Boolean(auth)` 的转发。建议：可接受，因为它把"是否配置认证"做成 auth-entry 的公开契约，避免调用方直接依赖 better-auth 实例。
- **judgement — Repeated Switches**：`submitCredentials({ kind })` 当前只有两个分支。建议：保持现状，等第三种凭据方式出现再抽象（Speculative Generality 反向约束）。
- smell 逐条：Mysterious Name 未见；Duplicated Code 未见；Feature Envy 未见；Data Clumps 未见；Primitive Obsession 未见；Repeated Switches 轻微（上述）；Shotgun Surgery 未见；Divergent Change 未见；Speculative Generality 未见；Message Chains 未见；Middle Man 轻微（上述）；Refused Bequest 未见。
- 存量越界：`server.js` 824 行仍超预算，已登记 baseline，归 work-4 处理。

## Spec

- D1（禁 try-catch）：新代码零 try-catch；全局 56 处存量归 work-6，本批不宣称完成。✓（本批范围）
- D3（standards 配置）：`config/standards.json` 已落地。✓
- D4（行为保持）：baseline 与 affected 两个 receipt 均 exit 0 / 25-25。✓
- work-2（认证入口分层）：业务逻辑已移出 `server.js`。✓
- scope creep：无。没有新增用户可观察行为。

## Verdict

`pass`（限本批 bounded diff）；整体工作项仍 in progress，剩余 work-3/4/5/6/7 未完成。
