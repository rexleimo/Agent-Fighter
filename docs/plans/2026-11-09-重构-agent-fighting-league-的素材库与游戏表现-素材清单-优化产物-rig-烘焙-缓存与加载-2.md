# 素材库重构 · Agent Fighting League

> AIOS Planning Contract (schema v3)
> created: 2026-11-09T12:05:38.160Z
> route: implement
> decision: docs/plans/2026-11-09-asset-library.decision.json
> delivery: docs/plans/2026-11-09-asset-library.delivery.json
> asset contract: docs/asset-library.md

## Objective

在不改战斗内核、不引入运行时第三方依赖、不更换原创角色的前提下，把当前“16 张全尺寸 PNG + 全尺寸 mask 运行时合成”的素材用法，重构为可校验、可缓存、按需加载的素材库；同时修复拖累观赛体验的 rig 关节表达、首屏体积和调试层默认值。

## Baseline measured on 2026-11-09

| 指标 | 现值 | 证据 |
| :--- | :--- | :--- |
| `web/assets` 总计 | **19.45 MB** | `du -sh web/assets` |
| 角色立绘 | 16 张，**19.22 MB** | `web/assets/art/*.png` |
| 舞台背景 | **3.87 MB** | `web/assets/art/stage_main.png` |
| rig 目录 | 233 KB（16 × mask.png + rig.json） | `web/assets/rig` |
| 首屏 Live 实际请求 | **16 张立绘 + 舞台 ≈ 19.2 MB** | `web/app.js:1696` 调用 `loadArt(all ids)` |
| 静态缓存 | `Cache-Control: no-cache`，无 ETag | `src/server.js:75` |
| 单张立绘 | 572–875 × 938–1002 px | `sips -g pixelWidth -g pixelHeight` |
| 游戏内显示高度 | 204 CSS px | `web/app.js:439` |
| 立绘到游戏显示的超采样 | 约 4.6–4.9× 线性 | 938–1002 / 204 |
| rig 合成 | 每角色解码整张 mask，再逐部件 `getImageData` | `web/rig.js` |
| 默认调试层 | 判定框 / 骨架 / 距离尺 / 网格全部开启 | `web/app.js:21-26` |
| 音频 | 无 | `web/` 无 audio 相关代码 |

### 已确认的体验问题（来自截图与代码）

1. **首屏重量与“像调试工具”的第一印象**：Live 页先请求全部 16 张立绘，且默认叠加判定框、骨架、距离尺、帧数据条。观众第一眼看到的是开发 overlay，不是一场比赛。
2. **rig 表达不足**：`clamp` 0.32–0.62 rad、`spin` 0.45–1.0 把服务端 50–100 px 的关节位移压成很小的摆动；`walk`、`lp`、`hp`、`special` 在 rig lab 里几乎同形。`web/rig.js:126` 的 `MAX_PART_SPIN` 与 `scripts/rig-bake.mjs:45-51` 的 clamp 是直接原因。
3. **部件归属错误**：模板骨架假设“正面、双手前伸”，对 actual pose 不一致的角色会切错。例：`coral` 交叉手臂导致盾牌/胸甲被前臂拖走；`tide` 的长发/大衣被后臂和躯干瓜分；`forge` 的锤头被归到 `head`，转头的姿态会拖动锤头。证据：`.tmp-rig/coral.png`、`.tmp-rig/tide.png`、`.tmp-rig/forge.png`（`node scripts/rig-bake.mjs --overlay`）。
4. **舞台与角色的对比不足**：立绘中暗部较多，背景霓虹细节密集，角色在中远景下轮廓不够突出；缺少角色聚光/地面接触阴影的层次。
5. **资产不可校验**：文档声称 rig bake 会输出 `<part>.pad.png`，实际只写 `mask.png` + `rig.json`；没有 manifest、没有尺寸/alpha/覆盖率/字节预算门禁；`verify-art.mjs` 在 macOS 上因 Chrome 候选路径只有 Windows 而直接失败。
6. **无音频反馈**：命中、防御、KO、超必杀都只有视觉反馈，观赛的瞬时反馈弱。

