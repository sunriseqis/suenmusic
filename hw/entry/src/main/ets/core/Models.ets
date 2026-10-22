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
  /** @deprecated 服务端 `adaptQQAlbum` 不输出该字段，历史快照兼容保留 */
  singerName?: string;
}

export interface HomeData {
  newAlbums: Album[];
  newSongs: Track[];
  toplists: Toplist[];
  welcomePhrase?: string;
}

export interface ResolveResponse {
  trackId: string;
  ok: boolean;
  reason?: string;
  message?: string;
  score: number;
  source: string;
  streamUrl?: string;
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

/** `GET /api/search`。playlists / mvs 本增量不展示，按不透明对象占位 */
export interface SearchResult {
  query: string;
  type: string;
  page: number;
  limit: number;
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Object[];
  mvs: Object[];
  hasMore: SearchHasMore;
  degraded: SearchDegraded | null;
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
  status: string;
  date: string;
  greeting?: string;
  welcomePhrase?: string;
  tracks: Track[];
  message?: string;
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
