# Invariant Review — auth-entry 抽取批次

- activation: `55b64637-1ad9-4f92-aec5-ff13297b96df`
- baseline receipt: `receipt:5040b7d1-ddd5-4e02-a9f3-beb7996c9a17` (exit 0)
- affected receipt: `receipt:e98ebad6-06a8-4ed8-b9f8-aa5d2507fab0` (exit 0)

## 副作用路径审查

- `submitCredentials()` 先 `captcha.verify()`（内部消费 token），通过后才调用 better-auth；验证码失败时不会创建用户、不会发 session cookie。
- `issueChallenge()` 返回时把 `token` 从响应体中解构剔除：`const { token, ...payload } = challenge`；HTTP 边界只把 token 写入 httpOnly cookie。答案始终只存在服务端 Map。
- 裸 better-auth 端点 `/api/auth/sign-up/email`、`/api/auth/sign-in/username` 仍在 catch-all 前返回 403，绕过路径未打开。
- 错误映射保持原语义：wrong password 仍由 A17 验证为 401；缺少验证码仍为 400 + `CAPTCHA_INVALID`。

## 测试差异审查

- 本批未改动 `scripts/verify-accounts.mjs`（工作区中的修改来自更早的验证码功能批次）。
- 累计测试差异全部是**新增**断言：A3a/A3b（裸端点 403）、A3c/A3d（缺验证码 400）、A3e（解出验证码进入注册逻辑）；没有删除、跳过或放宽任何原有断言。
- baseline 与 affected 两次 receipt 均为 exit 0、25/25 通过，场景命令逐字一致（`node scripts/verify-accounts.mjs`）。

## 测试专用出口

- `src/auth-entry.js` 只导出生产接口 `issueChallenge` / `submitCredentials` / `isConfigured`，没有 test-only 导出。

## 环境缺陷（非代码问题）

- `aios standards check` 在本机安装下报错 `runStandardsArgs is not a function`；直接跑 `scripts/aios-standards.mjs` 报缺少同名导出。因此 `config/standards.json` 已作为唯一事实源落档，但门禁命令本身不可用，A9 暂不能用该命令取证，改用行数统计。

## 不变量结论

行为保持成立；没有新增用户可观察行为；没有测试专用产品出口；没有放宽断言。继续 `behavior-preserving-hardening` 路径有效。
