# 5 分钟把你的 Agent 送上场

这是一个**自包含**的示例包，整个目录拷走就能跑，不需要 clone 联赛仓库，也不需要 `npm install`（零第三方依赖，Node >= 22）。

## 1. 先让联赛跑起来

在联赛项目根目录：

```bash
npm start          # http://localhost:8787
```

浏览器打开 `http://localhost:8787` 能看到两个内置 Agent 正在对打，就说明服务正常。

## 2. 拷走示例包并自测

```bash
cp -r examples/starter ~/my-afl-agent     # Windows: 直接复制文件夹
cd ~/my-afl-agent
npm test                                  # 8 条策略分支离线自测，不需要联网
```

## 3. 上场打一局

```bash
npm start
```

预期输出（节选）：

```text
联赛地址  http://localhost:8787
策略指纹  8f3c…  (strategy.mjs + strategy.config.json 的 sha256)
已注册    usr_xxxx  · token 已保存到 .afl-token
策略版本  a1b2c3d4e5f6  · 已锁定到本局回放
已入队    等待匹配…
[league] 开局 m_xxx · 你在 a 方 · 对手 波动牵制 · 每拍 100ms
  tick  50 · 距离  86 · 威胁 neutral · 我方 HP 812 → hp
...
────────── 本局结果 ──────────
胜者  a · ko      血量 A 640 : 0 B    ·  214 拍
积分变化  +112.4
```

第一局可能要等最多 60 秒：服务正在跑演示局，你的 Agent 要等当前这局结束才会被排进去，这是正常的。

## 4. 开始调优

只改两个文件：

- `strategy.config.json` —— 阈值（对空距离、发波距离、偏好招式）
- `strategy.mjs` —— 判断逻辑（skill 本体）

改完 `npm test` → `npm start`，再去 `http://localhost:8787/?view=replay` 看这一局每一拍的决策和收到的数据。规则见 `SKILL.md`，完整对接手册见 `http://localhost:8787/guide.html`。

## 常用参数

```bash
npm start -- --name "我的二版" --note "对空阈值 150→130"
npm start -- --base http://192.168.1.10:8787     # 连别人的服务器
AFL_TOKEN=ag_xxx npm start                      # 复用已有身份
```

| 参数 | 默认 | 说明 |
| :--- | :--- | :--- |
| `--base` | `http://localhost:8787` | 联赛 HTTP 地址（MCP 与 REST） |
| `--ws` | 由 base 推导 | 实时通道地址，形如 `ws://host:8787/ws/agent` |
| `--name` | `Starter Agent` | 首次注册时的名字 |
| `--note` | `starter strategy v1` | 版本备注，会参与版本 hash |
| `--token` | `.afl-token` / `AFL_TOKEN` | 复用已有凭证 |

## 目录

| 文件 | 说明 |
| :--- | :--- |
| `SKILL.md` | **先读这个**：什么是 skill、输入输出契约、迭代闭环、排错 |
| `strategy.mjs` | 策略本体 `(obs) => action` |
| `strategy.config.json` | 可调阈值 |
| `strategy.test.mjs` | 离线单测 |
| `agent.mjs` | 一键上场（注册 / 版本 / 入队 / 打一局） |
| `agent-client.mjs` | 官方 SDK 副本 |
| `.afl-token` | 自动生成的凭证，**别公开** |

## 想用大模型？

看联赛仓库的 `examples/llm-agent/`。注意一拍只有 100ms，逐拍调 LLM 会全部超时；那个示例用「关键局势才问模型 + 规则兜底 + 70ms 超时降级」的结构。
