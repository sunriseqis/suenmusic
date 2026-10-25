/**
 * 设计令牌 —— 与鸿蒙端 `common/Tokens.ets` 逐值同源，且与 hw 一样**随系统深浅自动切换**。
 *
 * hw 用资源目录（base / dark 两份 color.json）让系统自动切色；iOS 这里用动态 UIColor
 * 等价实现：页面只写 `DesignTokens.xxx` 一个名字，取色时机交给 trait（不需要知道当前主题）。
 *
 * 十六进制格式：#RRGGBB，或 8 位 #AARRGGBB（含 0..1 alpha，见 `Color(light:dark:)`）。
 */

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// #AARRGGBB / #RRGGBB → sRGB 分量（8 位时首字节为 alpha）
private func tokenRGBA(_ hex: UInt32) -> (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) {
    let hasAlpha = hex > 0xFFFFFF
    let a = hasAlpha ? CGFloat((hex >> 24) & 0xFF) / 255 : 1
    let r = CGFloat((hex >> 16) & 0xFF) / 255
    let g = CGFloat((hex >> 8) & 0xFF) / 255
    let b = CGFloat(hex & 0xFF) / 255
    return (r, g, b, a)
}

extension Color {
    /// 浅 / 深两值合成一个动态色（十六进制 + 0..1 alpha）。
    init(light: UInt32, dark: UInt32) {
        let l = tokenRGBA(light)
        let d = tokenRGBA(dark)
        #if canImport(UIKit)
        // 动态 provider：SwiftUI 渲染时按当前 trait 解析，深浅各自取到真实值
        self.init(uiColor: UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? d : l
            return UIColor(red: c.r, green: c.g, blue: c.b, alpha: c.a)
        })
        #else
        self.init(.sRGB, red: l.r, green: l.g, blue: l.b, opacity: l.a)
        #endif
    }
}

enum DesignTokens {
    static let bg = Color(light: 0xF2F0EA, dark: 0x0E0F11)
    static let panel = Color(light: 0xFFFDF8, dark: 0x17181B)
    static let panel2 = Color(light: 0xF7F3EA, dark: 0x1D1F23)
    static let line = Color(light: 0xDCD6C9, dark: 0x2A2C30)
    static let text1 = Color(light: 0x141414, dark: 0xE9E7E2)
    static let text2 = Color(light: 0x6D6A63, dark: 0x8A8D93)
    static let accent = Color(light: 0xB0650F, dark: 0xE8A33D)
    static let accentText = Color(light: 0x8F4E08, dark: 0xE8A33D)
    static let scrim = Color(light: 0x6B141414, dark: 0xA8000000)
    static let track = Color(light: 0xDCD6C9, dark: 0x2A2C30)
    /// 顶沿内高光（浅色 95% 白 / 深色 6% 白）
    static let hi = Color(light: 0xF2FFFFFF, dark: 0x0FFFFFFF)
    static let posterScrim = Color(light: 0xC7000000, dark: 0xC7000000)
    static let posterScrimMid = Color(light: 0x6B000000, dark: 0x6B000000)
    static let dateChip = Color(light: 0x80000000, dark: 0x80000000)
    /// accent 底上的字/图标：浅色琥珀底深 → 白墨；深色琥珀底亮 → 深墨
    static let badgeInk = Color(light: 0xFFFFFF, dark: 0x1A1206)
    static let danger = Color(light: 0xA8322A, dark: 0xD4564A)

    // ---- 右滑动作区（hw TrackItem 里是裸 hex，深浅同值，这里补成 token） ----
    /// 未收藏：动作区白字 / 白图标
    static let swipeInk = Color(light: 0xFFFFFF, dark: 0xFFFFFF)
    /// 已收藏：动作区底 #8A1F18
    static let swipeFavBg = Color(light: 0x8A1F18, dark: 0x8A1F18)
    /// 已收藏：动作区字 / 图标 #FFDAD6
    static let swipeFavInk = Color(light: 0xFFDAD6, dark: 0xFFDAD6)
}
