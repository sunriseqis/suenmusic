/**
 * 与服务端契约一一对应的 Codable 模型。
 *
 * 字段名直接沿用服务端 JSON（`ar` / `al` / `dt` …，那是 Q 音的命名），
 * **不要**为了 Swift 风格重命名 —— 一处改名就得写一堆 CodingKeys，反而更脆。
 * 源码对照：`web/src/api/types.ts`（Vue 端同一份契约）。
 */

import Foundation

// MARK: - 账号

struct PublicUser: Codable, Identifiable, Hashable {
    let id: Int
    let username: String
    let displayName: String
    let role: String
}

struct AuthSession: Codable {
    let user: PublicUser
    let accessToken: String
    let refreshToken: String
    let accessExpiresAt: Double
    let refreshExpiresAt: Double
}

struct AuthConfig: Codable {
    let registrationOpen: Bool
    let setupRequired: Bool
    let passwordMinLength: Int
}

// MARK: - 曲目

struct TrackArtist: Codable, Hashable {
    let id: String
    let name: String
}

struct TrackAlbum: Codable, Hashable {
    let id: String
    let name: String
    let picUrl: String
}

struct Track: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let ar: [TrackArtist]
    let al: TrackAlbum
    /// 毫秒。**B 站音源的真实时长常与此不符**，播放时以流响应头 `X-Audio-Duration-Ms` 为准
    let dt: Int

    var artistLine: String {
        ar.map(\.name).filter { !$0.isEmpty }.joined(separator: " / ")
    }
}

// MARK: - 首页

struct Toplist: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let picUrl: String
    let updateFrequency: String?
}

struct Album: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let picUrl: String
    let singerName: String?
}

struct HomeData: Codable {
    let newAlbums: [Album]
    let newSongs: [Track]
    let toplists: [Toplist]
    let welcomePhrase: String?
}

// MARK: - 音源解析

struct ResolveResponse: Codable {
    let trackId: String
    let ok: Bool
    let reason: String?
    let message: String?
    let score: Int
    /// `bilibili` / `netease` —— 只用于角标展示
    let source: String
    /// **相对路径**，形如 `/api/stream/qq_xxx?t=<签名令牌>`；必须拼上 baseURL 才能喂给播放器
    let streamUrl: String?
    let streamTokenExpiresInSec: Int
    /// 服务端回源补全的完整元数据（搜索召回行常缺封面/专辑）
    let track: Track?
    let coverUrl: String?
    let durationDiff: Double?
}

// MARK: - 分页

struct FavoriteItem: Codable, Identifiable {
    var id: String { trackId }
    let trackId: String
    let createdAt: Double
    /// 快照缺失时为 nil
    let track: Track?
}

struct FavoritePage: Codable {
    let items: [FavoriteItem]
    let total: Int
    let nextCursor: String?
}

// MARK: - 服务端错误体

struct ApiErrorBody: Codable {
    struct Inner: Codable {
        let code: String
        let message: String
    }
    let error: Inner
}