## Scope

- 素材源与派生产物分层、manifest、哈希、缓存、按需加载、回退。
- rig 预烘焙 atlas、运行时不再解码全尺寸 mask；提高 articulation；为最明显的 3–6 个角色增加 per-fighter override（头发/武器/盾牌/大衣）。
- 观赛表现：默认关闭调试层（保留一键“技术视角”）、舞台分级与角色聚光、程序化 WebAudio 音效（无音频素材依赖）。
- 校验：素材 manifest、尺寸、alpha、rig 覆盖率、字节预算、Chrome 实拍。

## Non-goals

- 不改 `src/rules.js` 帧数据、`src/combat.js` 判定、`src/engine.js` 内核、匹配/排名协议。
- 不引入运行时 npm 依赖；`cwebp` 仅作为构建期可选优化，缺失时回退 PNG。
- 不重新生成 16 张角色立绘；不更换角色设定与版权策略。
- 不做 30–60 套逐帧动画；仍走“1 张立绘 + 拆件 rig”的路线。

## Work-item graph

| id | outcome | dependsOn | verification |
| :--- | :--- | :--- | :--- |
| `work-inventory` | 源素材移到 `assets/source/`，冻结 manifest schema 与目录契约；记录基线 | — | `docs/asset-library.md` + `docs/plans/2026-11-09-asset-library.decision.json` |
| `work-build` | `npm run assets:build` 生成 sprite/card/stage 派生与 `web/assets/manifest.json`；`assets:check` 校验 | `work-inventory` | 两次构建 hash 相同；`node scripts/validate-assets.mjs` 全绿；字节预算 |
| `work-rig` | rig 预烘焙为 atlas + 紧凑 JSON；提高关节表达；per-fighter override；运行时零 mask 合成 | `work-inventory` | `npm run verify:anim` + rig lab 截图；`idleVsHp > 1500`、`idleVsWalk > 800` |
| `work-server` | `/assets/manifest.json`、稳定资产路由、immutable 缓存、ETag/gzip | `work-inventory` | `curl -I` 头断言；`npm run verify` |
| `work-runtime` | Live 只加载当前 2 位角色；图鉴进入视图才懒加载；`decode()`；失败回退 | `work-build`, `work-rig`, `work-server` | `npm run verify:art`；首屏传输 < 1.5 MB；0 JS 异常 |
| `work-feel` | 默认广播模式（调试层关闭）、舞台分级、角色聚光、WebAudio 音效开关 | `work-runtime` | 截图对比；`audio.js` 单测；0 控制台错误 |
| `work-verify` | 全量验收、截图、字节报告、AIOS evidence | `work-build`, `work-rig`, `work-server`, `work-runtime`, `work-feel` | `verify` / `verify:combat` / `verify:art` / `verify:anim` / `verify:assets` / `verify:mcp` |

### Dependency notes

- `work-build`、`work-rig`、`work-server` 可并行：分别拥有构建脚本/产物、rig 脚本/渲染器、服务端路由/缓存；共同只读 `docs/asset-library.md` 的 schema。
- `work-runtime` 必须等三者的产物和 URL 契约稳定后做，避免在 `web/app.js` 里反复改路径。
- `work-feel` 与 `work-runtime` 都改 `web/app.js`，串行；`work-feel` 只在其后动 draw 默认值与新增 `web/audio.js`。
- `work-verify` 是唯一允许把所有检查合并成最终证据的节点。

### Parallel groups

```text
G0: work-inventory
G1: work-build | work-rig | work-server
G2: work-runtime
G3: work-feel
G4: work-verify
```

### Frontier

- ready: `work-inventory`
- blocked: 其余（等待依赖）
- critical path: `work-inventory → work-build → work-runtime → work-feel → work-verify`

## Acceptance criteria

### Asset delivery

