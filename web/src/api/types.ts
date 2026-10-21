/**
 * 与服务端响应一一对应的类型。
 *
 * 这里的每个形状都是从 `server/src/routes/*.ts` 与 `server/src/sources/qq/adapter.ts`
 * 实录而来的，不是设计稿 —— 服务端改字段，这里必须同步。
 *
 * 一条贯穿全局的约定：**所有 `id` 都是路由键**（`qq_` / `qq_al_` / `qq_ar_` /
 * `qq_pl_` / `qq_top_` 前缀 + mid）。服务端在适配层就把 QQ 的数字 id 换掉了，
 * 客户端永远不需要自己拼前缀，也永远不该出现裸数字 id。
 */

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/** 上游限流时的降级说明。**绝不能忽略它然后显示"无结果"**（PLAN.md 5.3） */
export interface Degraded {
  code: number | null;
  message?: string;
  retryAfterMs?: number;
  slices?: string[];
}

/** 服务端统一错误体：`{ error: { code, message } }` */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  createdAt: number;
  /** 'admin' | 'member'（第一个账号是管理员） */
  role: 'admin' | 'member';
}

export interface AuthSession {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  /** 访问令牌过期时刻（毫秒时间戳） */
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

/** `GET /api/auth/config` —— 公开，登录页据此决定是否显示注册入口 */
export interface AuthConfig {
  registrationOpen: boolean;
  allowRegistration: boolean;
  hasUsers: boolean;
  passwordMinLength: number;
  /** 库里一个用户都没有：首次打开要创建管理员 */
  setupRequired: boolean;
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  userAgent: string;
  isCurrent?: boolean;
}

// ---------------------------------------------------------------------------
// 音乐实体
// ---------------------------------------------------------------------------

export interface TrackArtist {
  /** 路由键 `qq_ar_<mid>` */
  id: string;
  mid: string;
  name: string;
  picUrl: string;
}

export interface TrackAlbum {
  /** 路由键 `qq_al_<mid>` */
  id: string;
  mid: string;
  name: string;
  picUrl: string;
}

export interface Track {
  /** 路由键 `qq_<mid>` */
  id: string;
  mid: string;
  name: string;
  ar: TrackArtist[];
  /** 与 ar 同内容，服务端为兼容保留的别名 */
  artists: TrackArtist[];
  al: TrackAlbum;
  album: { id: string; name: string; picUrl: string };
  /** 时长（毫秒）。注意：B 站音源实际时长常与此不符，以流响应为准 */
  dt: number;
  /** 时长（秒） */
  duration: number;
  playable: boolean;
  matched: boolean;
  privilege: {
    playMaxbr: number;
    maxbr: number;
    freeTrialPrivilege: { resConsumable: boolean };
  };
  recommendReason?: string;
}

export interface Album {
  id: string;
  mid: string;
  name: string;
  picUrl: string;
  publishTime: string;
  description: string;
  company: string;
  type: string;
  size: number;
  artists: TrackArtist[];
  artist: TrackArtist | { name: string };
}

export interface Artist {
  id: string;
  mid: string;
  name: string;
  picUrl: string;
  img1v1Url: string;
  alias: string[];
  albumSize: number;
  musicSize: number;
  mvSize: number;
  briefDesc: string;
}

export interface Playlist {
  id: string;
  tid: string | number | undefined;
  name: string;
  picUrl: string;
  coverImgUrl: string;
  playCount: number;
  copywriter: string;
  description: string;
  size: number;
  updateFrequency: string;
  type: 'playlist';
}

export interface Toplist {
  id: string;
  topId: number;
  name: string;
  picUrl: string;
  coverImgUrl: string;
  updateFrequency: string;
  playCount: number;
  type: 'toplist';
  songList: Array<{ name: string; singer: string }>;
  /** 榜单简介。只有详情接口会带，首页卡片没有 */
  intro?: string;
}

// ---------------------------------------------------------------------------
// 目录端点
// ---------------------------------------------------------------------------

/**
 * 首页聚合。
 *
 * **没有 `banners`**：上游那组运营大图（`GetFocus`）与 Q 音首页的「精彩推荐」
 * 不是同一批内容，而 Q 音真正的首页数据走加密接口拿不到 —— 拿不到就不摆。
 * 顶部海报位由 `newAlbums`（新碟首发）担纲。
 */
export interface HomeData {
  /** 新碟首发。首页顶部海报位 */
  newAlbums: Album[];
  /** 新歌首发 */
  newSongs: Track[];
  /** 巅峰榜：飙升 / 热歌 / 新歌 / 流行指数，固定四个 */
  toplists: Toplist[];
  /** AI 生成的专属欢迎短语（4~8 汉字） */
  welcomePhrase?: string;
}

export type SearchType = 'all' | 'song' | 'album' | 'artist' | 'playlist' | 'mv';

export interface SearchResult {
  query: string;
  type: SearchType;
  page: number;
  limit: number;
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  mvs: Array<Record<string, unknown>>;
  /**
   * **分片级**"上游这一页是否被填满"。
   *
   * 原来只有一个顶层 `hasMore = songs.length >= limit`，于是搜歌手/专辑时
   * `songs` 恒为空 → `hasMore` 永远是 false → 明明还有下一页却翻不动。
   *
   * ⚠️ 它只表示"**还有下一页**"，**不是总数**：QQ 搜索响应里根本没有总数
   * （每个分片只有 `list`），所以界面上不能把它当"共 N 条"展示。
   */
  hasMore: {
    song: boolean;
    album: boolean;
    artist: boolean;
    playlist: boolean;
  };
  degraded: Degraded | null;
}

export interface ToplistDetail {
  id: string;
  topInfo: Toplist | null;
  tracks: Track[];
  hasMore: boolean;
}

export interface ArtistSongs {
  id: string;
  name: string;
  songs: Track[];
  hasMore: boolean;
  degraded: Degraded | null;
}

/**
 * 歌手专辑列表。
 *
 * 与 `ArtistSongs` 分成两个接口：两者各要打一次搜索分片，而搜索最容易触发
 * QQ 风控 —— 合起来会让"歌曲被限流了、专辑却正常"这种情况无法表达。
 */
export interface ArtistAlbums {
  id: string;
  name: string;
  albums: Album[];
  hasMore: boolean;
  degraded: Degraded | null;
}

/** 相似歌手。id 是 QQ 歌手 mid，可直接拼 `qq_ar_` 路由键 */
export interface SimilarArtists {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
}

export interface AlbumDetail {
  album: Album;
  songs: Track[];
  /**
   * 曲目为空时上游给出的原因（实测形如「抱歉，因版权限制暂无法查看该专辑下歌曲」），
   * 曲目正常时为 null。**有值就直接展示上游原话**，不要自己编"可能需要会员"。
   */
  notice: string | null;
}

/** QQ 官方歌单的详情头 */
export interface QQPlaylistDetail {
  id: string;
  name: string;
  coverImgUrl: string;
  picUrl: string;
  description: string;
  playCount: number;
  trackCount: number;
  creator: { nickname: string; userId: number };
}

export interface QQPlaylistResult {
  playlist: QQPlaylistDetail;
  tracks: Track[];
}

/** `GET /api/lyrics/:id`。两段都是 LRC 文本，无翻译时 tlyric 为空串 */
export interface LyricResult {
  id: string;
  lrc: { lyric: string };
  tlyric: { lyric: string };
}

// ---------------------------------------------------------------------------
// 音源解析与播放
// ---------------------------------------------------------------------------

/** 解析失败原因。`no_match` 是"搜不到"，`cooldown` 是"上游限流中"，两者必须分开提示 */
export type ResolveReason =
  | 'ok'
  | 'no_match'
  | 'cooldown'
  | 'error'
  | 'unavailable'
  | 'not_found';

export interface ResolveCandidate {
  bvid: string;
  title: string;
  author: string;
  score: number;
  durationMs?: number;
  [key: string]: unknown;
}

export interface ResolveResult {
  trackId: string;
  ok: boolean;
  reason: ResolveReason | null;
  /** 面向用户的失败说明，服务端已写好中文 */
  message: string | null;
  score: number;
  bvid: string | null;
  matchedTitle: string | null;
  matchedAuthor: string | null;
  durationDiff: number | null;
  /** true = DASH 不可用，回落到音视频混合流 */
  fallbackStream: boolean;
  bandwidth: number;
  /**
   * **相对路径**，形如 `/api/stream/qq_xxx?t=<签名令牌>`。
   * 前端必须拼上基地址再喂给 `<audio>`；且**绝不能缓存**（带签名时效）。
   */
  streamUrl: string | null;
  streamTokenExpiresInSec: number;
  expiresInSec: number;
  /** 缓存命中层级：memory / db / upstream / cooldown */
  hitLevel: string;
  /**
   * 音源来源。客户端据此显示音源角标。
   *
   * 服务端保证非空：`routes/resolve.ts` 统一 `row?.source ?? outcome.source ?? 'bilibili'`
   * 归一化后才下发（缓存命中读库，库里那列也只会是 bilibili/netease）。
   * 所以声明为必填 —— 客户端不再需要 `?? 'bilibili'`，
   * 那种兜底只会把「服务端漏字段」掩盖成静默错标。
   */
  source: 'bilibili' | 'netease';
  costMs: number;
  topCandidates: ResolveCandidate[];
  /** B 站视频封面。曲目没有 Q 音专辑封面时的显示层兜底 */
  coverUrl?: string | null;
  /**
   * 服务端回源补全的完整曲目元数据（含专辑/封面）。
   * 队列里的曲目可能来自带不全字段的搜索结果（只有歌名），
   * 前端发现缺 al/ar 时用这份现场补全，播放页立刻有封面与专辑。
   */
  track?: Track | null;
  /**
   * 是否属于"上游限速/限流"（QQ/B站/网易被限速）。
   * 这类失败**等一会能恢复**，客户端提示"当前网络繁忙，请等待"并停止跳转；
   * 其余失败（服务端不可达 / 音源不可用）统一呈现"网络连接失败"并跳下一首再试。
   */
  rateLimited?: boolean;
  /** 限速剩余时间（毫秒），可选 */
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// 播放历史 / 续播
// ---------------------------------------------------------------------------

export interface TrackProgress {
  trackId: string;
  playedMs: number;
  playedAt: number;
}

export interface HistoryItem {
  id: number;
  trackId: string;
  playedMs: number;
  playedAt: number;
  /** 服务端联表带回的曲目快照；曲目已不在缓存表时为 null */
  track: Track | null;
}

// ---------------------------------------------------------------------------
// 收藏与用户歌单
// ---------------------------------------------------------------------------

export interface FavoriteItem {
  trackId: string;
  createdAt: number;
  /** 曲目快照；缓存里没有这首歌时为 null */
  track: Track | null;
}

export interface FavoritePage {
  items: FavoriteItem[];
  total: number;
  /**
   * 下一页游标，形如 `<createdAt>:<trackId>`。
   * 是**复合游标**而不是时间戳 —— 同一毫秒内收藏的多首在翻页边界上会漏。
   * 为 null 表示没有更多。
   */
  nextCursor: string | null;
  /** AI 生成的整个收藏列表品味洞察评语 */
  summary?: string | null;
}



// ---------------------------------------------------------------------------
// B 站音源账号（服务端持有的凭证）
// ---------------------------------------------------------------------------
//
// 注意这不是"本站用户"：B 站音源由服务端代理取流，整台服务只有一个出网身份，
// 所以这份凭证是**全站共用**的，退出也是全员退出。

export interface BilibiliAccountInfo {
  mid: number;
  name: string;
  face: string;
  /** 大会员 */
  vip: boolean;
  loggedInAt: number;
}

/** `database` = 界面扫码登录的；`env` = 服务端环境变量兜底；`none` = 未配置 */
export type BilibiliCookieSource = 'database' | 'env' | 'none';

export interface BilibiliStatus {
  configured: boolean;
  source: BilibiliCookieSource;
  account: BilibiliAccountInfo | null;
  hasSessdata: boolean;
  /** 能否从界面退出。环境变量兜底的那份删不掉，为 false */
  canLogout: boolean;
}

export interface BilibiliQrSession {
  qrcodeKey: string;
  /** B 站登录页地址，给"在 B 站打开"用 */
  url: string;
  /** `data:image/svg+xml;base64,...`；URL 超长导致画不出来时为 null */
  qrImage: string | null;
}

export type BilibiliQrState = 'pending' | 'scanned' | 'confirmed' | 'expired' | 'failed';

export interface BilibiliQrPoll {
  state: BilibiliQrState;
  account?: BilibiliAccountInfo;
  message: string;
}

// ---------------------------------------------------------------------------
// 网易云音源账号（服务端持有的凭证；与 B 站同构，全站共用）
// ---------------------------------------------------------------------------

export interface NeteaseAccountInfo {
  userId: number;
  name: string;
  face: string;
  /** vipType：10 = 普通黑胶，11 = 学生黑胶等，0 = 无。决定 lossless 能否拿到 */
  vipType: number;
  loggedInAt: number;
}

export interface NeteaseStatus {
  configured: boolean;
  source: 'database' | 'env' | 'none';
  account: NeteaseAccountInfo | null;
  canLogout: boolean;
}

export interface NeteaseQrSession {
  qrcodeKey: string;
  url: string;
  qrImage: string | null;
}

export type NeteaseQrState = 'pending' | 'scanned' | 'confirmed' | 'expired' | 'failed';

export interface NeteaseQrPoll {
  state: NeteaseQrState;
  account?: NeteaseAccountInfo;
  message: string;
}

// ---------------------------------------------------------------------------
// AI 模型配置与用户画像
// ---------------------------------------------------------------------------

export interface AiModelProfileView {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  model: string;
}

export interface AiSettingsConfigView {
  profiles: AiModelProfileView[];
  decideProfileId: string;
  reviewProfileId: string;
}

export interface PersonaDetail {
  summary: string;
  profileLines: string[];
  ledgerLines: string[];
  lastGuidance: string;
  updatedAt: number | null;
}

