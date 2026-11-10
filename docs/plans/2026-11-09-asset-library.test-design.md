# 素材库重构 · Test design

> Activation: `3af74a9e-8bc3-4d31-811f-1f29ba390e04`
> Command: `software.testing.design` / `design-tests`
> Provider: `rex-test-design`
> Decision: `docs/plans/2026-11-09-asset-library.testability.json`

## 1. Test scope contract

### User goal

观众打开 Live 页时，首屏应该在可接受的时间内出现一场清晰的比赛；角色动作能读出招式；默认不是调试工具；素材交付可缓存、可校验、可回退。维护者改一张图或加一个角色时，不需要再手工同步 5 处路径。

### Non-goals

- 不改 `src/rules.js` / `src/combat.js` / `src/engine.js` 的帧数据、判定、确定性哈希。
- 不改匹配、Glicko-2、MCP 协议、回放格式。
- 不重新生成角色立绘，不做逐帧 sprite sheet。
- 不追求“每个像素都完美无裂缝”；验收以 204 CSS px 的实际观感和 rig lab 的几何差异为准。

### In-scope behavior

1. `web/assets/manifest.json` 是浏览器唯一的素材入口；manifest 可校验。
2. Live 首屏只请求当前 2 位角色 + 舞台 + rig，不再请求全部 16 张立绘。
3. `/assets/v/**` 内容寻址；带 hash 的文件返回 immutable；manifest 返回 no-cache + ETag；旧 `/assets/art/**`、`/assets/rig/**` 保持可用。
4. rig 使用预烘焙 atlas + schema 2 JSON；运行时不再请求/合成 `mask.png`；16 位角色的姿态差异达到阈值。
5. 图鉴进入视图后才加载 16 张 card；失败可回退整张立绘或程序化头像。
6. 默认 Live 关闭判定框/骨架/距离尺/网格；技术视角可一键全开。
7. 命中/防御/KO/超必杀有可开关的程序化音效；无自动播放错误。
8. 所有既有验收（22 / 34 / 15 项）继续通过。

### Out-of-scope behavior

- 角色强度、帧优势、连段、KO 规则的变化。
- 服务端权威之外的客户端判定。
- 真实音频文件、版权音乐、外部 CDN。

### Allowed test seams

| Seam | Why public / stable | What it observes |
| :--- | :--- | :--- |
| `node scripts/verify-anim.mjs` | Existing public browser + geometry check; loads `/rig-lab.html` in real Chrome | rig JSON, part coverage, pose deltas, rendered pixels, JS exceptions |
| `node scripts/verify-art.mjs` | Existing public HTTP + Chrome check | manifest, active-only requests, gallery load, cache headers, canvas colors |
| `node scripts/verify-assets.mjs` (new) | Public HTTP + Chrome resource timing | byte budgets, cache headers, no `/assets/art` on new client, no mask requests |
| `node scripts/validate-assets.mjs` (new) | Static manifest/rig validator | manifest completeness, dimensions, alpha, hashes, budgets, orphans |
| `npm run verify` | Existing 22 end-to-end checks | MCP, rooms, replay, leaderboard, SDK, static serving |
| `npm run verify:combat` | Existing 34 kernel checks | deterministic combat unchanged |
| `npm run verify:mcp` | Existing 15 MCP SDK checks | external client path unchanged |
| `curl -sI` | HTTP public surface | `Cache-Control`, `ETag`, `Content-Length`, 304 |
| `scripts/capture.mjs` + `capture-rig.mjs` | Real Chrome screenshots | first impression, mobile layout, rig lab before/after |

No internal function-call-count assertions; no mocking of `fetch`/Canvas; no synthetic fake manifest.

### Completion criteria

The test design is accepted when all of the following are real, reproducible commands:

1. `npm run assets:check` exits 0 without writing.
2. `node scripts/validate-assets.mjs` exits 0.
3. `node scripts/verify-assets.mjs` proves:
   - `Live` resource entries contain exactly the two active `play`/rig assets + stage;
   - `Live` transfer bytes ≤ 1.5 MB with WebP;
   - gallery loads 16 cards only after the view is activated;
   - no `mask.png` request on the new client;
   - `/assets/v/**` is immutable, manifest is no-cache + ETag;
   - legacy `/assets/art/<id>.png` and `/assets/rig/<id>/rig.json` still 200.
4. `node scripts/verify-anim.mjs` exits 0 and rig lab `idleVsHp > 1500`, `idleVsWalk > 800` for all 16.
5. `node scripts/verify-art.mjs` exits 0 with updated expectations (2 live fighters, 16 gallery cards, 0 JS exceptions).
6. `npm run verify` 22/22, `npm run verify:combat` 34/34, `npm run verify:mcp` 15/15.
7. Desktop 1440×1250 + mobile 390×844 screenshots exist and show no overflow; default Live shows no debug boxes/bones/ruler/grid.
8. Sound toggle enables WebAudio; no autoplay error in console.

## 2. Acceptance behavior → observable assertion mapping

