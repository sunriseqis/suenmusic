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
                NavigationStack { SettingsView() }
                    .tabItem { Label("我的", systemImage: "person") }
            }
            if player.currentTrack != nil {
                PlayerBar { showPlayer = true }
            }
        }
    }
}
