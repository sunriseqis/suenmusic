/**
 * 设计令牌（**自动生成，不要手改**）。
 *
 * 来源：`web/src/styles/tokens.css` → `python3 scripts/gen-brand-tokens.py`。
 */

import SwiftUI

enum DesignTokens {
    // ---- 深色（哑光石墨）—— 客户端默认主题 ----
    static let bg = Color(red: 0.055, green: 0.059, blue: 0.067) // #0e0f11
    static let panel = Color(red: 0.090, green: 0.094, blue: 0.106) // #17181b
    static let panel2 = Color(red: 0.114, green: 0.122, blue: 0.137) // #1d1f23
    static let line = Color(red: 0.165, green: 0.173, blue: 0.188) // #2a2c30
    static let text1 = Color(red: 0.914, green: 0.906, blue: 0.886) // #e9e7e2
    static let text2 = Color(red: 0.541, green: 0.553, blue: 0.576) // #8a8d93
    static let accent = Color(red: 0.910, green: 0.639, blue: 0.239) // #e8a33d
    static let accentText = Color(red: 0.910, green: 0.639, blue: 0.239) // #e8a33d
    static let scrim = Color(red: 0.000, green: 0.000, blue: 0.000, opacity: 0.659) // rgba(0, 0, 0, 0.66)
    static let track = Color(red: 0.165, green: 0.173, blue: 0.188) // #2a2c30

    // ---- 浅色（纸白）—— 备用 ----
    static let bgLight = Color(red: 0.949, green: 0.941, blue: 0.918) // #f2f0ea
    static let panelLight = Color(red: 1.000, green: 0.992, blue: 0.973) // #fffdf8
    static let panel2Light = Color(red: 0.969, green: 0.953, blue: 0.918) // #f7f3ea
    static let lineLight = Color(red: 0.863, green: 0.839, blue: 0.788) // #dcd6c9
    static let text1Light = Color(red: 0.078, green: 0.078, blue: 0.078) // #141414
    static let text2Light = Color(red: 0.427, green: 0.416, blue: 0.388) // #6d6a63
    static let accentLight = Color(red: 0.690, green: 0.396, blue: 0.059) // #b0650f
    static let accentTextLight = Color(red: 0.561, green: 0.306, blue: 0.031) // #8f4e08
    static let scrimLight = Color(red: 0.078, green: 0.078, blue: 0.078, opacity: 0.420) // rgba(20, 20, 20, 0.42)
    static let trackLight = Color(red: 0.863, green: 0.839, blue: 0.788) // #dcd6c9
}
