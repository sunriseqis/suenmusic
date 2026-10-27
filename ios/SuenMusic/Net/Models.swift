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

/// `GET /api/lyrics/:id` 的返回（字段与 hw 同口径）
struct LyricReply: Decodable {
    struct Body: Decodable {
        let lyric: String?
        let tlyric: Trans?
    }
    struct Trans: Decodable { let lyric: String? }
    let id: String
    let lrc: Body?
}

struct TrackArtist: Codable, Hashable, Identifiable {
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
    /// `bilibili` / `netease` / `kugou` —— 只用于角标展示
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
    /// ready | generating | failed（服务端契约；老版本可能是 shortfall | error）
    let status: String?
    let date: String?
    let greeting: String?
    let welcomePhrase: String?
    let tracks: [Track]
    let message: String?
    /// 失败时**可直接上屏**的中文（服务端定文案，客户端不再自己编）
    let statusMessage: String?
    /// 失败分类：timeout/ratelimit/auth/billing/parse/error/shortfall —— 只是给排查用，不上屏
    let statusDetail: DailyStatusDetail?
}

struct DailyStatusDetail: Codable {
    let code: String?
}

// MARK: - 收藏导入 / 去重（`/api/favorites/*`）

/// `POST /api/favorites/import` 的返回
struct ImportReply: Decodable {
    let ok: Bool?
    /// 服务端收到的曲目数（含已收藏的）
    let received: Int?
    /// 真正新加入收藏的数量（已存在的不计数）
    let added: Int?
    let total: Int?
}

/// `POST /api/favorites/import-qq-playlist` 的返回
struct QqImportReply: Decodable {
    let ok: Bool?
    let playlistName: String?
    let received: Int?
    let added: Int?
    let skipped: Int?
    let total: Int?
}

/// 去重分组（服务端同一份数据给了 `duplicateGroups` / `groups` 两个键）
struct DedupGroup: Decodable {
    let key: String?
    let name: String?
    let artist: String?
    let total: Int?
    let count: Int?
    let keepTrackId: String?
    let keepId: String?
    let removeTrackIds: [String]?
    let removeIds: [String]?
}

/// `POST /api/favorites/dedup/preview` 的返回（只读预检，不删任何东西）
struct DedupPreview: Decodable {
    let ok: Bool?
    let duplicateCount: Int?
    let groupsCount: Int?
    let duplicateGroups: [DedupGroup]?
    let groups: [DedupGroup]?

    /// 服务端最多回 100 组；两个键名任取其一
    var resolvedGroups: [DedupGroup] { duplicateGroups ?? groups ?? [] }
}

/// `POST /api/favorites/dedup` 的返回
struct DedupResult: Decodable {
    let ok: Bool?
    let removedCount: Int?
    let remainingCount: Int?
}

// MARK: - 推荐黑名单（`/api/recommend/*`）

/// `GET /api/recommend/dislikes` 的列表项
struct DislikeEntry: Decodable, Identifiable {
    /// `track` / `artist`
    let type: String?
    /// 曲目 id 或歌手 mid
    let targetId: String?
    let name: String?
    let createdAt: Double?

    var id: String { "\(type ?? "")::\(targetId ?? "")" }
}

// MARK: - 用户画像（`/api/ai/persona*`）

/// `GET /api/ai/persona`（裸对象）与 `POST /api/ai/persona/tune`（`persona` 包裹）共用
struct PersonaReply: Decodable {
    let summary: String?
    let profileLines: [String]
    let ledgerLines: [String]
    let lastGuidance: String?
    /// 毫秒时间戳；从未生成过时为 null
    let updatedAt: Double?

    enum CodingKeys: String, CodingKey {
        case summary, profileLines, ledgerLines, lastGuidance, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        profileLines = try c.decodeIfPresent([String].self, forKey: .profileLines) ?? []
        ledgerLines = try c.decodeIfPresent([String].self, forKey: .ledgerLines) ?? []
        lastGuidance = try c.decodeIfPresent(String.self, forKey: .lastGuidance)
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt)
    }
}

// MARK: - 音源账号（B 站 / 网易云，全站共用一份出网身份）

