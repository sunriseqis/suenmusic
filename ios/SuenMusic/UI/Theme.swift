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
