/**
 * iOS 原生客户端入口（SwiftUI，最低 iOS 26）。
 *
 * 这里**没有 Capacitor、没有 WebView** —— 全原生迭代的前提。
 */

import SwiftUI

@main
struct SuenMusicApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .environmentObject(PlaybackService.shared)
                .task { await app.bootstrap() }
        }
    }
}