/// `GET /api/bilibili/account` 与 `GET /api/netease/account`（两源同构）
/**
 * 酷狗登录态（服务端四态统一判定）。
 *
 * state: logged_out 未登录 / invalid 登录已失效 / vip_expired 已登录·会员到期 / ok 已登录·会员有效。
 * label 直接用服务端文案 —— 会员到期与登录失效是两种不同故障，端侧不再自己拼。
 */
struct KugouLoginState: Decodable {
    let state: String
    let label: String
    let userid: String?
    let nickname: String?
    let vipEndTime: String?
    let vipExpireAt: String?
    let checkedIn: Bool?
    let upgraded: Bool?
    let checkinDate: String?
    let svipActive: Bool?
}

struct SourceAccount: Decodable {
    /// B 站是 `mid`、网易云是 `userId`，其余字段两源共用
    struct Inner: Decodable {
        let name: String?
        let mid: Int?
        let userId: Int?
        let face: String?
        let vip: Bool?
        let vipType: Int?
        let loggedInAt: Double?
    }

    /// 是否有一份可用的凭证。**判定必须优先它**：网易云的 `account` 可能是 null
    /// 而 `configured` 为 true（环境变量兜底），拿 account 判空会误报未登录
    let configured: Bool
    /// `database` / `env` / `none`
    let source: String?
    let account: Inner?
    /// B 站独有：凭证里有没有 SESSDATA（缺它等于没登录）
    let hasSessdata: Bool?
    let canLogout: Bool?

    /// 账号昵称（两源都在 `account.name`）
    var name: String? { account?.name }
    var isConfigured: Bool { configured }

    enum CodingKeys: String, CodingKey {
        case configured, source, account, hasSessdata, canLogout
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        configured = try c.decodeIfPresent(Bool.self, forKey: .configured) ?? false
        source = try c.decodeIfPresent(String.self, forKey: .source)
        account = try c.decodeIfPresent(Inner.self, forKey: .account)
        hasSessdata = try c.decodeIfPresent(Bool.self, forKey: .hasSessdata)
        canLogout = try c.decodeIfPresent(Bool.self, forKey: .canLogout)
    }
}

// MARK: - 手动锚定（`/api/tracks/:id/anchor`）

/// 曲目与 B 站视频的锚定映射（服务端 `track_anchors` 表的一行）
struct AnchorInfo: Decodable {
    let trackId: String?
    let bvid: String
    let title: String?
    let author: String?
    /// 秒。服务端存的是整数，这里用 Double 兜浮点
    let durationSec: Double?
    /// true = 用户手动锚定（自动沉淀的锚定不会被算法覆盖）
    let pinned: Bool?

    enum CodingKeys: String, CodingKey {
        case trackId, bvid, title, author, durationSec, pinned
    }

    init(trackId: String? = nil, bvid: String, title: String? = nil, author: String? = nil,
         durationSec: Double? = nil, pinned: Bool? = nil) {
        self.trackId = trackId
        self.bvid = bvid
        self.title = title
        self.author = author
        self.durationSec = durationSec
        self.pinned = pinned
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        trackId = try c.decodeIfPresent(String.self, forKey: .trackId)
        bvid = try c.decodeIfPresent(String.self, forKey: .bvid) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title)
        author = try c.decodeIfPresent(String.self, forKey: .author)
        durationSec = try c.decodeIfPresent(Double.self, forKey: .durationSec)
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned)
    }
}

// MARK: - 批量解析（`POST /api/resolve/batch`）

/// 批量解析的单项结果。**全部可选**：失败项只有 trackId/ok/reason/message，
/// 成功项才带 score/streamUrl —— 用非可选字段会让整批解码失败
struct ResolveReply: Decodable {
    let trackId: String?
    let ok: Bool?
    let reason: String?
    /// true = 上游限速（客户端应提示「当前网络繁忙」而不是狂试）
    let rateLimited: Bool?
    let retryAfterMs: Int?
    let message: String?
    let score: Int?
    let bvid: String?
    let matchedTitle: String?
    let matchedAuthor: String?
    let durationDiff: Double?
    let fallbackStream: Bool?
    let bandwidth: Int?
    let source: String?
    /// 相对路径，必须拼 baseURL 才能喂给播放器
    let streamUrl: String?
    let streamTokenExpiresInSec: Int?
    let track: Track?
    let coverUrl: String?
}

// MARK: - 服务端错误体

struct ApiErrorBody: Codable {
    struct Inner: Codable {
        let code: String
        let message: String
    }
    let error: Inner
}
