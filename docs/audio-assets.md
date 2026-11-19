# 战斗音效

打击音效优先使用 `web/sfx/` 里的 **CC0 开源采样**（Kenney "Impact Sounds"），
失败时回退到 Web Audio 程序化合成。详见 `web/sfx/LICENSE.md`。

## 来源与版权

- 采样来自 [Kenney — Impact Sounds](https://kenney.nl/assets/impact-sounds)，
  **CC0 1.0（公有领域）**，可自由用于商业项目、无需署名。
- 这不是 SNK / KOF / 街霸 / 任何商业 ROM 的音效——遵守 README.md 的版权红线。
- 文件：`punch_{medium,heavy}_0..2`（拳击命中）、`block_0`（防御闷响）、
  `parry_0`（金属招架）。合计约 100 KB。

## 播放逻辑（`web/audio.js`）

- 首次点「声音开」时才 `fetch` + `decodeAudioData` 全部采样；之前不产生网络请求。
- 命中按伤害选 light/medium/heavy 变体（light 复用 medium 采样并提高 pitch），
  每段连击把 `playbackRate` 提高一个半音（`2^((combo-1)/12)`），形成街机式上扬连段。
- 每个 cue 用短促 gain 包络（~0.1–0.28s）把原始 foley 裁成干脆的打击声；
  命中下方叠一层 sub 低频增加重量感。
- 采样缺失/解码失败时自动回退到纯振荡器合成，音频不会整个静音。

## 验证

- 合成逻辑用 stubbed AudioContext 做节点图测试（半音 playbackRate、变体选择）。
- 实机（headless Chrome CDP）验证：开启声音后 buffer source 与 oscillator 持续增长，
  确认真实采样正在播放。
