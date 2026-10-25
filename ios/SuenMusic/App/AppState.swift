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
    /// 正在展示离线快照时的时间戳（epoch ms，0 = 在线最新数据）—— 首页横幅用（hw offlineAt）
    @Published var offlineAt: Double = 0

    @Published var serverAddress: String = ServerRouter.shared.currentBaseURL
    private let api = APIClient.shared

    var isLoggedIn: Bool { user != nil }

    func bootstrap() async {
        #if DEBUG
        NSLog("[Boot] SUEN_TAB=%@ SUEN_SEARCH=%@ base=%@",
              DebugHooks.string("SUEN_TAB") ?? "nil",
              DebugHooks.string("SUEN_SEARCH") ?? "nil",
              ServerRouter.shared.currentBaseURL)
        #endif
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
        // 离线冷启动：先把快照摆上去（列表立刻可看），再照常联网刷新（hw HomePage.load 同序）
        if home == nil, let snapshot = readHomeSnapshot() {
            home = snapshot
            offlineAt = homeSnapshotAt
        }
        loadingHome = true
        defer { loadingHome = false }
        do {
            let fresh = try await api.home()
            home = fresh
            lastOkAt = Self.nowMs
            offlineAt = 0
            errorMessage = nil
            saveHomeSnapshot(fresh)
            #if DEBUG
            NSLog("[Home] 联网成功：快照已写入 at=%.0f", homeSnapshotAt)
            #endif
        } catch {
            errorMessage = Self.describe(error)
            // 手里已有数据但这次联网失败 → 挂离线横幅：时间戳优先快照写入时刻（与展示数据同源），
            // 无快照时退回本次会话最近一次成功时刻（hw HomePage.load 的兜底逻辑）
            if home != nil, (error as? ApiError)?.isNetwork == true {
                let snapshotAt = homeSnapshotAt
                offlineAt = snapshotAt > 0 ? snapshotAt : lastOkAt
                #if DEBUG
                NSLog("[Home] 联网失败（网络层）：切离线横幅 at=%.0f", offlineAt)
                #endif
            }
        }
    }

    // MARK: - 首页离线快照（hw AppState.readHomeSnapshot / saveHomeSnapshot 同语义）
    //
    // 只做「成功就落盘、失败就读回来」这一件事：不新起 Store，也不改首页渲染路径。

    private static let snapshotKey = "suenmusic.homeSnapshot"
    private static let snapshotAtKey = "suenmusic.homeSnapshotAt"

    /// 本次会话最近一次联网成功时刻（无快照时横幅时间戳的兜底，hw lastOkAt）
    private var lastOkAt: Double = 0

    /// 快照写入时刻（epoch ms，0 = 从未写入）
    var homeSnapshotAt: Double { UserDefaults.standard.double(forKey: Self.snapshotAtKey) }

    /// 读快照（无/损坏返回 nil）
    func readHomeSnapshot() -> HomeData? {
        guard let raw = UserDefaults.standard.data(forKey: Self.snapshotKey) else { return nil }
        return try? JSONDecoder().decode(HomeData.self, from: raw)
    }

    /// 成功拉到首页后落快照：JSON 原文 + 写入时刻
    func saveHomeSnapshot(_ data: HomeData) {
        guard let raw = try? JSONEncoder().encode(data) else { return }
        UserDefaults.standard.set(raw, forKey: Self.snapshotKey)
        UserDefaults.standard.set(Self.nowMs, forKey: Self.snapshotAtKey)
    }

    private static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    /// 错误 → 用户可读文案（一律经 Copy.describe，页面不自造错误话术）
    private static func describe(_ error: Error) -> String {
        guard let e = error as? ApiError else {
            return Copy.describe(status: -1, code: nil, message: error.localizedDescription)
        }
        return Copy.describe(status: e.status, code: e.code.isEmpty ? nil : e.code, message: e.message)
    }
}
