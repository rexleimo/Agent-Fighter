# Agent Fighting League · 模型能力基准（Model Benchmark）

一套**标准化、可复现、模型无关**的评测 harness，用确定性对战内核测量大模型的代理能力。
它测的是静态基准（MMLU 那类）测不到的东西：**实时序贯决策、延迟约束下的推理、预算约束、对手建模、工具使用与迭代自改进**。

代码在 `scripts/bench/`，自检 `pnpm bench:selftest`（11 项，离线无需 API key）。

---

## 1. 为什么这个基准严谨

| 特性 | 来源 | 对基准的意义 |
| :--- | :--- | :--- |
| **确定性内核** | `src/engine.js` 定点数纯函数，同 seed + 同 action 永远同结果 | 可在**完全相同条件**下对比模型，做统计显著性检验 |
| **客观量化** | 胜负 + Wilson 置信区间 + 延迟分位数 | 无需主观打分 |
| **对手实测校准** | round-robin 实测基线强度排序（不假设） | 难度阶梯是测出来的，不是拍脑袋 |
| **预算服务端强制** | 每局模型调用上限，超出回落 | 测资源分配，且难刷分 |
| **推理 / 延迟分离** | 托管模式无延迟压力；实时模式实测延迟 + 截止门控 | 区分「聪明但慢」与「快但笨」 |

---

## 2. 两条模式，分离两种能力

### `hosted` —— 推理隔离（推荐测纯推理）
模型**一次性创作**一份声明式 DSL 策略（无每拍时间压力），harness 用确定性内核把它对每个对手 × 每个 seed 打分。
- 测：**规划 / 规则合成 / 代码能力**。
- 没有逐拍延迟，胜率纯粹反映策略质量。
- 报告含策略 `versionHash`、规则数、创作耗时。

### `realtime` —— 延迟下的代理能力
模型通过 `observe → act` 异步循环**逐拍决策**，harness 实测每次决策的真实墙钟延迟。
联赛截止（默认 80ms）**门控动作是否生效**：迟到的动作被替换为 `defaultAction` 并记一次 timeout（与真实服务端一致），但完整延迟仍被记录，慢尾可见。
- 测：**实时控制 / 具身代理 / 延迟管理**。
- 报告含延迟分布（mean/p50/p95/p99/max）、timeout 率、预算超出、每局调用数。

> **推理 / 延迟分离的关键用法**：同一模型跑两次实时——
> 一次默认截止（`--deadline-ms 80`，受约束），一次放松截止（`--deadline-ms 100000`，oracle）。
> **受约束胜率 − oracle 胜率 = 该模型的延迟代价**。oracle 胜率反映纯决策质量，差值反映推理速度拖累。

---

## 3. 标准协议（`scripts/bench/protocol.mjs`）

每次评测在**完全相同**的条件下进行，报告记录全部条件以便复现：

| 项 | 默认 | 说明 |
| :--- | :--- | :--- |
| seed 集 | 24 个固定 seed | 样本量；`--seeds N` 调整（越大置信区间越窄）|
| 对手 | random / turtle / zoner / brawler | 官方基线，**实测校准**排序 |
| 角色 | `quartz` 镜像 | 双方同角色，比策略不比counter-pick；`--fighter` 改 |
| 每局拍数 | 600 | `--ticks` |
| 模型预算 | 8 次/局 | `--budget`，实时模式服务端强制 |
| 决策截止 | 80ms | `--deadline-ms`，实时模式 |
| 规则版本 | 2.1 | 随内核 |

**对手校准**：评测前对基线做 round-robin（`CALIBRATION_SEEDS`，独立 seed），按实测胜场排序。
报告里的 `calibration` 记录每个对手的校准胜率与 `versionHash`。
> 实测发现：quartz 镜像下 `zoner > random > turtle > brawler`——「噪声基线」其实比「强攻基线」强。
> 这正是要**实测而非假设**难度的原因。

---

## 4. 运行

```bash
# 离线参考（无需 API key，验证链路 / 当基线）
pnpm bench -- --mode hosted
pnpm bench -- --mode realtime

# 真实模型（任何 OpenAI 兼容 /chat/completions 端点）
AFL_LLM_KEY=sk-... AFL_LLM_BASE=https://api.openai.com/v1 AFL_LLM_MODEL=gpt-4o-mini \
  pnpm bench -- --mode hosted --adapter openai

AFL_LLM_KEY=sk-... pnpm bench -- --mode realtime --adapter openai --model gpt-4o-mini

# oracle（放松截止，测纯决策质量）
AFL_LLM_KEY=sk-... pnpm bench -- --mode realtime --adapter openai --deadline-ms 100000

# 加大样本量收窄置信区间
pnpm bench -- --mode hosted --seeds 60

# 对比两个模型
pnpm bench:compare -- bench/reports/A.json bench/reports/B.json

# 一键标准套件（hosted + realtime受约束 + oracle，算出延迟代价）
pnpm bench:suite -- --preset standard-v1                 # 离线参考
AFL_LLM_KEY=sk-... pnpm bench:suite -- --adapter openai --model gpt-4o-mini

# 多模型排行榜（聚合已有套件报告，离线）
pnpm bench:leaderboard -- --reports bench/reports
# 或对多个模型批量跑套件再排名（需 key）
AFL_LLM_KEY=sk-... pnpm bench:leaderboard -- --models gpt-4o-mini,gpt-4o --preset quick-v1

# 自检（15 项，离线）
pnpm bench:selftest
```

