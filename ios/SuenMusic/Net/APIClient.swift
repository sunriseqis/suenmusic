/**
 * HTTP 客户端（原生）。
 *
 * 与 Vue 端 `web/src/api/client.ts` + `servers.ts` 的语义**必须一致**：
 *   · 访问令牌只放内存；刷新令牌落 Keychain（S0 先用 UserDefaults，S1 换 Keychain）
 *   · 401 → 单飞刷新 → 重放一次（并发 401 共用同一次刷新，否则令牌轮换会互相踩）
 *   · 网络层失败 → 触发多服务端选路（内网优先、并行探测、单飞 + 冷却）
 *   · 私有 IP 用 4 秒快速失败：出门后内网是黑洞路由，傻等 20 秒是灾难
 */

import Foundation

// MARK: - 错误

struct ApiError: LocalizedError {
    let status: Int
    let code: String
    let message: String

    var isUnauthorized: Bool { status == 401 }
    var isNetwork: Bool { status == 0 }
    var errorDescription: String? { message }
}

// MARK: - 服务端列表与选路

struct ServerCandidate: Codable, Identifiable, Hashable {
    var id: String { url }
    var url: String
    var name: String
}

/// 多服务端选路（算法照抄 `web/src/api/servers.ts`，包括那些注释里的坑）
final class ServerRouter {
    static let shared = ServerRouter()

    private let listKey = "suenmusic.servers"
    private let currentKey = "suenmusic.baseUrl"
    private var selecting: Task<String?, Never>?
    private var lastFailoverAt: Date = .distantPast
    private let cooldown: TimeInterval = 5

    private(set) var candidates: [ServerCandidate] = []

    private init() {
        if let data = UserDefaults.standard.data(forKey: listKey),
           let list = try? JSONDecoder().decode([ServerCandidate].self, from: data) {
            candidates = list
        }
    }

    var currentBaseURL: String {
        get { UserDefaults.standard.string(forKey: currentKey) ?? candidates.first?.url ?? "" }
        set {
            UserDefaults.standard.set(normalize(newValue), forKey: currentKey)
        }
    }

    func save(candidates list: [ServerCandidate]) {
        candidates = list
        if let data = try? JSONEncoder().encode(list) {
            UserDefaults.standard.set(data, forKey: listKey)
        }
    }

    private func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    static func isPrivate(_ url: String) -> Bool {
        guard let host = URL(string: url)?.host?.lowercased() else { return false }
        if host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".local") { return true }
        if host.hasPrefix("192.168.") || host.hasPrefix("10.") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4, parts[0] == 172, (16...31).contains(parts[1]) { return true }
        return false
    }

    /// 探测 `/api/health`（免鉴权）。**必须校验返回体**：门户劫持也会回 200。
    func probe(_ base: String, timeout: TimeInterval) async -> Bool {
        guard let url = URL(string: base + "/api/health") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return false }
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return obj?["ok"] as? Bool == true
        } catch {
            return false
        }
    }

    /// 启动 / 网络环境变化时选路：第一个候选短超时独占探测，其余并行。
    func selectBest() async -> String? {
        if let running = selecting { return await running.value }
        let task = Task<String?, Never> { [candidates] in
            guard let first = candidates.first else { return nil }
            if await self.probe(first.url, timeout: 2) { return first.url }
            if candidates.count == 1 { return nil }
            return await withTaskGroup(of: (String, Bool).self) { group in
                for c in candidates.dropFirst() {
                    group.addTask { (c.url, await self.probe(c.url, timeout: 2)) }
                }
                for await (url, ok) in group where ok { return url }
                return nil
            }
        }
        selecting = task
        let picked = await task.value
        selecting = nil
        if let picked { currentBaseURL = picked }
        return picked
    }

    /// 请求遇到网络层失败时调用。返回 true = 已切换到可用路径，调用方应重放一次。
    func failoverIfNeeded() async -> Bool {
        guard candidates.count > 1 else { return false }
        if let running = selecting { return await running.value != nil }
        if Date().timeIntervalSince(lastFailoverAt) < cooldown { return false }
        lastFailoverAt = Date()

        let current = currentBaseURL
        // 当前是公网路径时才花 1 秒复核抖动；当前是内网且已失败 = 已离开内网，直接探其余
        if !Self.isPrivate(current), await probe(current, timeout: 1) { return false }

        let others = candidates.filter { $0.url != current }
        let picked: String? = await withTaskGroup(of: (String, Bool).self) { group in
            for c in others { group.addTask { (c.url, await self.probe(c.url, timeout: 2)) } }
            for await (url, ok) in group where ok { return url }
            return nil
        }
        if let picked { currentBaseURL = picked; return true }
        return false
    }
}

// MARK: - 客户端

final class APIClient {
    static let shared = APIClient()

    private let router = ServerRouter.shared
    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    /// 访问令牌**只在内存**
    private var accessToken: String?
    private var refreshToken: String?
    private var refreshTask: Task<Void, Error>?

    private let tokenKey = "suenmusic.refreshToken"

    init() {
        refreshToken = UserDefaults.standard.string(forKey: tokenKey)
    }

    var isLoggedIn: Bool { accessToken != nil || refreshToken != nil }

    private var base: String { router.currentBaseURL }

    // MARK: 会话

    func adopt(_ s: AuthSession) {
        accessToken = s.accessToken
        refreshToken = s.refreshToken
        UserDefaults.standard.set(s.refreshToken, forKey: tokenKey)
    }

    func signOut() {
        accessToken = nil
        refreshToken = nil
        UserDefaults.standard.removeObject(forKey: tokenKey)
    }

