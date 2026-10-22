/**
 * 设计令牌（**自动生成，不要手改**）。
 *
 * 来源：`web/src/styles/tokens.css` → `python3 scripts/gen-brand-tokens.py`。
 * 原生端手抄颜色必然漂移：S2 第一版就把页面底写成了 panel 色、次级文字用了
 * 浅色主题的 t2。改配色只改 CSS，然后重跑脚本。
 */

export class Tokens {
  // ---- 深色（哑光石墨）—— 客户端默认主题 ----
  static readonly bg: string = '#0E0F11'; // #0e0f11
  static readonly panel: string = '#17181B'; // #17181b
  static readonly panel2: string = '#1D1F23'; // #1d1f23
  static readonly line: string = '#2A2C30'; // #2a2c30
  static readonly text1: string = '#E9E7E2'; // #e9e7e2
  static readonly text2: string = '#8A8D93'; // #8a8d93
  static readonly accent: string = '#E8A33D'; // #e8a33d
  static readonly accentText: string = '#E8A33D'; // #e8a33d
  static readonly scrim: string = '#A8000000'; // rgba(0, 0, 0, 0.66)
  static readonly track: string = '#2A2C30'; // #2a2c30
  static readonly hi: string = '#0FFFFFFF'; // rgba(255, 255, 255, 0.06)
  static readonly posterScrim: string = '#C7000000'; // rgba(0, 0, 0, 0.78)
  static readonly posterScrimMid: string = '#6B000000'; // rgba(0, 0, 0, 0.42)
  static readonly dateChip: string = '#80000000'; // rgba(0, 0, 0, 0.5)
  static readonly badgeInk: string = '#1A1206'; // #1a1206

  // ---- 浅色（纸白）—— 备用 ----
  static readonly bgLight: string = '#F2F0EA'; // #f2f0ea
  static readonly panelLight: string = '#FFFDF8'; // #fffdf8
  static readonly panel2Light: string = '#F7F3EA'; // #f7f3ea
  static readonly lineLight: string = '#DCD6C9'; // #dcd6c9
  static readonly text1Light: string = '#141414'; // #141414
  static readonly text2Light: string = '#6D6A63'; // #6d6a63
  static readonly accentLight: string = '#B0650F'; // #b0650f
  static readonly accentTextLight: string = '#8F4E08'; // #8f4e08
  static readonly scrimLight: string = '#6B141414'; // rgba(20, 20, 20, 0.42)
  static readonly trackLight: string = '#DCD6C9'; // #dcd6c9
  static readonly hiLight: string = '#F2FFFFFF'; // rgba(255, 255, 255, 0.95)
  static readonly posterScrimLight: string = '#C7000000'; // rgba(0, 0, 0, 0.78)
  static readonly posterScrimMidLight: string = '#6B000000'; // rgba(0, 0, 0, 0.42)
  static readonly dateChipLight: string = '#80000000'; // rgba(0, 0, 0, 0.5)
  static readonly badgeInkLight: string = '#FFFFFF'; // #ffffff
}
