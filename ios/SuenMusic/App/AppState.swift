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
        if let token = DebugHooks.string("SUEN_REFRESH_TOKEN"), !token.isEmpty,
           UserDefaults.standard.string(forKey: "suenmusic.refreshToken") != token {
            UserDefaults.standard.set(token, forKey: "suenmusic.refreshToken")
            if let base = env["SUEN_BASE_URL"], !base.isEmpty {
                UserDefaults.standard.set(base, forKey: "suenmusic.baseUrl")
            }
            api.reloadTokenFromDefaults()
            NSLog("[Boot] 已从环境变量注入刷新令牌")
        }
        // 无触摸环境（模拟器自动化验收）用账号直接登录：SUEN_USER + SUEN_PASS，配合 SUEN_BASE_URL。
        // 注意：不能只在 !api.isLoggedIn 时登 —— 旧 accessToken 还在内存里时 isLoggedIn 为真，
        // 但 /api/auth/me 会 401（令牌轮换过），结果是卡在登录页永远进不去。
        if user == nil,
           let u = DebugHooks.string("SUEN_USER"), !u.isEmpty,
           let p = DebugHooks.string("SUEN_PASS"), !p.isEmpty {
            NSLog("[Boot] 用注入账号登录 %@", u)
            await login(address: DebugHooks.string("SUEN_BASE_URL") ?? "", username: u, password: p)
            if isLoggedIn { await loadHome() }
            return
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