- `web/assets` 总量 **≤ 8 MB**；Live 首屏实际传输 **≤ 1.5 MB**（不含浏览器缓存命中）；图鉴 16 张 card 懒加载 **≤ 2.5 MB**。
- 每次构建可复现：同一输入两次构建 `buildId` 与每个文件名 hash 相同。
- `node scripts/validate-assets.mjs` 校验：manifest 完整、文件存在、尺寸/alpha、rig 关节在界内、部件非空、无孤儿文件、字节预算。
- 原图不再通过 Web 暴露；`assets/source/` 只作为构建输入。

### Rig

- 运行时只加载 `atlas.webp` + 紧凑 `rig.json`，不再加载/合成 `mask.png`。
- 16 位角色 `rig lab`：`idleVsHp > 1500`，`idleVsWalk > 800`，所有姿态 non-empty；无 JS 异常。
- 至少修复 `coral`（盾牌/胸甲）、`tide`（长发/大衣）、`forge`（锤头）三处明显归属错误；截图对比存档。
- 任意姿态的部件旋转不超过其 clamp；clamp 提升后仍无可见裂缝（或由 seam backing 覆盖）。

### Game experience

- 默认进入 Live 是广播视图：判定框/骨架/距离尺/网格关闭；工具栏保留“技术视角”一键全开。
- 角色与舞台之间有明确的明度/色彩层次（舞台分级或聚光），在中远景能一眼分辨两个角色。
- 命中/防御/KO/超必杀有可开关的程序化音效；无自动播放报错；无外部音频文件。
- 桌面 1440×1250 与移动 390×844 截图各一张，无布局溢出。

### Compatibility

- `npm run verify` 22 项、`verify:combat` 34 项、`verify:anim`、`verify:art`、`verify:mcp` 全部通过。
- `GET /assets/art/<id>.png` 与 `GET /assets/rig/<id>/rig.json` 保持可用（302 到带 hash 的产物），避免破坏已接入的 Agent/回放页面。
- `GET /SKILL.md`、MCP resources/prompts 不受影响。

## Rollback

- 构建产物在 `web/assets/build/`，manifest 是唯一入口；若新产物异常，恢复上一版 manifest + build 目录即可回退，无需改内核。
- rig 渲染器保留“无 atlas 时用整张立绘”的回退分支；单角色失败不影响整场。
- 服务端稳定路由 302 到 manifest；若 manifest 缺失，回退到旧 `/assets/art/<id>.png` 静态文件（构建脚本保留一份兼容副本，或直接由旧路径提供 sprite）。

## Evidence ledger

| work | expected evidence | ref |
| :--- | :--- | :--- |
| `work-inventory` | schema + decision | `docs/asset-library.md`, `docs/plans/2026-11-09-asset-library.decision.json` |
| `work-build` | build/check logs + manifest | `docs/plans/2026-11-09-asset-library.delivery.json#work-build` |
| `work-rig` | rig lab screenshots + verify:anim | `.tmp-rig/lab-after.png`, command output |
| `work-server` | curl header transcript | `verify-assets` output |
| `work-runtime` | verify:art + resource entries | `docs/preview-live.png`, command output |
| `work-feel` | before/after screenshots | `docs/preview-live.png`, `.tmp-rig/mobile.png` |
| `work-verify` | full suite | command output + AIOS evidence |

## Decision log

- 2026-11-09: 选择“素材库契约 + 派生优化 + rig 预烘焙 + 按需加载 + 广播表现”，而不是“只加缓存”或“重画全部立绘”。理由：现有原创立绘可复用；问题主要在交付层与 rig 表达，不在角色设计本身。
- 2026-11-09: 保持零运行时依赖；WebP 由构建期可选 `cwebp` 生成，缺失时回退 PNG。
- 2026-11-09: 不改内核；所有改动限制在 `src/server.js`、`src/assets.js`、`web/`、`scripts/`、`assets/source/`、`docs/`。

## Status

- status: active
- next: `work-inventory`
