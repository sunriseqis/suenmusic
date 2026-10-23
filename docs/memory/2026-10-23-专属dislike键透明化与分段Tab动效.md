# 2026-10-23 专属页 dislike 键透明化 + 分段 Tab 过渡动效

**状态：已交付并装机验证（dump 数值；动效靠体感）**

## ① 专属播放页「不喜欢」按钮改透明背景

- `PlayerPage.recoCard()` 的 dislike 触发键：去掉 `Tokens.panel` 底衬 + `Tokens.line` 描边，
  改 `.backgroundColor(Color.Transparent)`，尺寸仍 44 触控区、字形仍 12vp（审计第 2 条口径）。
- 效果：与播放页收起键、锚定页搜索/大头针键统一成「灰白透明图标键」一种形态。
- 装机实测：专属页起播（我们俩）→ 播放页出现「专属推荐理由」卡 → 卡内 dislike 键节点
  `[997,1492][1151,1646]`（=44vp）`bg=#00000000`、单子节点 → ✅ 透明。

## ② 搜索页四个分片切换补动效

- 根因：`common/NeuTabs.ets` 只按 `activeIndex` 硬切底色/字色，没有任何过渡；
  web `NeuTabs.vue` 里有 `transition: color/background-color var(--dur-fast)`（**120ms**）。
- 改法：每个格子加 `.animation({ duration: Motion.fast, curve: Motion.curve })`（100ms，项目 `Motion.fast`
  与 web 120ms 同量级，走令牌不写裸值）；同时把上沿高光改成**固定 1vp 厚、只换颜色**
  （原来 0↔1vp 宽度跳变会在切换时闪一下）。
- 影响面：`NeuTabs` 的两处使用者都受益 —— 搜索页四分片、设置页三分段。

## 门禁

- `check-arkts` ERROR 0 / WARN 4（41 个 .ets，基线不变）
- `devecocli build` BUILD SUCCESSFUL，ArkTS WARN 5（既有 syscap）
- 产物 `output/SuenMusic-v1.6.0-unsigned.hap` md5 `30e4a9e62fe49edc9ca1bdecaf85647b`，已装模拟器并 force-stop 重启验证