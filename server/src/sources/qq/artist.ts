/**
 * QQ 音乐歌手详情与热门歌曲。
 *
 * 两个已实测的坑，改代码前必读：
 *
 * 1. `GetSingerDetail` 的 basic_info **不含** songNum / albumNum / mvNum，
 *    只靠它歌手页会显示"0 张专辑 · 0 个 MV"。统计数字只存在于
 *    搜索的 singer 分片里，所以补一次检索按 mid 精确匹配。
 * 2. `GetSingerSongList` 已下线（返回 code 40000），拿歌手歌曲只能
 *    改用搜索接口按歌手名召回，再按歌手 mid 过滤。
 * 3. **歌手专辑同样没有专用接口**（2026-09-11 实测）：`GetSingerAlbum` /
 *    `GetSingerAlbumList` / `GetAlbumList` 全返回 40000，
 *    `SingerAlbumInter` 等模块 500003。只能走搜索 album 分片 ——
 *    好在这个分片**返回 `singerMID` 与 `singer_list[].mid`**，能精确过滤。
 */

import { createLogger } from '../../logger.ts';
import { cacheGet, cachePut } from '../../services/upstream-cache.ts';
import { COMM_DEFAULT, requestQQMusic } from './client.ts';
import {
  adaptQQAlbum,
  adaptQQArtist,
  adaptQQSong,
  dedupeRawByMid,
  withoutAccompaniment,
} from './adapter.ts';
import { fetchSearchSlice } from './search.ts';
import type { Album, Artist, Track } from './adapter.ts';

const log = createLogger('qq:artist');

/** 歌手详情缓存有效期：7 天。歌手档案（名字/头像/统计）几乎不变 */
const ARTIST_DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 歌手歌曲/专辑缓存有效期：24 小时。搜索分片会随新歌新专辑变化，不宜太久 */
const ARTIST_LIST_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 取歌手统计数字（专辑数 / MV 数）。
 * 失败不影响主流程 —— 宁可显示 0 也不要整个歌手页打不开。
 */
