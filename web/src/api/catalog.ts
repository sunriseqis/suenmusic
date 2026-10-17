/**
 * 目录类接口：首页、搜索、榜单、专辑、歌手、曲目、歌词。
 *
 * 全部需要登录 —— 服务端刻意如此，这些接口会消耗 QQ 侧配额，
 * 公开出去等于把服务端变成任何人都能白用的代理。
 */

import { loadOffline, saveOffline } from '@/offline/snapshot.ts';
import { ApiError, http } from './client.ts';
import { serverReady } from '@/offline/syncMode.ts';
import { directSearch } from './direct/catalog.ts';
import { qqLyric } from './direct/upstream.ts';
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

/**
 * 首页数据。
 *
 * 无服务端时返回空结构而不是发请求 —— 首页目前完全由服务端的聚合接口产出
 * （新碟/新歌/榜单都要多次上游调用 + 缓存）。直连版首页是后续工作，
 * 这里先保证"不报错、界面能进"，用户可以直接去搜索。
 */
export function fetchHome(signal?: AbortSignal): Promise<HomeData> {
  if (!serverReady()) {
    return Promise.resolve({ newAlbums: [], newSongs: [], toplists: [] });
  }
  return http.get<HomeData>('/api/home', { signal });
}

export interface SearchParams {
  q: string;
  type?: SearchType;
  page?: number;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * 搜索。
 *
 * 有服务端走服务端（它有多源匹配与缓存），服务端不可达时**自动改直连** ——
 * 这是"服务端不在关键路径上"的第一处落地：后端挂了，搜索照样能用。
 * 无服务端时直接用 QQ 搜索（实测零凭据可用）。
 */
export async function search({
  q,
  type = 'all',
  page = 1,
  limit = 30,
  signal,
}: SearchParams): Promise<SearchResult> {
  if (serverReady()) {
    try {
      return await http.get<SearchResult>('/api/search', {
        query: { q, type, page, limit },
        signal,
        // 搜索要等上游，给足时间
        timeoutMs: 25_000,
      });
    } catch (e) {
      // 只有"连不上"才降级；服务端明确返回的业务错误要照实抛
      if (!(e instanceof ApiError && e.isNetworkError)) throw e;
    }
  }
  return directSearch(q, page, limit);
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
/**
 * 歌词。
 *
 * 三条路，优先级从高到低：
 *   1. 服务端（它会做多源兜底）
 *   2. 直连 QQ 歌词（无凭据可用；服务端不在时这就是主路径）
 *   3. 本地快照（断网且没直连成功时，至少还剩上次那份）
 */
export async function fetchLyrics(id: string, signal?: AbortSignal): Promise<LyricResult> {
  if (serverReady()) {
    try {
      const res = await http.get<LyricResult>(`/api/lyrics/${encodeURIComponent(id)}`, { signal });
      // 落一份本地：离线时歌词不该是空白（用户报障"离线歌词也没了"）
      void saveOffline(`lyric:${id}`, res);
      return res;
    } catch (err) {
      // 业务错误照实抛；只有"连不上"才继续往下试直连
      if (!(err instanceof ApiError && err.isNetworkError)) {
        const cached = await loadOffline<LyricResult>(`lyric:${id}`);
        if (cached) return cached;
        throw err;
      }
    }
  }

  // 直连只认 QQ 曲目 id（`qq_<mid>`），其它来源没有直连歌词实现
  const mid = id.startsWith('qq_') ? id.slice(3) : '';
  if (mid) {
    try {
      const { lyric, trans } = await qqLyric(mid);
      if (lyric) {
        const res: LyricResult = { id, lrc: { lyric }, tlyric: { lyric: trans } };
        void saveOffline(`lyric:${id}`, res);
        return res;
      }
    } catch {
      /* 落到快照 */
    }
  }

  const cached = await loadOffline<LyricResult>(`lyric:${id}`);
  if (cached) return cached;
  throw new Error('歌词暂不可用');
}

/** 批量取曲目快照。只读本地缓存，不消耗上游配额 */
export function fetchTracksBatch(
  ids: string[],
  signal?: AbortSignal
): Promise<{ tracks: Track[]; missing: string[] }> {
  return http.post('/api/tracks/batch', { ids }, { signal });
}
