/**
 * 与服务端契约一一对应的 ArkTS 模型。
 *
 * 字段名沿用服务端 JSON（`ar` / `al` / `dt` 是 Q 音命名），**不要为风格改名** ——
 * 改名就得写一堆映射，反而更脆。三端同一份契约：
 * `web/src/api/types.ts` / `ios/SuenMusic/Net/Models.swift` / 本文件。
 */

export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
}

export interface AuthSession {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface AuthConfig {
  registrationOpen: boolean;
  setupRequired: boolean;
  passwordMinLength: number;
}

export interface TrackArtist {
  id: string;
  name: string;
  /** 网易云/QQ 歌手 mid —— 「不喜欢歌手」按它过滤（老快照可能缺） */
  mid?: string;
  /** 歌手头像（T001 档；歌手页封面从召回曲目就地取，省一次详情请求） */
  picUrl?: string;
}

export interface TrackAlbum {
  id: string;
  name: string;
  picUrl: string;
}

export interface Track {
  id: string;
  name: string;
  ar: TrackArtist[];
  al: TrackAlbum;
  /** 毫秒。**B 站音源真实时长常与此不符**，以流的 `X-Audio-Duration-Ms` 为准 */
  dt: number;
  /** 专属推荐理由（服务端 reasonMap 下发；仅每日歌单内的曲目携带，普通曲目缺省） */
  recommendReason?: string;
}

export interface Toplist {
  id: string;
  name: string;
  picUrl: string;
  updateFrequency?: string;
}

export interface Album {
  id: string;
  name: string;
  picUrl: string;
  /** 发行日（`YYYY-MM-DD` 形态，新碟接口才有；搜索/详情可能为空）—— 海报日期角标用 */
  publishTime?: string;
  /** 歌手列表（新碟接口给 `artists`；老快照可能缺）—— 海报副行用 */
  artists?: TrackArtist[];
  /** 主歌手（详情/搜索接口给；搜索卡片副行用，取不到回退 artists） */
  artist?: TrackArtist;
  /** 发行公司（详情接口）—— 专辑页副行用 */
  company?: string;
  /** 专辑介绍（详情接口）—— 介绍折叠框用 */
  description?: string;
  /** 专辑类型（详情接口，如「专辑/EP」） */
  type?: string;
  /** 曲目数（详情接口） */
  size?: number;
  /** @deprecated 服务端 `adaptQQAlbum` 不输出该字段，历史快照兼容保留 */
  singerName?: string;
}

/** 搜索的歌单条目（`/api/search?type=playlist` 分片，QQ 适配字段） */
export interface Playlist {
  id: string;
  /** QQ 歌单 tid —— 打开详情用它（与 id 同值时可能缺省） */
  tid?: string | number;
  name: string;
  picUrl: string;
  coverImgUrl: string;
  playCount: number;
  copywriter?: string;
  description?: string;
  size?: number;
}

export interface HomeData {
  newAlbums: Album[];
  newSongs: Track[];
  toplists: Toplist[];
  welcomePhrase?: string;
}

export interface DirectLink {
  id: string;
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

export interface ResolveResponse {
  trackId: string;
  ok: boolean;
  reason?: string;
  message?: string;
  score: number;
  source: string;
  streamUrl?: string;
  /** 直链通道：设备直接向 CDN 取流（不经过服务端）。null = 服务端关闭了直链 */
  directUrl?: string;
  /** 直连必须带的头（B 站 CDN 校验 Referer；此处**不含 Cookie**） */
  directHeaders?: Record<string, string>;
  /** 直链剩余有效期（秒）；到期前应重新解析，播放中失效则回退 streamUrl */
  directExpiresInSec?: number;
  streamTokenExpiresInSec: number;
  track?: Track;
  coverUrl?: string;
}

export interface StreamSessionToken {
  token: string;
  expiresInMs: number;
}

export interface FavoriteItem {
  trackId: string;
  createdAt: number;
  track?: Track;
}

export interface FavoritePage {
  items: FavoriteItem[];
  total: number;
  nextCursor?: string;
  /** 收藏的 AI 摘要（首页才返回；空/缺省 = 没有，标题回退「收藏曲目」） */
  summary?: string;
}

/** `GET /api/lyrics/:id` —— lrc 是原文，tlyric 是翻译（可能为空串） */
export interface LyricPayload {
  lyric: string;
}

export interface LyricResult {
  id: string;
  lrc: LyricPayload;
  tlyric: LyricPayload;
}

/** 搜索的歌手条目（`/api/search` 分片，QQ 适配字段） */
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

/**
 * `hasMore` 是**分片级"还有下一页"**，不是总数 ——
 * QQ 搜索响应没有总数字段；搜歌手时 `hasMore.song` 恒 false 属正常，
 * 判断当前分片只能看对应的键。
 */
export interface SearchHasMore {
  song: boolean;
  album: boolean;
  artist: boolean;
  playlist: boolean;
}

/**
 * `/api/search` 的 `degraded`：QQ 上游限流（code 2001）时服务端随 HTTP 200 带回。
 * 空结果 + degraded 是「上游限流」而非「真的没有」——客户端必须提示，不能当空结果吞掉。
 */
export interface SearchDegraded {
  slices: string[];
  code: number | null;
  message?: string;
  retryAfterMs?: number;
}

/** `GET /api/search`。mv 本增量不展示，按不透明对象占位 */
export interface SearchResult {
  query: string;
  type: string;
  page: number;
  limit: number;
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  mvs: Object[];
  hasMore: SearchHasMore;
  degraded: SearchDegraded | null;
}

/** `GET /api/albums/:id`。notice：曲目为空时上游给的版权限制说明（有则原样展示） */
export interface AlbumDetail {
  album: Album;
  songs: Track[];
  notice: string | null;
}

/** `GET /api/artists/:id/songs`（按名搜索召回，可能带 degraded） */
export interface ArtistSongs {
  id: string;
  name: string;
  songs: Track[];
  hasMore: boolean;
  degraded: SearchDegraded | null;
}

/** `GET /api/artists/:id/albums`（与 ArtistSongs 分开：两者限流状态独立） */
export interface ArtistAlbums {
  id: string;
  name: string;
  albums: Album[];
  hasMore: boolean;
  degraded: SearchDegraded | null;
}

/** 相似歌手条目（`/api/artists/:id/similar` 的 artists 元素，id 是 QQ 歌手 mid） */
export interface SimiArtist {
  id: string;
  name: string;
}

/** `GET /api/artists/:id/similar`。上游任何一步失败服务端都返回空列表 */
export interface SimilarArtists {
  id: string;
  name: string;
  artists: SimiArtist[];
}

/** QQ 歌单创建者（QQPlaylistDetail.creator；无创建者时上游给 null） */
export interface QQPlaylistCreator {
  nickname: string;
  userId: number;
}

/** QQ 官方歌单详情头（`/api/qq/playlist/:tid`） */
export interface QQPlaylistDetail {
  id: string;
  name: string;
  coverImgUrl: string;
  picUrl: string;
  description: string;
  playCount: number;
  trackCount: number;
  creator: QQPlaylistCreator | null;
}

/** `GET /api/qq/playlist/:tid` */
export interface QQPlaylistResult {
  playlist: QQPlaylistDetail;
  tracks: Track[];
}

/** `GET /api/toplist/:id`（topInfo 上游拿不到时为 null） */
export interface ToplistDetail {
  id: string;
  topInfo: Toplist | null;
  tracks: Track[];
  hasMore: boolean;
}

/** `POST /api/favorites/check` 的返回 */
export interface FavoritesCheckReply {
  favorites: Record<string, boolean>;
}

/** `POST /api/favorites` 的返回（重复收藏 200 且 added=false） */
export interface FavoriteUpsertReply {
  ok: boolean;
  added: boolean;
  trackId: string;
}

/** `DELETE /api/favorites/:trackId` 的返回（幂等：不存在也 200） */
export interface FavoriteRemoveReply {
  ok: boolean;
  removed: boolean;
}

/**
 * `GET /api/recommend/daily`。
 * `status`：ready / generating / shortfall / error。
 * **`shortfall` 不是错误** —— 曲库不足是正常业务结果，界面要说人话。
 */
export interface DailyRecommend {
  /** ready | generating | failed（服务端契约；旧值可能是 shortfall | error） */
  status: string;
  date: string;
  greeting?: string;
  welcomePhrase?: string;
  tracks: Track[];
  message?: string;
  /** 失败时可直接上屏的中文（服务端定文案，客户端不再自己编） */
  statusMessage?: string;
  /** 失败分类：timeout/ratelimit/auth/billing/parse/error/shortfall，仅用于排查 */
  statusDetail?: DailyStatusDetail;
}

export interface DailyStatusDetail {
  code?: string;
}

/** `POST /api/recommend/dislike` 的返回（track = 永久过滤这首歌；artist = 连带删用户曲库归属链） */
export interface DislikeReply {
  ok: boolean;
  type: string;
  id: string;
}

/** `GET /api/recommend/dislikes` 的黑名单行（type = track / artist） */
export interface DislikeRow {
  type: string;
  targetId: string;
  name: string;
  createdAt: number;
}

/** `GET /api/update/check` 里 latest 字段（GitHub Release 产物） */
export interface UpdateArtifact {
  fileName: string;
  versionName: string;
  versionCode: number;
  size?: number;
  sha256?: string;
}

/** `GET /api/update/check` 的返回（T7：只用于「有新版就交给系统浏览器下载」） */
export interface UpdateCheckReply {
  available: boolean;
  current: UpdateVersionPair;
  latest?: UpdateArtifact;
  /** 下载路由（相对路径） */
  downloadPath: string;
  /** 短期下载令牌：浏览器发不出 Authorization 头，只能靠它换鉴权 */
  downloadToken: string;
}

/** 版本二元组 */
export interface UpdateVersionPair {
  versionName: string;
  versionCode: number;
}

/** `GET /api/recommend/dislikes` 的返回 */
export interface DislikeListReply {
  dislikes: DislikeRow[];
}

/** `POST /api/favorites/import-qq-playlist` 的返回 */
export interface QQImportReply {
  ok: boolean;
  playlistName: string;
  received: number;
  added: number;
  skipped: number;
  total: number;
}

/** 去重预检的重复组（服务端口径：歌名 + 主歌手相同；保留最早收藏） */
export interface DedupeGroup {
  key: string;
  name: string;
  artist: string;
  total: number;
  keepTrackId: string;
  removeTrackIds: string[];
}

/** `POST /api/favorites/dedup/preview` 的返回 */
export interface DedupePreviewReply {
  ok: boolean;
  duplicateCount: number;
  groupsCount: number;
  groups: DedupeGroup[];
}

/** `POST /api/favorites/dedup` 的返回 */
export interface DedupeReply {
  ok: boolean;
  removedCount: number;
  remainingCount: number;
}

/** `GET /api/favorites/tracks` 的返回（收藏曲目内容一次补齐） */
export interface FavoriteTracksReply {
  tracks: Track[];
}

/** `POST /api/favorites/import` 的返回（备份恢复用，tracks ≤ 500/批） */
export interface ImportFavoritesReply {
  ok: boolean;
  received: number;
  added: number;
  total: number;
}

// ---------------- 手动锚定（低置信曲目人工兜底，web api/playback.ts 同契约） ----------------

/** B 站候选视频（锚定弹窗用）。score = 按本曲元数据算的置信分；durationDiff = 与曲目时长之差（秒） */
export interface BiliCandidate {
  bvid: string;
  title: string;
  author: string;
  durationSec: number;
  score: number;
  durationDiff: number;
  /** 封面缩略图（B 站 CDN，https），可能为空串 */
  pic: string;
  /** 试听流地址（相对路径，带短期令牌，需拼服务端基地址） */
  previewUrl: string;
}

/** 曲目自身的 Q 音元数据（锚定弹窗的「原版参照」） */
export interface AnchorTrackMeta {
  id: string;
  name: string;
  artists: string[];
  durationMs: number;
  albumName: string;
  albumPic: string;
}

/** `GET /api/tracks/:id/bili-candidates`（keyword 缺省时服务端用「歌名 + 主歌手」自动构造） */
export interface BiliCandidatesResult {
  keyword: string;
  rejected: boolean;
  message?: string;
  track: AnchorTrackMeta;
  candidates: BiliCandidate[];
}

/** `POST /api/tracks/:id/anchor` 的请求体（bvid 必填，其余选填快照） */
export interface AnchorBody {
  bvid: string;
  title?: string;
  author?: string;
  durationSec?: number;
}

/** 曲目当前锚点（`GET /api/tracks/:id/anchor` 的 anchor 元素；未锚定时为 null） */
export interface TrackAnchorInfo {
  bvid: string;
  title: string;
  author: string;
  durationSec: number;
  pinned: boolean;
}

/** `GET /api/tracks/:id/anchor` 的返回 */
export interface TrackAnchorReply {
  anchor: TrackAnchorInfo | null;
}

/** `GET /api/ai/persona`（音乐画像；summary 为空 = 尚未生成） */
export interface PersonaDetail {
  summary: string;
  profileLines: string[];
  ledgerLines: string[];
}

/** `POST /api/ai/persona/tune` 的返回 */
export interface TuneReply {
  ok: boolean;
  persona: PersonaDetail;
}

/** 音源授权账号（B 站 mid / 网易云 userId，name 一定有） */
export interface SourceAccount {
  name?: string;
}

/** `GET /api/bilibili/account` 与 `/api/netease/account`（同构） */
export interface SourceStatus {
  configured: boolean;
  source: string;
  account: SourceAccount | null;
}

/** 简单 ok 应答 */
export interface OkReply {
  ok: boolean;
}

export interface ApiErrorInner {
  code: string;
  message: string;
}

export interface ApiErrorBody {
  error: ApiErrorInner;
}

export interface ServerCandidate {
  url: string;
  name: string;
}

/** 曲目 → 展示用的一行歌手名 */
export function artistLine(t: Track): string {
  const names: string[] = [];
  for (let i = 0; i < t.ar.length; i++) {
    const n = t.ar[i].name;
    if (n.length > 0) { names.push(n); }
  }
  return names.join(' / ');
}

/**
 * 专辑 → 展示用的一行歌手名（海报副行）。
 * 与 web `artistNames`（`utils/format.ts`）同口径：' / ' 连接、取不到回「未知歌手」。
 */
export function albumArtistLine(a: Album): string {
  const names: string[] = [];
  const artists = a.artists ?? [];
  for (let i = 0; i < artists.length; i++) {
    const n = artists[i].name;
    if (n.length > 0) { names.push(n); }
  }
  if (names.length === 0 && a.singerName !== undefined && a.singerName.length > 0) {
    return a.singerName;
  }
  return names.length > 0 ? names.join(' / ') : '未知歌手';
}

/**
 * 毫秒 → `m:ss` / `h:mm:ss`（web `formatDuration` 同口径：向下取整到秒）。
 * 负数 / 非有限值一律 `0:00` —— 流式响应下 duration 可能异常。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) { return '0:00'; }
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hour = Math.floor(totalSec / 3600);
  const pad = (n: number): string => (n < 10 ? '0' + n.toString() : n.toString());
  return hour > 0 ? `${hour}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
}

/** 播放量：1234 → `1234`，12345 → `1.2万`，过亿 → `1.2亿`（web `formatCount` 同口径） */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) { return '0'; }
  if (n < 10000) { return String(Math.floor(n)); }
  if (n < 100000000) {
    return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  }
  return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
}