报告写入 `bench/reports/<mode>_<adapter>_<timestamp>.json`（gitignored，可由协议复现）。

**适配器**（`--adapter`）：
- `openai`：OpenAI 兼容端点，`temperature` 默认 0（可复现）。`authorStrategy` 带 JSON 解析 + 校验 + 有界重试；`decide` 解析单动作。
- `reference`：确定性参考（托管=canonical 模板策略；实时=brawler 规则），无网络。
- `passive`：只格挡的弱地板，用于证明 harness 能区分强弱。

---

## 4b. 标准套件与排行榜（发表级工作流）

**冻结预设**（`presets.mjs`）是可比较性的单位：`standard-v1`（24 seed）/ `quick-v1`（8 seed）钉死全部参数。
改任何参数都要 bump 名字（`standard-v2`），**绝不静默改已发布预设**，否则旧报告失去可比性。

**一键套件**（`pnpm bench:suite`）对单个模型跑预设的全部评测（hosted + realtime受约束 + oracle），
输出能力画像并算出**延迟代价 = oracle 胜率 − 受约束胜率**。两份套件报告可直接对比。

**排行榜**（`pnpm bench:leaderboard`）按**推理胜率**（hosted，延迟隔离）排名，oracle / 受约束 / 延迟代价并列展示，
让读者看到模型「为什么」排在这个位置。输出控制台表格 + JSON + Markdown。两种构建方式：
聚合已有报告（`--reports`，离线）或对多模型批量跑套件（`--models`，需 key）。

**模型侧 seed**：OpenAI 适配器默认发送 `seed=42`（`AFL_LLM_SEED` 可改）+ `temperature 0`。
这是 best-effort 复现——供应商不保证即使带 seed 也确定，故严谨对比仍须多 seed / 多局平均。

## 5. 指标解读

报告把指标**明确分区**：

- **REASONING**（推理质量）：总胜率 + 逐对手胜率，各带 **Wilson 95% 置信区间**。
  7/10 和 70/100 都是「70%」但证据量不同——看区间，别只看点估计。
- **LATENCY**（速度，仅实时）：决策耗时 mean/p50/p95/p99/max、timeout 率、预算超出、模型调用数。
- **EFFICIENCY**（效率，仅实时）：每局调用数、每局 timeout 数。

`hosted` 没有 LATENCY 分区——它本就无逐拍延迟，胜率即推理质量。

---

## 6. 公平性控制与诚实边界

1. **延迟混淆**：实时赛道里慢而聪明的模型会输给快而笨的（截止门控）。
   → 用 oracle 对照分离；测纯推理优先用 `hosted`。
2. **模型随机性**：内核确定，但模型有随机性。`temperature 0` + 多 seed 取统计；发表级需固定模型侧 seed 并多局。
3. **样本量**：默认 24 seed × 4 对手 = 96 局，单对手 Wilson 区间约 ±18pp（p=0.5）。要 ±5pp 需 ~300+ 局/对手。
4. **污染 / 过拟合**：模型可能背帧数据。发表级需 held-out 局面 / 角色。
5. **prompt 脚手架**：适配器内置统一 system prompt；对比模型时脚手架一致，差异归于模型本身。
6. **侧别**：模型恒为 A 方。内核侧对称（同策略镜像必平，已验证），故 A 方中性。
7. **自报不信任**：`modelCalls` 由适配器自报，但延迟与预算由 runner 实测，评分不依赖自报。

---

## 7. 复现

- `hosted`：同协议 + 同策略 JSON ⇒ 逐字节相同结果。钉住 `strategy.versionHash`。
- `realtime`：适配器确定（temperature 0 / reference）时胜率可复现；延迟随主机负载变化，截止下的胜率依赖它。
- 报告含 `harness.version`、`protocol`、`opponents[].versionHash`、`calibration`、`adapter.config`、`reproducibility`。

## 8. 文件

| 文件 | 职责 |
| :--- | :--- |
| `protocol.mjs` | 协议常量 / seed / 角色 / CLI 解析 |
| `opponents.mjs` | 对手阶梯 + 实测校准 |
| `adapters.mjs` | 模型适配器（openai / reference / passive）|
| `runner.mjs` | 托管 + 实时对局运行器 |
| `stats.mjs` | Wilson 区间 / 延迟分位数 |
| `report.mjs` | 报告构建 + 控制台渲染 + 落盘 |
| `run.mjs` | CLI 入口 |
| `presets.mjs` | 冻结命名预设（standard-v1 / quick-v1）|
| `suite.mjs` | 一键标准套件 + 延迟代价 |
| `leaderboard.mjs` | 多模型排行榜（聚合 / 批量）|
| `compare.mjs` | 两份报告对比 |
| `selftest.mjs` | 15 项离线自检（含 mock LLM 端点）|