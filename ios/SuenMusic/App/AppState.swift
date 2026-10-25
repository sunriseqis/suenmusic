/**
 * 应用级状态：登录态 + 首页数据 + 多服务端。
 *
 * 刻意做得薄：只放"跨页面共享且与播放无关"的东西。播放状态全在 `PlaybackService`。
 */

import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var user: PublicUser?
    @Published var home: HomeData?
    @Published var loadingHome = false
    @Published var errorMessage: String?

    @Published var serverAddress: String = ServerRouter.shared.currentBaseURL
    private let api = APIClient.shared

    var isLoggedIn: Bool { user != nil }

    func bootstrap() async {
        #if DEBUG
        // 真机自动化验证用：SIMCTL_CHILD_* / devicectl --environment-variables 注入令牌，跳过手输登录
        let env = ProcessInfo.processInfo.environment
        if let token = env["SUEN_REFRESH_TOKEN"], !token.isEmpty,
           UserDefaults.standard.string(forKey: "suenmusic.refreshToken") != token {
            UserDefaults.standard.set(token, forKey: "suenmusic.refreshToken")
            if let base = env["SUEN_BASE_URL"], !base.isEmpty {
                UserDefaults.standard.set(base, forKey: "suenmusic.baseUrl")
            }
            api.reloadTokenFromDefaults()
            NSLog("[Boot] 已从环境变量注入刷新令牌")
        }
        #endif
        guard api.isLoggedIn else { return }
        // 有刷新令牌就先探一次：服务端可达 + 令牌有效就恢复登录，否则回登录页
        do {
            user = try await api.me()
            await loadHome()
        } catch {
            user = nil
        }
    }

    func login(address: String, username: String, password: String) async {
        errorMessage = nil
        var addr = address.trimmingCharacters(in: .whitespacesAndNewlines)
        while addr.hasSuffix("/") { addr.removeLast() }
        if !addr.isEmpty {
            ServerRouter.shared.currentBaseURL = addr
            ServerRouter.shared.save(candidates: [ServerCandidate(url: addr, name: "默认")])
            serverAddress = addr
        }
        do {
            let session = try await api.login(username: username, password: password)
            api.adopt(session)
            user = session.user
            await loadHome()
        } catch {
            errorMessage = (error as? ApiError)?.message ?? error.localizedDescription
        }
    }

    func signOut() {
        api.signOut()
        user = nil
        home = nil
    }

    func loadHome() async {
        loadingHome = true
        defer { loadingHome = false }
        do {
            home = try await api.home()
        } catch {
            errorMessage = (error as? ApiError)?.message ?? error.localizedDescription
        }
    }
}
