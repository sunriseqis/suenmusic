/**
 * QQ 音乐搜索。
 *
 * 关键事实（2026-09 实测，改代码前必读）：
 *
 * musicu.fcg 的 DoSearchForQQMusicDesktop **不是**"一次返回全部分片"，
 * 它由 `search_type` 决定本次返回哪个分片，其余分片恒为空数组：
 *
 * | search_type | 返回分片      |
 * | ----------- | ------------- |
 * | 0           | song 单曲     |
 * | 1           | singer 歌手   |
 * | 2           | album 专辑    |
 * | 3           | songlist 歌单 |
 * | 4           | mv MV         |
 *
 * 因此多分片搜索必须并发多次请求；单分片只发一次。
 * 另外 comm 必须用 COMM_SEARCH（ct:19 / cv:1859），否则 song 分片为空。
 *
 * 搬运自桌面端 src/api/qq/search.js 的改动：不再派发 Toast。
 * 风控（code 2001）这类信息改为通过返回值上报，由 HTTP 层决定怎么呈现 ——
 * 安卓端和网页端的提示方式是两套，服务端不该替客户端做决定。
 */

import { createLogger } from '../../logger.ts';
import { Cooldown } from '../../utils/backoff.ts';
import { COMM_SEARCH, requestQQMusic } from './client.ts';
import {
  adaptQQTracks,
  adaptQQAlbum,
  adaptQQArtist,
  adaptQQPlaylist,
  adaptQQSong,
} from './adapter.ts';
import type { Album, Artist, Playlist, QQRecord, Track } from './adapter.ts';

const log = createLogger('qq:search');

/**
 * QQ 搜索风控冷却。
 *
 * QQ 的 2001 是**瞬时限流**（实测暂停约 1 分钟自行恢复），不是代码问题。
 * 命中后进入冷却窗口，窗口内直接返回"限流中"而不打上游 —— 越打窗口越长。
 */
export const qqCooldown = new Cooldown('qq', {
  baseMs: 60_000,
  maxMs: 10 * 60_000,
});

export type QQSearchSlice = 'song' | 'singer' | 'album' | 'songlist' | 'mv';

/** 逻辑分片名 → musicu search_type */
export const QQ_SEARCH_TYPE: Record<QQSearchSlice, number> = {
  song: 0,
  singer: 1,
  album: 2,
  songlist: 3,
  mv: 4,
};

/** 综合搜索默认拉取的分片（MV 播放链路未接入） */
export const QQ_SEARCH_ALL_SLICES: QQSearchSlice[] = [
  'song',
  'singer',
  'album',
  'songlist',
];

/** QQ 风控 / 限流的业务错误码 */
export const QQ_RISK_CONTROL_CODE = 2001;

export interface QQSearchOptions {
  offset?: number;
  limit?: number;
  slices?: QQSearchSlice[];
}

export interface QQSearchResult {
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  mvs: QQRecord[];
  /**
   * 本次哪些分片没有拿到数据，以及上游业务码。
   * code 为 2001 表示命中限流（实测暂停约 1 分钟自行恢复）。
   */
  degraded: {
    slices: string[];
    code: number | null;
    /** 面向用户的说明文案，客户端可直接展示 */
    message?: string;
    /** 建议的重试等待时间（毫秒） */
    retryAfterMs?: number;
  };
}

export interface SliceOutcome {
  slice: QQSearchSlice;
  list: QQRecord[];
  code: number | null;
}

/**
 * 请求单个分片，返回原始列表与业务码。
 *
 * 导出给 `album/artist/home` 复用：歌手页拿统计数字、歌手热门歌曲都靠它，
 * 各写一遍会把"COMM_SEARCH 参数 + 分片名"这套知识散到多处。
 *
 * 失败降级为空数组，绝不阻塞调用方。
 */
