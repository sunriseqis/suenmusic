/**
 * 主题三态（跟随系统 / 浅色 / 深色）+ 按当前深浅取色。
 *
 * **与鸿蒙端同构**（`common/Theme.ets`）：
 * - 存储键同为 `theme_mode`，值同为 `system` / `light` / `dark`
 * - 三段文案同为「跟随系统 / 浅色 / 深色」
 * - `Palette` 是 hw `Tokens.*` 的 iOS 等价物：hw 用资源自动切深浅，这里按 ColorScheme 取同值常量
 */

import SwiftUI

enum ThemeMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    /// 与 hw `THEME_LABELS` 同文案同顺序
    var label: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }
}

@MainActor
final class ThemeStore: ObservableObject {
    static let shared = ThemeStore()

    /// 与 hw `K_THEME_MODE` 同键
    static let storageKey = "theme_mode"

    @Published private(set) var mode: ThemeMode

    private init() {
        let raw = UserDefaults.standard.string(forKey: ThemeStore.storageKey) ?? ThemeMode.system.rawValue
        mode = ThemeMode(rawValue: raw) ?? .system
    }

    /// 给 `.preferredColorScheme` 用：nil = 跟随系统
    var preferredScheme: ColorScheme? {
        switch mode {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    func set(_ newMode: ThemeMode) {
        mode = newMode
        UserDefaults.standard.set(newMode.rawValue, forKey: ThemeStore.storageKey)
    }
}

/**
 * 按当前 ColorScheme 解析出的一套颜色（名字与 hw `Tokens` 一一对应）。
 *
 * 用法：`@Environment(\.colorScheme) private var scheme` + `private var p: Palette { Palette(scheme) }`
 */
struct Palette {
    let bg: Color
    let panel: Color
    let panel2: Color
    let line: Color
    let text1: Color
    let text2: Color
    let accent: Color
    let accentText: Color
    let onAccent: Color
    let danger: Color
    let track: Color
    let hi: Color
    let scrim: Color
    let badgeInk: Color
    let dateChip: Color
    let posterScrim: Color
    let posterScrimMid: Color

    /// 固定值调色板（**不随系统 trait 变化**）。
    ///
    /// `DesignTokens` 里的颜色是动态 `Color(light:dark:)`，按环境里的 colorScheme 解析；
    /// 这里直接用十六进制字面量构造颜色，由调用方显式传入 dark 决定取值 ——
    /// 同一个值在任何渲染上下文里都完全确定，不受环境 trait 波动影响。
    init(dark: Bool) {
        func c(_ light: UInt32, _ darkValue: UInt32, _ alpha: Double = 1) -> Color {
            let v = dark ? darkValue : light
            return Color(.sRGB,
                         red: Double((v >> 16) & 0xFF) / 255.0,
                         green: Double((v >> 8) & 0xFF) / 255.0,
                         blue: Double(v & 0xFF) / 255.0,
                         opacity: alpha)
        }
        bg = c(0xF2F0EA, 0x0E0F11)
        panel = c(0xFFFDF8, 0x17181B)
        panel2 = c(0xF7F3EA, 0x1D1F23)
        line = c(0xDCD6C9, 0x2A2C30)
        text1 = c(0x141414, 0xE9E7E2)
        text2 = c(0x6D6A63, 0x8A8D93)
        accent = c(0xB0650F, 0xE8A33D)
        accentText = c(0x8F4E08, 0xE8A33D)
        onAccent = c(0xFFFFFF, 0x1A1206)
        danger = c(0xA8322A, 0xD4564A)
        track = c(0xDCD6C9, 0x2A2C30)
        hi = c(0xFFFFFF, 0xFFFFFF, dark ? 0.06 : 0.95)
        scrim = c(0x141414, 0x000000, dark ? 0.66 : 0.42)
        badgeInk = c(0xFFFFFF, 0x1A1206)
        dateChip = c(0x000000, 0x000000, 0.5)
        posterScrim = c(0x000000, 0x000000, 0.78)
        posterScrimMid = c(0x000000, 0x000000, 0.42)
    }

    init(_ scheme: ColorScheme) {
        // token 已是动态色（自带 light/dark 两值），这里不再按 scheme 分叉：
        // 保留 `Palette(scheme)` 签名只为不动既有页面的调用点。
        bg = DesignTokens.bg
        panel = DesignTokens.panel
        panel2 = DesignTokens.panel2
        line = DesignTokens.line
        text1 = DesignTokens.text1
        text2 = DesignTokens.text2
        accent = DesignTokens.accent
        accentText = DesignTokens.accentText
        // hw：accent 底上的文字用 badgeInk（浅色白墨 / 深色深墨，随主题自动切）
        onAccent = DesignTokens.badgeInk
        danger = DesignTokens.danger
        track = DesignTokens.track
        hi = DesignTokens.hi
        scrim = DesignTokens.scrim
        badgeInk = DesignTokens.badgeInk
        dateChip = DesignTokens.dateChip
        posterScrim = DesignTokens.posterScrim
        posterScrimMid = DesignTokens.posterScrimMid
    }
}
