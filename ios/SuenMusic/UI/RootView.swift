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
        // 播放页是 hw 那种**全屏浮层**（盖住底栏、整体从底部上滑），不是 fullScreenCover 的卡片式模态
        // （后者自带圆角 + 顶部露背景，用户实测「你这个属于浮窗了吧」）。
        // ⚠️ 播放页必须是**铺满屏幕的浮层**：用 .overlay 挂在 Group 上时，
        // 里面的 NavigationStack 会按内容尺寸收缩（用户实测「页面还是小、上下巨大空白」）。
        // 所以放到最外层 ZStack 并显式给满屏 frame + ignoresSafeArea。
        .overlay {
            if showPlayer {
                PlayerView(onClose: { withAnimation(.easeOut(duration: Motion.standard)) { showPlayer = false } })
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .ignoresSafeArea()
                    .transition(.move(edge: .bottom))
                    .zIndex(10)
            }
        }
        .animation(.easeOut(duration: Motion.standard), value: showPlayer)
        .task {
            // 预热播放链路（引擎 + 流令牌），把起播延迟前移到启动阶段
            player.prewarm()
            #if DEBUG
            // 自动化验收：SUEN_PLAYER=1 启动后直接展开播放页（绕开 deep link 的系统确认弹框）。
            // 展开时机可用 SUEN_PLAYER_DELAY（秒，默认 3）推后 —— 自动播放要几十秒才起播，
            // 浮层验收时把延迟调大，播放页才能拿到真实曲目/歌词/候选内容。
            if DebugHooks.string("SUEN_PLAYER") == "1" {
                let delay = DebugHooks.int("SUEN_PLAYER_DELAY") ?? 3
                try? await Task.sleep(nanoseconds: UInt64(max(0, delay)) * 1_000_000_000)
                showPlayer = true
                // 验证收起链路（无触摸环境无法点收起键）：SUEN_PLAYER_AUTOCLOSE=秒 后自动走同一条 onClose
                if let after = DebugHooks.int("SUEN_PLAYER_AUTOCLOSE"), after > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(after) * 1_000_000_000)
                    withAnimation(.easeOut(duration: Motion.standard)) { showPlayer = false }
                }
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

    /// 自绘底栏（对齐 hw NativeRoot.ets：导轨 + 滑动药丸 + 五格），系统 TabView 只用来承载页面。
    ///
    /// 为什么保留 TabView 而不自己 switch：TabView 会**保持各页状态**（滚动位置、已加载数据），
    /// 自绘 switch 每次切 tab 都会重建页面 → 每次切回来都重新请求。所以：系统 TabView 负责
    /// 页面容器与状态，`barHeight(0)` 等价物是 `.toolbar(.hidden, for: .tabBar)`，视觉全部换自绘 TabBar。
    /// 页面容器：**不用 TabView**。
    ///
    /// 用 TabView 时系统 tabBar 即便 `.toolbar(.hidden, for: .tabBar)` 也留下一条空背景（用户实测「tab 栏空背景还留在页面上」）。
    /// 改成 ZStack 里常驻五个 NavigationStack：切页只改 opacity / hitTesting，
    /// 页面实例不销毁 → 滚动位置与已加载数据都保留（和 TabView 一样的收益），且没有任何系统栏。
    private var mainTabs: some View {
        VStack(spacing: 0) {
            ZStack {
                page(0) { HomeView() }
                page(1) { DailyView() }
                page(2) { FavoritesView() }
                page(3) { SearchView() }
                page(4) { SettingsView() }
            }
            if player.currentTrack != nil {
                PlayerBar { showPlayer = true }
            }
            TabBar(selection: $tab)
        }
    }

    /// 常驻页面：非当前页 `opacity 0` 且不接受点击（不销毁 = 保留状态）
    private func page<Content: View>(_ index: Int, @ViewBuilder content: () -> Content) -> some View {
        NavigationStack { content() }
            .opacity(tab == index ? 1 : 0)
            .allowsHitTesting(tab == index)
            .accessibilityHidden(tab != index)
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