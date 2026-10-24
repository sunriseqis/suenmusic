import SwiftUI

struct RootView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var player: PlaybackService
    @State private var showPlayer = false

    var body: some View {
        Group {
            if app.isLoggedIn {
                mainTabs
            } else {
                LoginView()
            }
        }
        .sheet(isPresented: $showPlayer) {
            PlayerView()
        }
    }

    private var mainTabs: some View {
        VStack(spacing: 0) {
            TabView {
                NavigationStack { HomeView() }
                    .tabItem { Label("首页", systemImage: "house") }
                // 专属/收藏两个 tab 待批⑥（集合页与每日推荐还没建）
                NavigationStack { SearchView() }
                    .tabItem { Label("搜索", systemImage: "magnifyingglass") }
                NavigationStack { SettingsView() }
                    .tabItem { Label("我的", systemImage: "person") }
            }
            if player.currentTrack != nil {
                PlayerBar { showPlayer = true }
            }
        }
    }
}
