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
    /// 主歌手（详情/搜索接口给；新碟接口给的是 artists 数组）
    let singerName: String?
    /// 发行日（`YYYY-MM-DD` 形态，新碟接口才有）—— 海报日期角标用；对齐 hw `Album.publishTime`
    let publishTime: String?
    /// 歌手列表（新碟接口给 artists）—— 海报副行用；对齐 hw `Album.artists`
    let artists: [TrackArtist]?

    /// 海报副行文案（hw `albumArtistLine` 同口径：artists 优先，逐名拼接「/」，空则回退 singerName）
    var artistLine: String {
        let names = (artists ?? []).map(\.name).filter { !$0.isEmpty }
        if !names.isEmpty { return names.joined(separator: " / ") }
        if let s = singerName, !s.isEmpty { return s }
        return ""
    }
}

struct HomeData: Codable {
    let newAlbums: [Album]
    let newSongs: [Track]
    let toplists: [Toplist]
    let welcomePhrase: String?
}

// MARK: - 搜索

/// 分片级「还有下一页」（服务端 `hasMore`；**不能**用 songs.count 推断，搜歌手时 songs 恒空）
struct SearchHasMore: Codable, Hashable {
    let song: Bool
    let album: Bool
    let artist: Bool
    let playlist: Bool
}

/// 歌单卡（搜索结果/歌单页共用）
struct PlaylistCard: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let picUrl: String
    let creatorName: String?

    var subLine: String { creatorName ?? "" }
}

/// `GET /api/search` 的返回
struct SearchReply: Codable {
    let query: String
    let type: String
    let page: Int
    let limit: Int
    let songs: [Track]
    let albums: [Album]
    let artists: [TrackArtist]
    let playlists: [PlaylistCard]
    let hasMore: SearchHasMore
    /// 上游降级（部分分片缺失）时的提示文案
    let degraded: Bool?
}

// MARK: - 检查更新（与 hw 同口径：三形态 + 交给系统浏览器/侧载工具）

/// `latest` 字段（发行仓产物）
struct UpdateArtifact: Codable {
    let fileName: String
    let versionName: String
    let versionCode: Int
    let size: Int?
    let sha256: String?
}

/// `GET /api/update/check` 的返回
struct UpdateCheckReply: Codable {
    let available: Bool
    struct Pair: Codable { let versionName: String; let versionCode: Int }
    let current: Pair
    let latest: UpdateArtifact?
    let downloadPath: String
    /// 浏览器/侧载工具发不出 Authorization 头，只能靠这个短期令牌换鉴权
    let downloadToken: String
}

// MARK: - 集合页（专辑 / 歌手 / 歌单 / 榜单）

/// `GET /api/albums/:id`
struct AlbumDetailReply: Codable {
    let album: Album
    let songs: [Track]
    let notice: String?
}

/// `GET /api/toplist/:id`
struct ToplistDetailReply: Codable {
    let topInfo: Toplist?
    let tracks: [Track]
    let hasMore: Bool
}

/// `GET /api/artists/:id/songs`
struct ArtistSongsReply: Codable {
    let id: String
    let name: String
    let page: Int
    let songs: [Track]
    let hasMore: Bool
}

/// 歌单详情里的歌单本体（`GET /api/qq/playlist/:tid` 的 playlist 字段）
struct QqPlaylist: Codable, Hashable {
    let id: String
    let name: String
    let picUrl: String
    let description: String?
    let playCount: Int?
    let trackCount: Int?
    struct Creator: Codable, Hashable { let nickname: String; let userId: Int? }
    let creator: Creator?
}

/// `GET /api/qq/playlist/:tid`
struct QqPlaylistDetailReply: Codable {
    let playlist: QqPlaylist
    let tracks: [Track]
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
    /// 收藏的 AI 摘要（首页分页才有；空 = 没有，头部回退「收藏曲目」）
    let summary: String?
}

// MARK: - 每日推荐

/// `GET /api/recommend/daily` —— 只读（服务端每天 00:30 产出，无「换一批」）
struct DailyRecommend: Codable {
    let status: String?
    let date: String?
    let greeting: String?
    let welcomePhrase: String?
    let tracks: [Track]
    let message: String?
}

// MARK: - 服务端错误体

struct ApiErrorBody: Codable {
    struct Inner: Codable {
        let code: String
        let message: String
    }
    let error: Inner
}
