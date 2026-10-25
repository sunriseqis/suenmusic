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

    /// 重新从 UserDefaults 读取刷新令牌（DEBUG 环境变量注入后调用）
    /// 歌词（LRC 原文 + 译文）。失败返回 nil —— 没有歌词不影响播放。
    func lyrics(trackId: String) async -> LyricReply? {
        try? await send("/api/lyrics/\(trackId)")
    }

    func reloadTokenFromDefaults() {
        refreshToken = UserDefaults.standard.string(forKey: tokenKey)
    }

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

    // MARK: 集合页

    func albumDetail(id: String, limit: Int = 100) async throws -> AlbumDetailReply {
        try await get("/api/albums/\(id)", query: ["limit": String(limit)])
    }

    func toplistDetail(id: String, limit: Int = 100) async throws -> ToplistDetailReply {
        try await get("/api/toplist/\(id)", query: ["limit": String(limit)])
    }

    func artistSongs(id: String, name: String = "", limit: Int = 50, page: Int = 1) async throws -> ArtistSongsReply {
        var q = ["limit": String(limit), "page": String(page)]
        if !name.isEmpty { q["name"] = name }
        return try await get("/api/artists/\(id)/songs", query: q)
    }

    func qqPlaylistDetail(id: String) async throws -> QqPlaylistDetailReply {
        try await get("/api/qq/playlist/\(id)")
    }

    /// 每日推荐（只读；服务端每日 00:30 产出）
    func dailyRecommend() async throws -> DailyRecommend {
        try await get("/api/recommend/daily")
    }

    /// 取消收藏（幂等）。响应体不参与 UI，用空结构吞掉，避免为此新增一个模型。
    func removeFavorite(trackId: String) async throws {
        let _: EmptyReply = try await send("/api/favorites/\(trackId)", method: "DELETE")
    }

    // MARK: 账号 / 更新

    /// 修改密码（服务端会签发新会话，调用方必须 adopt 掉）
    func changePassword(oldPassword: String, newPassword: String) async throws -> AuthSession {
        struct Body: Encodable { let oldPassword: String; let newPassword: String }
        let data = try JSONEncoder().encode(Body(oldPassword: oldPassword, newPassword: newPassword))
        return try await send("/api/auth/password", method: "PATCH", body: data)
    }

    /// 检查更新（三形态的数据源）。`force` 只有用户手点才传 true。
    func checkUpdate(versionName: String, versionCode: Int, force: Bool) async throws -> UpdateCheckReply {
        var q = ["platform": "ios", "version_name": versionName, "version_code": String(versionCode)]
        if force { q["force"] = "1" }
        return try await get("/api/update/check", query: q)
    }

    /// 交给系统浏览器/侧载工具下载的直链（带短期令牌）
    func updateDownloadURL(path: String, token: String) -> String {
        baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            + path + "?platform=ios&token=" + token
    }

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

    /// 路径段转义（服务端 `:id` / `:type` 都是单段，斜杠不能出现）
    private func seg(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? raw
    }

    // MARK: 收藏内容 / 导入 / 去重

    /// 收藏的曲目内容（服务端一次补齐，上限 500 首）
    func favoriteTracks(limit: Int = 500) async throws -> [Track] {
        struct Reply: Decodable { let tracks: [Track] }
        let r: Reply = try await get("/api/favorites/tracks", query: ["limit": String(limit)])
        return r.tracks
    }

    /// 用完整曲目对象批量导入收藏（服务端 500 首封顶，重复的自动跳过）
    func importFavorites(_ tracks: [Track]) async throws -> ImportReply {
        struct Body: Encodable { let tracks: [Track] }
        let data = try JSONEncoder().encode(Body(tracks: tracks))
        return try await send("/api/favorites/import", method: "POST", body: data)
    }

    /// 从 QQ 音乐歌单链接 / 歌单 id 直接导入收藏（服务端自动去重）
    func importQqPlaylist(link: String) async throws -> QqImportReply {
        struct Body: Encodable { let link: String }
        let data = try JSONEncoder().encode(Body(link: link))
        return try await send("/api/favorites/import-qq-playlist", method: "POST", body: data)
    }

    /// 去重预检：只读，返回重复分组（每组保留最早收藏的一首）
    func dedupPreview() async throws -> DedupPreview {
        try await send("/api/favorites/dedup/preview", method: "POST", body: Data("{}".utf8))
    }

    /// 执行去重：真正删除每组里除最早收藏以外的曲目
    func dedupApply() async throws -> DedupResult {
        try await send("/api/favorites/dedup", method: "POST", body: Data("{}".utf8))
    }

    // MARK: 推荐黑名单

    /// 「不喜欢」列表（曲目 / 歌手两型）
    func dislikes() async throws -> [DislikeEntry] {
        struct Reply: Decodable { let dislikes: [DislikeEntry] }
        let r: Reply = try await get("/api/recommend/dislikes")
        return r.dislikes
    }

    /// 记一条「不喜欢」。type 取 `track` / `artist`（歌手型会连带解绑用户曲库归属）
    func addDislike(type: String, id: String, name: String) async throws {
        struct Body: Encodable { let type: String; let id: String; let name: String }
        let data = try JSONEncoder().encode(Body(type: type, id: id, name: name))
        let _: EmptyReply = try await send("/api/recommend/dislike", method: "POST", body: data)
    }

    /// 撤销一条「不喜欢」（幂等）
    func removeDislike(type: String, id: String) async throws {
        let _: EmptyReply = try await send(
            "/api/recommend/dislike/\(seg(type))/\(seg(id))", method: "DELETE"
        )
    }

    // MARK: 用户画像

    /// 当前用户画像（摘要 + 画像行 + 台账行）
    func persona() async throws -> PersonaReply {
        try await get("/api/ai/persona")
    }

    /// 用一句引导意见调优画像。服务端把结果包在 `persona` 里
    func tunePersona(guidance: String) async throws -> PersonaReply {
        struct Body: Encodable { let guidance: String }
        struct Reply: Decodable { let persona: PersonaReply }
        let data = try JSONEncoder().encode(Body(guidance: guidance))
        let r: Reply = try await send("/api/ai/persona/tune", method: "POST", body: data)
        return r.persona
    }

    // MARK: 音源账号

    /// B 站账号状态（全站共用一份凭证；判定看 `configured`）
    func bilibiliAccount() async throws -> SourceAccount {
        try await get("/api/bilibili/account")
    }

    /// 网易云账号状态（`account` 可能为 null 而 `configured` 为 true，判定看 `configured`）
    func neteaseAccount() async throws -> SourceAccount {
        try await get("/api/netease/account")
    }

    // MARK: 手动锚定

    /// 当前锚点。**没有锚点时服务端回 `{ "anchor": null }`，这里是 nil 而不是抛错**
    func trackAnchor(_ trackId: String) async throws -> AnchorInfo? {
        struct Reply: Decodable { let anchor: AnchorInfo? }
        let r: Reply = try await get("/api/tracks/\(seg(trackId))/anchor")
        return r.anchor
    }

    /// 锚定「这首曲 = 这个 B 站视频」。服务端只回 `{ ok, trackId, bvid }`，
    /// 所以写完再读一次，拿齐 title / author / durationSec
    @discardableResult
    func setAnchor(_ trackId: String, bvid: String) async throws -> AnchorInfo {
        struct Body: Encodable { let bvid: String }
        struct Reply: Decodable { let ok: Bool?; let trackId: String?; let bvid: String? }
        let data = try JSONEncoder().encode(Body(bvid: bvid))
        let r: Reply = try await send("/api/tracks/\(seg(trackId))/anchor", method: "POST", body: data)
        if let anchor = try? await trackAnchor(trackId) { return anchor }
        return AnchorInfo(trackId: r.trackId ?? trackId, bvid: r.bvid ?? bvid, pinned: true)
    }

    /// 解除锚定（之后该曲目回到正常自动匹配）
    func removeAnchor(_ trackId: String) async throws {
        let _: EmptyReply = try await send("/api/tracks/\(seg(trackId))/anchor", method: "DELETE")
    }

    // MARK: 批量解析 / 流会话令牌

    /// 播放队列预取：服务端串行解析（最多 10 首），返回按 trackId 索引的结果
    func resolveBatch(_ ids: [String]) async throws -> [String: ResolveReply] {
        struct Body: Encodable { let trackIds: [String] }
        struct Reply: Decodable { let results: [ResolveReply] }
        let data = try JSONEncoder().encode(Body(trackIds: ids))
        let r: Reply = try await send("/api/resolve/batch", method: "POST", body: data)
        var out: [String: ResolveReply] = [:]
        for item in r.results {
            guard let key = item.trackId, !key.isEmpty, out[key] == nil else { continue }
            out[key] = item
        }
        return out
    }

    /// 会话级流令牌（绑定 `*`，给原生播放器整条队列一次签发）
    func streamSessionToken() async throws -> String {
        struct Reply: Decodable { let token: String; let expiresInMs: Int? }
        let r: Reply = try await get("/api/stream/session-token")
        return r.token
    }

    /// 探测任意 base 的 `/api/health`（免鉴权）。2 秒超时；**必须校验返回体 `ok == true`**
    /// —— 门户劫持 / 反代错误页也会回 200
    func health(base: String) async -> Bool {
        let root = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: root + "/api/health") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return false }
            struct Reply: Decodable { let ok: Bool? }
            return (try? JSONDecoder().decode(Reply.self, from: data))?.ok == true
        } catch {
            return false
        }
    }
}
