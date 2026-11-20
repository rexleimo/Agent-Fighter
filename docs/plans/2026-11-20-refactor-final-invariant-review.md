# Invariant Review — 全项目重构收口

- baseline receipt: `receipt:b1d9900a-bad5-4821-95e2-55f5738861eb`（exit 0）
- affected receipt: `receipt:63150239-1f8e-4ee6-a131-fc18d554a7c0`（exit 0）
- fixed-point: `088e3ad` → HEAD `b2465d7`

## 副作用与边界审查

- 认证：验证码先消费再调用 better-auth；裸端点仍 403；所有内部 harness 经 `/api/captcha` + `/api/register`/`/api/login`，无绕过路径。
- HTTP：`src/server.js` 仅组装与接线；路由集合、状态码、header、响应体由 `verify`（21/21）、`verify:security`（6/6）、`verify:accounts`（25/25）覆盖。
- 领域拆分：`League`/`Room`/`RoomManager` 入口 re-export 保持导出名与签名；继承链只下沉实现，不改事件协议与数据格式。
- 前端：类型领域化后 `types.ts` 统一 re-export，原 import 路径可用；`stage.js` 入口 API（11 个方法）不变。
- 验收脚本：入口路径与 CLI 行为不变；断言未删、未跳过、未放宽。

## 测试差异审查

- 本批新增断言：`scripts/verify-accounts.mjs` 的 A3a–A3e（裸端点封闭、缺验证码拒绝、解题后进入注册逻辑）。
- 拆分后修复的集成缺陷均为恢复原有语义：`live-control` 的 MCP 局部变量、`live-match` 的 record/mcp/registerAgent、C18 的 SKILL.md 路径、C21 的 openSpectator 参数、ladder 的动态 import 路径、harness 的验证码兼容。
- 未删除任何既有 PASS/FAIL 判定。`verify:assets` 的 gallery card 断言在 HEAD 基线同样失败（已用临时 worktree 证实），未作修改。

## 测试专用出口

- `src/auth-entry.js`、`src/json-result.js`、`scripts/lib/no-throw.mjs`、`scripts/lib/captcha-auth.mjs` 均只导出生产/验收所需接口，无 test-only 产品出口。

## 硬规则终检

- `grep -rnE '\btry[[:space:]]*\{' src frontend/src scripts sdk examples web bench`（排除 dist）→ **0 处**。
- 所有代码文件 ≤400 行（最大 394）。

## 结论

行为保持成立；无测试专用出口；无断言弱化；`behavior-preserving-hardening` 路径有效。
