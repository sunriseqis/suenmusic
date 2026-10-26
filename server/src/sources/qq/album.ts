/**
 * QQ 音乐专辑详情。
 *
 * 两个接口拼装：`GetAlbumDetail` 给元信息，`GetAlbumSongList` 给曲目。
 * 注意 `GetAlbumDetail` 的 basicInfo **不含歌手字段**，歌手取自同响应的
 * `data.singer.singerList`，曲目 `ar` 仅作兜底 —— 否则**版权受限的专辑**
 * （曲目为 0）会渲染成 "by "（歌手空白）。
 *
 * 曲目为空时还要再打一次**老接口**去问原因，见 `fetchAlbumEmptyReason`。
 */

import { createLogger } from '../../logger.ts';
import { cacheGet, cachePut } from '../../services/upstream-cache.ts';
import { BROWSER_UA, QQ_REFERER } from '../../utils/constants.ts';
import { requestJson } from '../../utils/http.ts';
import { COMM_DEFAULT, requestQQMusic } from './client.ts';
import {
  adaptQQAlbum,
  adaptQQTracks,
  adaptQQSong,
  adaptQQTrackArtist,
  toPlainText,
} from './adapter.ts';
import type { Album, Track, TrackArtist } from './adapter.ts';

const log = createLogger('qq:album');

/** 专辑详情缓存有效期：6 小时。曲目列表相对稳定，但新专辑可能很快补曲目 */
const ALBUM_DETAIL_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 老版专辑接口。**它的 `code` 恒为 404，但 `data` 是完整的** ——
 * 按 `code` 判成败会把好好的数据丢掉（实测踩过）。
 */
const LEGACY_ALBUM_INFO = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg';

/**
 * 曲目为空时，去问上游「为什么」。
 *
 * 新版 `GetAlbumSongList` 对"元信息还在、曲目不可用"的专辑（实测是**版权限制下架**）
 * 只回一个 `totalNum: 0`，**一个字原因都不给**，客户端只能瞎猜
 * （曾因此在专辑页上显示"这首歌单已下架"这种明显不对的文案）。
 * 老接口的 `albumTips` 里写着官方原话：
 *   实测「抱歉，因版权限制\n暂无法查看该专辑下歌曲」
 *
 * 只在曲目为空时才调用（罕见路径），任何失败都返回 null，绝不影响主流程。
 */
async function fetchAlbumEmptyReason(albumMid: string): Promise<string | null> {
  try {
    const url =
      `${LEGACY_ALBUM_INFO}?albummid=${encodeURIComponent(albumMid)}` +
      '&g_tk=5381&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=1';

    const res = await requestJson<any>(url, {
      method: 'GET',
      headers: { Referer: QQ_REFERER, 'User-Agent': BROWSER_UA },
      timeoutMs: 8000,
    });

    // 注意取的是 data 而不是判 code —— 该接口 code 恒为 404
    return toPlainText(res?.data?.albumTips) || null;
  } catch (err) {
    log.warn(`取专辑空曲目原因失败 albumMid=${albumMid}: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

export interface AlbumDetail {
  album: Album;
  songs: Track[];
  /**
   * 曲目为空时上游给出的原因（实测形如「抱歉，因版权限制暂无法查看该专辑下歌曲」）。
   * 曲目正常时为 null。**客户端应优先展示它**，不要自己猜"可能需要会员"。
   */
  notice: string | null;
}

export async function getAlbumDetail(
  albumMid: string,
  limit = 100
): Promise<AlbumDetail | null> {
  if (!albumMid) return null;

  // 先查表：命中直接返回，不打上游（limit 参与 key，不同 limit 是不同的结果）
  const cacheKey = `${albumMid}:${limit}`;
  const cached = cacheGet<AlbumDetail>('album_detail', cacheKey, ALBUM_DETAIL_TTL_MS);
  if (cached) return cached;

  try {
    const res = await requestQQMusic<any>(
      {
        detail: {
          module: 'music.musichallAlbum.AlbumInfoServer',
          method: 'GetAlbumDetail',
          param: { albumMid },
        },
        songs: {
          module: 'music.musichallAlbum.AlbumSongList',
          method: 'GetAlbumSongList',
          param: { albumMid, begin: 0, num: limit, order: 2 },
        },
      },
      COMM_DEFAULT
    );

    const basicInfo = res?.detail?.data?.basicInfo || res?.detail?.data?.basic_info;
    const songList = res?.songs?.data?.songList || [];

    /*
     * ⚠️ `GetAlbumSongList` 的每一项是 `{ songInfo: {...}, listenCount, ... }`，
     * 曲目真正的 `name` / `title` / `mid` 都在 **`songInfo` 里面**。
     * 曾经直接对外层做过滤与去重，读到的是外层的 `undefined` ——
     * 伴奏判不出来、按 mid 去重也全部落空，于是周深《大梦归》显示成
     * 两行一模一样的"大梦归"（用户实测）。解包 + 过滤 + 去重统一在
     * `adaptQQTracks` 里一次做完，别在调用点各做各的。
     */
    const songs = adaptQQTracks(songList);

    // 上游对**不存在的专辑**返回 `code=104400` 加一个字段全空的 basicInfo
    // （albumMid / albumName 一律为空串），HTTP 仍是 200。
    // 只判 "basicInfo 存不存在" 会把这个空壳当成真专辑，于是 404 变成 200，
    // 客户端会打开一个标题空白、歌手空白的幽灵专辑页。
    const detailCode = Number(res?.detail?.code);
    const basicMid = String(basicInfo?.albumMid ?? '').trim();
    const upstreamSaysMissing = Number.isFinite(detailCode) && detailCode !== 0;
    if (songs.length === 0 && (basicMid === '' || upstreamSaysMissing)) return null;

    // 详情接口的 basicInfo **没有歌手字段**，歌手只在两处：
    //   1. `data.singer.singerList` —— 专辑歌手，**曲目为空时也仍然有值**
    //   2. `songs[0].ar` —— 兜底（老响应缺 singer 节点时）
    // 只用第 2 处会在"版权受限专辑"上翻车：曲目为 0 → 歌手跟着空白 →
    // 专辑页标题下面挂一个空的 "by "（用户实测报过）。
    const detailArtists: TrackArtist[] = (res?.detail?.data?.singer?.singerList || [])
      .map((s: unknown) => adaptQQTrackArtist(s as never))
      .filter((a: TrackArtist) => Boolean(a.name || a.mid));

    const album = adaptQQAlbum(basicInfo || {}, {
      size: res?.songs?.data?.totalNum || songs.length,
      artists: detailArtists.length > 0 ? detailArtists : songs[0]?.ar || [],
    });

    if (!album) return null;

    // 元信息齐全、曲目却是 0：这不是"专辑不存在"，而是"曲目不可用"。
    // 去把上游的原因取回来，让客户端能给出准确的说明。
    let notice: string | null = null;
    if (songs.length === 0) {
      notice = (await fetchAlbumEmptyReason(albumMid)) ?? '该专辑暂无可播放曲目';
    }

    const detail: AlbumDetail = { album, songs, notice };
    // 只缓存拿到完整元信息的结果：前面两条 `return null` 是"专辑不存在"，
    // 落表会把一次上游异常固化 6 小时（见 upstream-cache.ts 设计第 2 条）
    cachePut('album_detail', cacheKey, detail);
    return detail;
  } catch (err) {
    log.warn(`专辑详情失败 albumMid=${albumMid}: ${(err as Error)?.message ?? err}`);
    return null;
  }
}
