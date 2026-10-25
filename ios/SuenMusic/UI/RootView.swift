import SwiftUI

struct RootView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var player: PlaybackService
    @State private var showPlayer = false
    /// 当前 tab（0 首页 / 1 专属 / 2 收藏 / 3 搜索 / 4 我的）
    @State private var tab: Int = RootView.initialTab()

    var body: some View {
        Group {
            if app.isLoggedIn {
                mainTabs
            } else {
                LoginView()
            }
        }
        // 播放页必须全屏呈现：sheet 自带顶部留白 + 圆角，会按「sheet 高度」裁掉页面的一部分，
        // 而 PlayerView 是照 hw 全屏浮层设计的（沉浸底 + 封面 280 + 四个内部浮层）。
        // hw 的入场是 translate(y:100%)→0 的 200ms EaseOut —— fullScreenCover 自带的底部滑入
        // 正是同一动作，尺寸不再由系统 detent 决定。
        .fullScreenCover(isPresented: $showPlayer) {
            PlayerView()
        }
        .task {
            // 预热播放链路（引擎 + 流令牌），把起播延迟前移到启动阶段
            player.prewarm()
            #if DEBUG
            // 自动化验收：SUEN_PLAYER=1 启动后直接展开播放页（绕开 deep link 的系统确认弹框）
            if DebugHooks.string("SUEN_PLAYER") == "1" {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                showPlayer = true
            }
            #endif
        }
        // 灵动岛 / 锁屏卡点击 → suenmusic://player：直接落到播放页（对应 widget 的 .widgetURL）
        .onOpenURL { url in
            guard url.scheme == "suenmusic" else { return }
            if url.host == "player" {
                showPlayer = true
            } else if let host = url.host, let index = Int(host) {
                tab = index
            }
        }
        // 全端提示的唯一渲染落点（ToastCenter.shared.show 只写状态，这里画）
        .overlay { ToastOverlay() }
    }

    private var mainTabs: some View {
        VStack(spacing: 0) {
            TabView(selection: $tab) {
                NavigationStack { HomeView() }
                    .tabItem { Label("首页", systemImage: "house") }
                    .tag(0)
                NavigationStack { DailyView() }
                    .tabItem { Label("专属", systemImage: "sparkles") }
                    .tag(1)
                NavigationStack { FavoritesView() }
                    .tabItem { Label("收藏", systemImage: "heart") }
                    .tag(2)
                NavigationStack { SearchView() }
                    .tabItem { Label("搜索", systemImage: "magnifyingglass") }
                    .tag(3)
                NavigationStack { SettingsView() }
                    .tabItem { Label("我的", systemImage: "person") }
                    .tag(4)
            }
            if player.currentTrack != nil {
                PlayerBar { showPlayer = true }
            }
        }
    }

    /// **DEBUG only**：用环境变量指定起始 tab，便于无触摸环境（OCR 验证）逐页跑界面。
    /// 用法：SIMCTL_CHILD_SUEN_TAB=settings xcrun simctl launch booted com.suenmusic.app
    private static func initialTab() -> Int {
        #if DEBUG
        switch DebugHooks.string("SUEN_TAB") ?? "" {
        case "daily": return 1
        case "favorites": return 2
        case "search": return 3
        case "settings": return 4
        default: return 0
        }
        #else
        return 0
        #endif
    }
}