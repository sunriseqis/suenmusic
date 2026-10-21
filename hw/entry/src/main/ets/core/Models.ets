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