export async function fetchSearchSlice(
  slice: QQSearchSlice,
  keywords: string,
  offset = 0,
  limit = 20
): Promise<SliceOutcome> {
  const searchType = QQ_SEARCH_TYPE[slice];
  const pageNum = Math.floor(offset / limit) + 1;

  const res = await requestQQMusic<any>(
    {
      search: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: {
          query: keywords,
          num_per_page: limit,
          page_num: pageNum,
          search_type: searchType,
        },
      },
    },
    COMM_SEARCH
  );

  const code: number | null = res?.search?.code ?? null;
  if (code !== null && code !== 0) {
    log.warn(`分片 "${slice}" 业务码非 0: code=${code}`);
    if (code === QQ_RISK_CONTROL_CODE) {
      const coolMs = qqCooldown.trip('搜索限流 2001');
      log.warn(
        `QQ 搜索命中限流(2001)，进入冷却 ${Math.round(coolMs / 1000)}s（实测约 1 分钟自恢复）`
      );
    }
    return { slice, list: [], code };
  }

  return { slice, list: res?.search?.data?.body?.[slice]?.list || [], code };
}

/**
 * QQ 音乐搜索。
 *
 * @param keywords 搜索关键字
 * @param options  offset / limit / slices
 */
export async function searchQQ(
  keywords: string,
  options: QQSearchOptions = {}
): Promise<QQSearchResult> {
  const { offset = 0, limit = 30, slices = ['song'] } = options;

  const empty: QQSearchResult = {
    songs: [],
    albums: [],
    artists: [],
    playlists: [],
    mvs: [],
    degraded: { slices: [], code: null },
  };

  if (!keywords) return empty;

  const wanted = slices.filter(s => QQ_SEARCH_TYPE[s] !== undefined);
  if (!wanted.length) return empty;

  // 冷却窗口内直接返回，不打上游。code 沿用 2001 让客户端能识别。
  if (qqCooldown.active()) {
    const snap = qqCooldown.snapshot();
    log.warn(`QQ 处于冷却窗口（剩余 ${Math.round(snap.remainingMs / 1000)}s），跳过搜索`);
    return {
      ...empty,
      degraded: {
        slices: [...wanted],
        code: QQ_RISK_CONTROL_CODE,
        message: `QQ 音乐搜索被限流，请在 ${Math.ceil(snap.remainingMs / 1000)} 秒后重试`,
        retryAfterMs: snap.remainingMs,
      },
    };
  }

  const settled = await Promise.all(
    wanted.map(async (slice): Promise<SliceOutcome> => {
      try {
        return await fetchSearchSlice(slice, keywords, offset, limit);
      } catch (err) {
        log.warn(`分片 "${slice}" 请求失败: ${(err as Error)?.message ?? err}`);
        return { slice, list: [], code: null };
      }
    })
  );

  const out: QQSearchResult = { ...empty, degraded: { slices: [], code: null } };

  for (const { slice, list, code } of settled) {
    if (code !== null && code !== 0) {
      out.degraded.slices.push(slice);
      out.degraded.code = code;
    }
    if (!list.length) continue;

    switch (slice) {
      case 'song':
        out.songs = adaptQQTracks(list);
        break;
      case 'singer':
        out.artists = list
          .map(adaptQQArtist)
          .filter((x): x is Artist => x !== null);
        break;
      case 'album':
        out.albums = list
          .map(item => adaptQQAlbum(item))
          .filter((x): x is Album => x !== null);
        break;
      case 'songlist':
        out.playlists = list
          .map(adaptQQPlaylist)
          .filter((x): x is Playlist => x !== null);
        break;
      case 'mv':
        // MV 播放链路未接入，原始结构直接透出，由调用方裁剪
        out.mvs = list;
        break;
    }
  }

  // 全部请求的分片都成功才清零冷却。
  // 若有分片仍在限流，这里不能重置 —— 否则 4 个分片里 3 个成功就会立刻把
  // 刚触发的冷却清掉，退避形同虚设。
  if (out.degraded.slices.length === 0) {
    qqCooldown.reset();
  } else if (out.degraded.code === QQ_RISK_CONTROL_CODE) {
    out.degraded.message = 'QQ 音乐搜索被限流，请稍后重试';
    out.degraded.retryAfterMs = qqCooldown.remainingMs();
  }

  return out;
}