async function fetchSingerStats(
  singerMid: string,
  singerName: string
): Promise<{ albumNum?: number; mvNum?: number } | null> {
  if (!singerName) return null;

  try {
    const { list, code } = await fetchSearchSlice('singer', singerName, 0, 20);
    if (code !== null && code !== 0) return null;

    const hit =
      list.find(item => item?.singerMID === singerMid) ||
      list.find(item => item?.singerName === singerName);

    if (!hit) return null;
    return { albumNum: hit.albumNum, mvNum: hit.mvNum };
  } catch (err) {
    log.debug(`歌手统计补取失败 ${singerName}: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

export async function getArtistDetail(singerMid: string): Promise<Artist | null> {
  if (!singerMid) return null;

  // 先查表：歌手页是高频入口，重启后靠这一层避免重复打上游
  const cached = cacheGet<Artist>('artist_detail', singerMid, ARTIST_DETAIL_TTL_MS);
  if (cached) return cached;

  try {
    const res = await requestQQMusic<any>(
      {
        singer: {
          module: 'music.musichallSinger.SingerInfoInter',
          method: 'GetSingerDetail',
          param: {
            singer_mids: [singerMid],
            pic: 1,
            group_singer: 1,
            wiki_singer: 1,
          },
        },
      },
      COMM_DEFAULT
    );

    const list = res?.singer?.data?.singer_list || [];
    const artist = adaptQQArtist(list[0]);
    if (!artist) return null;

    const stats = await fetchSingerStats(singerMid, artist.name);
    if (stats) {
      if (typeof stats.albumNum === 'number') artist.albumSize = stats.albumNum;
      if (typeof stats.mvNum === 'number') artist.mvSize = stats.mvNum;
    }

    // 落表放在补统计之后：否则缓存里存的是 albumSize/mvSize 缺失的版本
    cachePut('artist_detail', singerMid, artist);
    return artist;
  } catch (err) {
    log.warn(`歌手详情失败 singerMid=${singerMid}: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

export interface ArtistSongsResult {
  songs: Track[];
  /**
   * 上游这一页是否被填满。
   *
   * ⚠️ **不能用"过滤后还剩几条"来判还有没有更多** ——
   * 我们按歌手 mid 过滤过，一页 50 条里可能大半是别人的歌，
   * 过滤完只剩 8 条，但上游明明还有下一页。用过滤后的条数判断，
   * 会在"这一页恰好过滤得多"时过早显示"没有更多了"。
   */
  hasMore: boolean;
  /**
   * 非 0 的业务码（2001 = QQ 风控限流）。
   *
   * 有这个字段，调用方才能区分「这位歌手真没有歌」与「上游被限流了」——
   * 两者都返回空列表，但一个是正常结果、一个是需要稍后重试的外部故障。
   */
  degradedCode?: number;
}

/**
 * 歌手热门歌曲。
 *
 * 搜索按名字召回会混入其他歌手的同名/翻唱作品，因此优先只保留
 * 曲目 `ar` 里确实包含该歌手 mid 的条目；全被过滤光时退回原始结果
 * （宁可多给几首，也不要给出空列表）。
 */
/** 歌手名归一：去空白/括号/异体字，用于「无 mid 行」的名字兜底判定 */
function normArtist(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()（）[\]【】]/g, '')
    .replace(/企画/g, '企划');
}

export async function getArtistSongs(
  singerMid: string,
  singerName: string,
  limit = 50,
  page = 1
): Promise<ArtistSongsResult> {
  if (!singerName) return { songs: [], hasMore: false };

  // key 带上 singerName：召回本身就是按名字搜索的，同一 mid 换了名字结果会变
  const cacheKey = `${singerMid}:${singerName}:${limit}:${page}`;
  const cached = cacheGet<ArtistSongsResult>('artist_songs', cacheKey, ARTIST_LIST_TTL_MS);
  if (cached) return cached;

  try {
    const { list, code } = await fetchSearchSlice('song', singerName, (page - 1) * limit, limit);
    if (code !== null && code !== 0) {
      // 不要把限流当成"没有歌"静默吞掉，否则排查时完全摸不着头脑
      return { songs: [], hasMore: false, degradedCode: code };
    }

    // 伴奏版是原曲的附赠重复项：留着会与原曲显示成同一个名字（见适配器注释）。
    // 搜索接口**不**过滤 —— 用户可能就是冲着伴奏来搜的。
    /**
     * 短视频「原声」条目不是歌：名字形如「@某某创作的原声一某某」，没有专辑也没有封面。
     * 歌手页里把它们当曲目列出来只会制造空白行（用户 2026-10-26 报的就是这类）。
     */
    const isOriginalSoundClip = (name: string) =>
      /创作的原声|原声[一-]|\.?原声$/.test(name) || /^[@#]/.test(name.trim());

    const songs = dedupeRawByMid(withoutAccompaniment(list))
      .filter(raw => !isOriginalSoundClip(String((raw as Record<string, unknown>)?.title ?? (raw as Record<string, unknown>)?.name ?? '')))
      .map(adaptQQSong)
      .filter((x): x is Track => x !== null);

    const hasMore = list.length >= limit;
    if (!singerMid) return { songs, hasMore };

    /**
     * 归属判定：先看歌手 mid，**没有 mid 的召回行必须回落名字比对**。
     *
     * 旧实现是「没有 mid 就放行」，于是搜索里的野鸡条目整批混进歌手页 ——
     * 实测「夏日入侵企划」页混入 3 条：
     *   · 夏日入～侵企画-极恶～都市 / 超凡先锋馒头
     *   · 730. 夏日入侵企畫(沒有名字的夜晚…) / 香水百合
     *   · 夏日入侵企画的救赎（版本1） / 叮当
     * 它们的歌手名与目标歌手完全不符，因此名字兜底能干净地挡掉。
     */
    const target = normArtist(singerName);
    const owned = songs.filter(song => {
      const artists = song.ar || [];
      const mids = artists.map(a => a.mid).filter(Boolean);
      if (mids.length > 0 && mids.includes(singerMid)) return true;
      const byName = artists.some(a => {
        const n = normArtist(a.name);
        return n.length > 0 && (n.includes(target) || target.includes(n));
      });
      // 有 mid 但既不含目标 mid、名字也对不上 → 明确不是这位歌手
      if (mids.length > 0) return byName;
      return byName;
    });

    // 不能「owned 为空就退回全部」：那等于把过滤关掉，野鸡条目会整批回到歌手页。
    // 真空就回空列表 —— 客户端会显示「暂无」，比混入翻唱干净。
    const result: ArtistSongsResult = { songs: owned, hasMore };
    cachePut('artist_songs', cacheKey, result);
    return result;
  } catch (err) {
    log.warn(`歌手歌曲失败 singerMid=${singerMid}: ${(err as Error)?.message ?? err}`);
    return { songs: [], hasMore: false };
  }
}

export interface ArtistAlbumsResult {
  albums: Album[];
  /** 上游这一页是否被填满。判据同 `ArtistSongsResult.hasMore` */
  hasMore: boolean;
  /** 非 0 的业务码（2001 = QQ 风控限流）。语义同 `ArtistSongsResult` */
  degradedCode?: number;
}

/**
 * 歌手专辑列表。
 *
 * 过滤策略与 `getArtistSongs` 一致：搜索按名字召回会混入同名/翻唱专辑，
 * 所以优先只留 `artists` 里确实含该歌手 mid 的条目，
 * **全被过滤光时退回原始结果** —— 宁可多给几张，也不要给出空列表。
 *
 * 另外做一次按 mid 去重：搜索会把同一张专辑按不同版本召回多次。
 */
export async function getArtistAlbums(
  singerMid: string,
  singerName: string,
  limit = 50,
  page = 1
): Promise<ArtistAlbumsResult> {
  if (!singerName) return { albums: [], hasMore: false };

  // key 同 getArtistSongs：名字是搜索的输入之一
  const cacheKey = `${singerMid}:${singerName}:${limit}:${page}`;
  const cached = cacheGet<ArtistAlbumsResult>('artist_albums', cacheKey, ARTIST_LIST_TTL_MS);
  if (cached) return cached;

  try {
    const { list, code } = await fetchSearchSlice('album', singerName, (page - 1) * limit, limit);
    if (code !== null && code !== 0) {
      return { albums: [], hasMore: false, degradedCode: code };
    }

    // 不能写 `.map(adaptQQAlbum)`：第二个参数是 extra 对象，
    // map 会把下标当 extra 传进去，类型上过不去、语义上也错。
    const albums = list
      .map(item => adaptQQAlbum(item))
      .filter((x): x is Album => x !== null && Boolean(x.mid));

    const hasMore = list.length >= limit;
    if (!singerMid) return { albums, hasMore };

    const owned = albums.filter(album => {
      const mids = (album.artists || []).map(a => a?.mid).filter(Boolean);
      if (mids.length === 0) return true;
      return mids.includes(singerMid);
    });

    const seen = new Set<string>();
    const picked: Album[] = [];
    for (const a of owned.length ? owned : albums) {
      if (seen.has(a.mid)) continue;
      seen.add(a.mid);
      picked.push(a);
    }

    const result: ArtistAlbumsResult = { albums: picked, hasMore };
    cachePut('artist_albums', cacheKey, result);
    return result;
  } catch (err) {
    log.warn(`歌手专辑失败 singerMid=${singerMid}: ${(err as Error)?.message ?? err}`);
    return { albums: [], hasMore: false };
  }
}
