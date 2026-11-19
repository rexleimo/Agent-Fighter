# UI 审美审计（Jev / TypeSafe）

用 Jev（TypeSafe 的 System One 决策模型）对页面截图做一次**大众审美**评分。它是方向性信号，不是真理——先用自己的样例校准，再决定是否作为自动化门禁。

## 前置条件

- Node 24+（仓库 engine 已是 `>=22`，但实际用 24 的 `NODE_USE_ENV_PROXY`）。
- `TYPESAFE_API_KEY`：从 [TypeSafe console](https://console.typesafe.ai/keys) 获取，仅放在环境变量里，切勿提交。
- macOS 的 `sips`（图片归一化）与 Google Chrome（`--capture` 模式）。
- 网络：若 Jev 返回 451（区域封锁），配置代理。脚本会依次尝试 `HTTPS_PROXY` → macOS Wi-Fi 系统代理；也可显式 `--proxy http://host:port`。

## 用法

```bash
# 审计一张已有截图，输出 JSON 产物
TYPESAFE_API_KEY=... node scripts/audit-ui-aesthetics.mjs \
  --screenshot ./shot.png --out ./audit.json

# 直接用无头 Chrome 抓取某 URL（需本机跑着 dev server），并设门禁阈值
TYPESAFE_API_KEY=... node scripts/audit-ui-aesthetics.mjs \
  --capture http://localhost:5173/lobby --gate 0.6 --context "AI 对战观战大厅"
```

产物 JSON 字段：

- `composite`：0–1 的大众审美综合分（维度分数归一化后按代码里的权重加权）。
- `dimensions`：5 个窄维度的原始分、归一化分、置信度、权重。
- `audience`：最契合受众的 Choice 及各选项概率。
- `emptyStatePenalty`：空数据状态是否是扣分主因的 Noul（低 → 设计本身是主因）。
- `usage`：本次调用的 token 用量。

## 判定框架（Jev composite scoring）

一次请求里并行问 7 个问题，权重在 `scripts/audit-ui-aesthetics.mjs` 的 `SCORE_QUESTIONS` 里硬编码，改权重无需重跑 prompt：

| 维度 | 权重 | 关注点 |
|---|---|---|
| `text_readability` | 0.25 | 普通用户的字号/对比可读性 |
| `visual_warmth` | 0.25 | 亲切感 vs 终端冷感 |
| `layout_clarity` | 0.20 | 层级与首屏可扫读性 |
| `modern_feel` | 0.15 | 现代感 |
| `color_harmony` | 0.15 | 配色和谐统一 |

外加 `audience`（受众 Choice）与 `empty_state_penalty`（排除空数据干扰）。Score 的 `score` 是概率加权的位置，`confidence` 是分布集中度——**不是答案正确率**；Noul 接近 0.5 表示 yes/no 接近，不是"中等强度"。

## 校准与边界

- 当前产物是对**目标受众（电竞/技术用户）**友好的暗色控制台风格；用"大众审美"尺子量天然吃亏在冷、暗、小字。分数低不等于设计有缺陷。
- 阈值（`--gate`）必须用自己的样例标定：先跑一组你认为"好/坏"的页面，看分数分布再定线。
- Jev 是快速结构化决策模型，不生成文字、不做长链推理；它不替代人工审美评审。
- 每次调用按 token 计费（`usage` 字段可见），图片越大越贵；批量审计前先估成本。

## 参考

- 方法论与 API：[TypeSafe docs](https://docs.typesafe.ai/llms.txt)、[composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md)、[Score](https://docs.typesafe.ai/primitives/score.md)、[Images](https://docs.typesafe.ai/images.md)。
