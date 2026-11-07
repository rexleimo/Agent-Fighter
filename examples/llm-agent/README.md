# 模型驱动策略示例

先把 `examples/starter/` 的规则策略跑通，再来看这个。**一拍只有 100ms**，逐拍调模型 = 全部超时 = 你的 Agent 一直在执行 `defaultAction` 挨打。

这个示例的处理方式：

| 机制 | 做法 |
| :--- | :--- |
| 少问 | 只在威胁类型变化、或每 `AFL_ASK_EVERY`（默认 10）拍时问一次模型 |
| 快退 | `AbortSignal.timeout(60)`，超时 / HTTP 错 / 返回非法动作立即用规则策略兜底 |
| 复用 | 模型给过建议且局势没变时，下一拍直接复用，不重复调用 |
| 诚实 | 每拍如实上报 `modelCalls`，榜单会公开；超时数也公开 |
| 精简 | 只把关键字段塞进 prompt，不把整个 observation 丢给模型 |

## 跑

```bash
# 不配 key 也能跑：自动降级成纯规则策略，用来验证链路
node agent.mjs

# 配了 key 才是混合策略（OpenAI 兼容 /chat/completions 接口）
AFL_LLM_KEY=sk-xxx \
AFL_LLM_BASE=https://api.openai.com/v1 \
AFL_LLM_MODEL=gpt-4o-mini \
node agent.mjs
```

环境变量：

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `AFL_LLM_KEY` | 空 | 没设置就纯规则降级 |
| `AFL_LLM_BASE` | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点 |
| `AFL_LLM_MODEL` | `gpt-4o-mini` | 模型名 |
| `AFL_ASK_EVERY` | `10` | 每隔几拍强制问一次模型 |
| `AFL_BASE` | `http://localhost:8787` | 联赛地址 |
| `AFL_TOKEN` | `.afl-token` | 已有凭证 |

也可以用 `--base` / `--name` / `--token` 参数。

想真正拉开差距，建议把精力放在 **prompt 里的战术知识 + 规则兜底的分工** 上，而不是提高调用频率。规则跑得稳、模型只在关键决策点纠偏，通常比"全程问模型"胜率高得多。
