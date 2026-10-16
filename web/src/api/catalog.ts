/**
 * 目录类接口：首页、搜索、榜单、专辑、歌手、曲目、歌词。
 *
 * 全部需要登录 —— 服务端刻意如此，这些接口会消耗 QQ 侧配额，
 * 公开出去等于把服务端变成任何人都能白用的代理。
 */

import { loadOffline, saveOffline } from '@/offline/snapshot.ts';
import { http } from './client.ts';
import type {
  AlbumDetail,
  Artist,
  ArtistAlbums,
  ArtistSongs,
  HomeData,
  LyricResult,
  QQPlaylistResult,
  SearchResult,
  SearchType,
  SimilarArtists,
  ToplistDetail,
  Track,
} from './types.ts';

export function fetchHome(signal?: AbortSignal): Promise<HomeData> {
  return http.get<HomeData>('/api/home', { signal });
}

export interface SearchParams {
  q: string;
  type?: SearchType;
  page?: number;
  limit?: number;
  signal?: AbortSignal;
}

export function search({
  q,
  type = 'all',
  page = 1,
  limit = 30,
  signal,
}: SearchParams): Promise<SearchResult> {
  return http.get<SearchResult>('/api/search', {
    query: { q, type, page, limit },
    signal,
    // 搜索要等上游，给足时间
    timeoutMs: 25_000,
  });
}

export function fetchToplist(
  id: string,
  opts: { offset?: number; limit?: number; signal?: AbortSignal } = {}
): Promise<ToplistDetail> {
  return http.get<ToplistDetail>(`/api/toplist/${encodeURIComponent(id)}`, {
    query: { offset: opts.offset, limit: opts.limit },
    signal: opts.signal,
  });
}

export function fetchQQPlaylist(
  tid: string | number,
  signal?: AbortSignal
): Promise<QQPlaylistResult> {
  return http.get<QQPlaylistResult>(`/api/qq/playlist/${encodeURIComponent(String(tid))}`, {
    signal,
  });
}

export function fetchAlbum(id: string, signal?: AbortSignal): Promise<AlbumDetail> {
  return http.get<AlbumDetail>(`/api/albums/${encodeURIComponent(id)}`, { signal });
}

export function fetchArtist(id: string, signal?: AbortSignal): Promise<{ artist: Artist }> {
  return http.get<{ artist: Artist }>(`/api/artists/${encodeURIComponent(id)}`, { signal });
}

/**
 * 歌手热门歌曲。
 *
 * `name` 建议一起传：服务端拿不到名字时要先请求一次歌手详情（多一次上游请求），
 * 而调用方（歌手页）手上本来就有名字。
 */
export function fetchArtistSongs(
  id: string,
  opts: { name?: string; limit?: number; page?: number; signal?: AbortSignal } = {}
): Promise<ArtistSongs> {
  return http.get<ArtistSongs>(`/api/artists/${encodeURIComponent(id)}/songs`, {
    query: { name: opts.name, limit: opts.limit, page: opts.page },
    signal: opts.signal,
  });
}

/** 歌手专辑列表。`name` 的用途与 `fetchArtistSongs` 相同：省一次上游请求 */
export function fetchArtistAlbums(
  id: string,
  opts: { name?: string; limit?: number; page?: number; signal?: AbortSignal } = {}
): Promise<ArtistAlbums> {
  return http.get<ArtistAlbums>(`/api/artists/${encodeURIComponent(id)}/albums`, {
    query: { name: opts.name, limit: opts.limit, page: opts.page },
    signal: opts.signal,
  });
}

/** 相似歌手（歌手页底部）。上游任何一步失败服务端都返回空列表 */
export function fetchSimilarArtists(
  id: string,
  opts: { name: string; signal?: AbortSignal }
): Promise<SimilarArtists> {
  return http.get<SimilarArtists>(`/api/artists/${encodeURIComponent(id)}/similar`, {
    query: { name: opts.name },
    signal: opts.signal,
  });
}

export function fetchTrack(
  id: string,
  signal?: AbortSignal
): Promise<{ track: Track; source: string }> {
  return http.get(`/api/tracks/${encodeURIComponent(id)}`, { signal });
}

/** 歌词。无翻译时 `tlyric.lyric` 为空串，不是错误 */
export async function fetchLyrics(id: string, signal?: AbortSignal): Promise<LyricResult> {
  try {
    const res = await http.get<LyricResult>(`/api/lyrics/${encodeURIComponent(id)}`, { signal });
    // 落一份本地：离线时歌词不该是空白（用户报障"离线歌词也没了"）
    void saveOffline(`lyric:${id}`, res);
    return res;
  } catch (err) {
    const cached = await loadOffline<LyricResult>(`lyric:${id}`);
    if (cached) return cached;
    throw err;
  }
}

/** 批量取曲目快照。只读本地缓存，不消耗上游配额 */
export function fetchTracksBatch(
  ids: string[],
  signal?: AbortSignal
): Promise<{ tracks: Track[]; missing: string[] }> {
  return http.post('/api/tracks/batch', { ids }, { signal });
}