| # | Acceptance behavior | Observable assertion | Seam | Expected |
| :--- | :--- | :--- | :--- | :--- |
| A1 | Manifest is authoritative | `GET /assets/manifest.json` 200; schemaVersion=1; 16 fighters + stage; every `path` 200 and dimensions match | `validate-assets` + `curl` | all pass |
| A2 | Content-addressed cache | `GET /assets/v/...` has `Cache-Control: public, max-age=31536000, immutable`, `Content-Length`; `If-None-Match` → 304 | `verify-assets` + `curl` | headers exact |
| A3 | Live loads only active fighters | Resource Timing names include only the 2 match ids under `/assets/v/<id>/play`, 2 rigs, 1 stage | `verify-assets` (Chrome) | exactly 2 play, 2 rig, 1 stage |
| A4 | Live byte budget | Sum of `transferSize` for `/assets/**` on cold live | `verify-assets` | ≤ 1.5 MB with WebP |
| A5 | Gallery lazy loads | Before view activation, 0 card requests; after activation, 16 card images complete | `verify-art` + `verify-assets` | 0 → 16 |
| A6 | Rig atlas only | No `/mask.png` request on new client; rig JSON schema 2; part rects inside atlas | `verify-assets` + `validate-assets` | 0 masks, all rects valid |
| A7 | Poses read | rig lab pixel diff idle→hp > 1500; idle→walk > 800; no empty pose | `verify-anim` | all 16 |
| A8 | Worst ownership fixed | Before/after overlay screenshots for coral/tide/forge show no head/hair/hammer mis-claim | manual screenshot + `validate-assets` coverage | visual review + coverage 100% |
| A9 | Broadcast default | `showBoxes/showBones/showRuler/showGrid === false`; technical toggle sets all true | `verify-art` DOM probe | false / true |
| A10 | Sound optional | Click sound toggle creates AudioContext; `play('hit')` no throw; no autoplay error before click | `verify-art` browser eval + console | 0 errors |
| A11 | Fallback | Force missing rig atlas → whole sprite drawn; force missing plate → procedural body; no blank | `verify-art?assets=off` | non-empty canvas |
| A12 | Existing behavior | 22/34/15 checks | existing commands | unchanged |

## 3. Minimal vertical slice

**Slice:** “Live view fetches only the two active fighters and stays under 1.5 MB.”

Why it is enough to represent the objective:

- It crosses every layer that this refactor touches: `src/fighters.js` id mapping → build manifest → server URL/cache → browser asset store → canvas renderer.
- It can fail independently: if any layer still hardcodes `/assets/art/<id>.png` or the manifest is wrong, the Resource Timing assertion fails.
- It preserves the user-visible contract: the same two fighters must still render, with the same rig behavior; `verify-anim` catches blank/mis-rigged bodies.
- The gallery, cache headers, and rig atlas checks are separate assertions on the same seam; they do not need a second vertical slice.

## 4. Test data / setup

- Server: `PORT=8787 node src/server.js` (already running), demo room.
- Chrome: `CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Cold cache: CDP `Network.setCacheDisabled` or a fresh user-data-dir.
- Mobile: same server, CDP viewport 390×844.
- No external network; no image CDN.

## 5. Negative rules (no fake pass)

- Do not delete or skip existing assertions to make the new pipeline pass.
- Do not relax `idleVsHp` / `idleVsWalk` thresholds below the stated values.
- Do not replace real Chrome/HTTP with a mocked `fetch` or a synthetic manifest.
- Do not count `memory cache` hits as transfer savings; use `transferSize` with cache disabled for cold measurement, and a separate warm reload for cache validation.
- Do not treat a 200 from the legacy `/assets/art/<id>.png` as proof that the new client is not loading full-size art; assert on the new client's actual resource names.
- Do not claim a WebP budget when the manifest has no `alternate`; report PNG-only totals separately.
- Do not hide a failed rig behind the whole-plate fallback without recording it; the fallback is allowed, but the build validation must fail for a missing/invalid atlas.

## 6. Sediment / baseline

- Baseline receipt: `receipt:46c254f6-172a-4fbd-abf0-e224949bf5fa` from `node scripts/verify-anim.mjs` (exit 0, cwd `/Users/rex/codes/Agent-Fighter`).
- Existing matrix: `verify` 22, `verify:combat` 34, `verify:mcp` 15, `verify:art` 17-asset check (will be superseded), `verify:anim` all green.
- The refactor is **behavior-preserving hardening**: the user-observable game contract (fighters, moves, hitboxes, results) must not change; only delivery, rig expression, default overlays and optional audio change.

## 7. Testability decision

- Kind: `behavior-preserving-hardening`.
- Rationale: the work is a delivery/performance/visual-hardening refactor, not a new game behavior. The existing public scenario (`verify-anim`) passes at baseline, so the hardening path is appropriate. New asset checks are guards on the same public HTTP/Chrome surface.
- Baseline scenario:
  - publicEntry: `scripts/verify-anim.mjs`
  - setup: server at `http://127.0.0.1:8787`; `CHROME_PATH` set
  - command: `node scripts/verify-anim.mjs`
  - expected: `all animation checks passed`, exit 0
  - observed: `all animation checks passed`, exit 0
  - receiptRef: `receipt:46c254f6-172a-4fbd-abf0-e224949bf5fa`
- Decision ref: `artifact:testability-decision:afl-asset-library-refactor-2026-11-09`
