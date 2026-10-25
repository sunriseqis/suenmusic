/**
 * iOS 原生客户端入口（SwiftUI，最低 iOS 26）。
 *
 * 这里**没有 Capacitor、没有 WebView** —— 全原生迭代的前提。
 */

import SwiftUI

@main
struct SuenMusicApp: App {
    @StateObject private var app = AppState()
    /// 主题三态（跟随系统 / 浅色 / 深色），与 hw 的 theme_mode 同键
    @StateObject private var theme = ThemeStore.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .environmentObject(PlaybackService.shared)
                .environmentObject(theme)
                .preferredColorScheme(theme.preferredScheme)
                .task {
                    Notifier.bootstrap()          // 前台展示代理 + 通知授权
                    await app.bootstrap()

                }
        }
    }
}
