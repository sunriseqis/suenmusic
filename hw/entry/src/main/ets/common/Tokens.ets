/**
 * 设计令牌（**自动生成，不要手改**）。
 *
 * 来源：`web/src/styles/tokens.css` → `python3 scripts/gen-brand-tokens.py`。
 *
 * T12 起：颜色是**资源引用**（`$r('app.color.t_*')`），色值同时写进
 * `resources/base/element/color.json`（浅色）与 `resources/dark/element/color.json`（深色），
 * 系统切深浅色时自动跟随；页面只认 `Tokens.xxx`，不需要知道当前主题。
 */

export class Tokens {
  // 深浅两套由系统资源目录决定（base = 浅色纸白 / dark = 深色哑光石墨）
  static readonly bg: ResourceColor = $r('app.color.t_bg'); // dark #0E0F11 / light #F2F0EA
  static readonly panel: ResourceColor = $r('app.color.t_panel'); // dark #17181B / light #FFFDF8
  static readonly panel2: ResourceColor = $r('app.color.t_panel2'); // dark #1D1F23 / light #F7F3EA
  static readonly line: ResourceColor = $r('app.color.t_line'); // dark #2A2C30 / light #DCD6C9
  static readonly text1: ResourceColor = $r('app.color.t_text1'); // dark #E9E7E2 / light #141414
  static readonly text2: ResourceColor = $r('app.color.t_text2'); // dark #8A8D93 / light #6D6A63
  static readonly accent: ResourceColor = $r('app.color.t_accent'); // dark #E8A33D / light #B0650F
  static readonly accentText: ResourceColor = $r('app.color.t_accent_text'); // dark #E8A33D / light #8F4E08
  static readonly scrim: ResourceColor = $r('app.color.t_scrim'); // dark #A8000000 / light #6B141414
  static readonly track: ResourceColor = $r('app.color.t_track'); // dark #2A2C30 / light #DCD6C9
  static readonly hi: ResourceColor = $r('app.color.t_hi'); // dark #0FFFFFFF / light #F2FFFFFF
  static readonly posterScrim: ResourceColor = $r('app.color.t_poster_scrim'); // dark #C7000000 / light #C7000000
  static readonly posterScrimMid: ResourceColor = $r('app.color.t_poster_scrim_mid'); // dark #6B000000 / light #6B000000
  static readonly dateChip: ResourceColor = $r('app.color.t_date_chip'); // dark #80000000 / light #80000000
  static readonly badgeInk: ResourceColor = $r('app.color.t_badge_ink'); // dark #1A1206 / light #FFFFFF
  static readonly danger: ResourceColor = $r('app.color.t_danger'); // dark #D4564A / light #A8322A
}