    /// 单飞刷新：并发 401 共用同一次刷新（旧令牌被轮换后，第二个请求必然失败）
    private func refreshIfPossible() async throws {
        guard let token = refreshToken else {
            throw ApiError(status: 401, code: "unauthorized", message: "登录已失效，请重新登录")
        }
        if let running = refreshTask {
            try await running.value
            return
        }
        let task = Task<Void, Error> { [weak self] in
            guard let self else { return }
            struct Body: Encodable { let refreshToken: String }
            struct Reply: Decodable { let accessToken: String; let refreshToken: String }
            let payload = try JSONEncoder().encode(Body(refreshToken: token))
            let reply: Reply = try await self.send(
                "/api/auth/refresh", method: "POST", body: payload, authed: false, noRetry: true
            )
            self.accessToken = reply.accessToken
            self.refreshToken = reply.refreshToken
            UserDefaults.standard.set(reply.refreshToken, forKey: self.tokenKey)
        }
        refreshTask = task
        defer { refreshTask = nil }
        try await task.value
    }

    // MARK: 请求

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await send(path, method: "GET", query: query)
    }

    /// 搜索（对齐 hw `APIClient.search`）：type 取 all/song/album/artist/playlist/mv
    func search(keyword: String, type: String = "all", page: Int = 1, limit: Int = 30) async throws -> SearchReply {
        try await get("/api/search", query: [
            "q": keyword,
            "type": type,
            "page": String(page),
            "limit": String(limit),
        ])
    }

    func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        let data = try JSONEncoder().encode(body)
        return try await send(path, method: "POST", body: data)
    }

    /// 唯一的发送实现。
    ///
    /// body 刻意用 `Data?` 而不是泛型：**递归重放**（切服重试 / 401 重放）时，
    /// 泛型 + `some Encodable` 的组合在 Swift 里会引入新的不透明类型参数，
    /// 编译期报「无法把不透明类型传回自己」；提前编码成 Data 就没有这个问题。
    private func send<T: Decodable>(
        _ path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: Data? = nil,
        authed: Bool = true,
        noRetry: Bool = false,
        retried: Bool = false
    ) async throws -> T {
        var comp = URLComponents(string: base + path)
        if !query.isEmpty {
            comp?.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comp?.url else {
            throw ApiError(status: 0, code: "bad_url", message: "服务端地址无效")
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        // 私有 IP 4 秒快速失败；公网给 20 秒（反代/隧道首包可能慢）
        req.timeoutInterval = ServerRouter.isPrivate(base) ? 4 : 20
        if authed, let token = accessToken {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            // 网络层失败 → 选路后重放一次
            if !retried, await router.failoverIfNeeded() {
                return try await send(path, method: method, query: query, body: body,
                                      authed: authed, noRetry: noRetry, retried: true)
            }
            throw ApiError(status: 0, code: "network", message: "连不上服务端，请检查网络或服务器地址")
        }

        guard let http = resp as? HTTPURLResponse else {
            throw ApiError(status: 0, code: "bad_response", message: "服务端返回异常")
        }

        if http.statusCode == 401, authed, !noRetry {
            try await refreshIfPossible()
            return try await send(path, method: method, query: query, body: body,
                                  authed: authed, noRetry: true, retried: retried)
        }

        guard (200..<300).contains(http.statusCode) else {
            if let parsed = try? JSONDecoder().decode(ApiErrorBody.self, from: data) {
                throw ApiError(status: http.statusCode, code: parsed.error.code, message: parsed.error.message)
            }
            throw ApiError(status: http.statusCode, code: "http_\(http.statusCode)",
                           message: "服务端返回 HTTP \(http.statusCode)")
        }

        if data.isEmpty, T.self == EmptyReply.self {
            return EmptyReply() as! T
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ApiError(status: http.statusCode, code: "decode",
                           message: "响应解析失败：\(error.localizedDescription)")
        }
    }

    struct EmptyReply: Decodable {}

    /// 当前服务端根地址（不带尾斜杠），给播放内核拼流地址用
    var baseURL: String { base }

    // MARK: 业务便捷方法（S0 只用到这几条）

    func authConfig() async throws -> AuthConfig {
        try await send("/api/auth/config", authed: false)
    }

    func login(username: String, password: String) async throws -> AuthSession {
        struct Body: Encodable { let username: String; let password: String }
        let payload = try JSONEncoder().encode(Body(username: username, password: password))
        return try await send("/api/auth/login", method: "POST", body: payload, authed: false)
    }

    func me() async throws -> PublicUser {
        struct Reply: Decodable { let user: PublicUser }
        let r: Reply = try await get("/api/auth/me")
        return r.user
    }

    func home() async throws -> HomeData {
        try await get("/api/home")
    }

    func resolve(trackId: String) async throws -> ResolveResponse {
        try await get("/api/resolve/\(trackId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trackId)")
    }

    /// 每日推荐（只读；服务端每日 00:30 产出）
    func dailyRecommend() async throws -> DailyRecommend {
        try await get("/api/recommend/daily")
    }

    /// 取消收藏（幂等）。响应体不参与 UI，用空结构吞掉，避免为此新增一个模型。
    func removeFavorite(trackId: String) async throws {
        let _: EmptyReply = try await send("/api/favorites/\(trackId)", method: "DELETE")
    }

    /// 只用于吞掉"没有字段需要读"的响应
    struct EmptyReply: Decodable {}

    func favorites(limit: Int = 50, cursor: String? = nil) async throws -> FavoritePage {
        var q = ["limit": String(limit)]
        if let cursor { q["cursor"] = cursor }
        return try await get("/api/favorites", query: q)
    }

    /// 把服务端给的**相对** streamUrl 拼成绝对地址（原生播放器需要绝对 URL）
    func absolute(_ relative: String) -> String {
        if relative.hasPrefix("http") { return relative }
        return base + (relative.hasPrefix("/") ? relative : "/" + relative)
    }
}
