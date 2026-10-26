/**
 * QQ 音乐首页聚合、榜单、歌单详情、单曲详情。
 *
 * 首页一次请求聚合三块内容（新碟首发 / 新歌首发 / 巅峰榜）——
 * QQ 的 musicu.fcg 支持多 module 合并请求，一次往返拿全，比分三次快得多。
 *
 * **不再取"推荐歌单"**（`playlist.PlayListPlazaServer.get_playlist_by_tag`）：
 * 那份数据是按标签固定的，长期不变，首页上没有任何信息增量。
 *
 * **也不再取焦点图**（`music.musicHall.MusicHallPlatform/GetFocus`）：
 * 实测（2026-09-11）该接口回的是标题为「焦点图」的一组运营大图，
 * 与 Q 音首页真正那栏「精彩推荐」**对不上**；而 Q 音真正的首页数据走
 * 加密的 `u6.y.qq.com/cgi-bin/musics.fcg`，报文读不出来。
 * 拿不到就不摆 —— 首页顶部改由「新碟首发」担纲，见 `web/src/views/Home.vue`。
 */

import { createLogger } from '../../logger.ts';
import { COMM_DEFAULT, requestQQMusic } from './client.ts';
import {
  adaptQQTracks, adaptQQAlbum, adaptQQSong, adaptQQToplist, toPlainText,
} from './adapter.ts';
import type { Album, ToplistInfo, Track } from './adapter.ts';
import { getTracks, upsertTracks } from '../../db/repo/tracks.ts';

const log = createLogger('qq:home');

/** 首页要展示的官方核心榜单：飙升榜 / 热歌榜 / 新歌榜 / 流行指数榜 */
export const CORE_TOPLIST_IDS = [62, 26, 27, 4];

export interface HomeData {
  /** 新碟首发。首页顶部海报位 */
  newAlbums: Album[];
  /** 新歌首发 */
  newSongs: Track[];
  /** 巅峰榜（飙升 / 热歌 / 新歌 / 流行指数） */
  toplists: Array<ReturnType<typeof adaptQQToplist>>;
}

/** 新碟首发取多少张。顶部海报位是横向可滑的一排，12 张够铺满并留出滑动余量 */
const NEW_ALBUM_COUNT = 12;

export async function getHomeData(): Promise<HomeData> {
  const res = await requestQQMusic<any>(
    {
      newSongs: {
        module: 'newsong.NewSongServer',
        method: 'get_new_song_info',
        param: { type: 5 },
      },
      // 新碟首发。
      // 实测（2026-09-11）：参数必须是 `{ area, sin, num }` —— 页偏移量叫 **sin**
      // 而不是 page，多传或少传都会变成 10006（参数错误）。
      // 另外两条候选（`newalbum` 之外的 `QQMusic.MusichallServer/GetNewAlbum`、
      // `music.web_album_library/get_album_by_tags`）虽然也能通，但返回的是
      // 2017 / 2021 年的老数据，已废弃，不要用。
      newAlbum: {
        module: 'newalbum.NewAlbumServer',
        method: 'get_new_album_info',
        param: { area: 1, sin: 0, num: NEW_ALBUM_COUNT },
      },
      toplist: {
        module: 'musicToplist.ToplistInfoServer',
        method: 'GetAll',
        param: {},
      },
    },
    COMM_DEFAULT
  );

  // 先过滤再截断：先 slice(12) 再过滤会留下 11 首（伴奏占了名额）
  const newSongs = adaptQQTracks(res?.newSongs?.data?.songlist).slice(0, 12);

  const newAlbums = (res?.newAlbum?.data?.albums || [])
    .map((a: unknown) => adaptQQAlbum(a as never))
    .filter((x: Album | null): x is Album => x !== null && Boolean(x.mid));

  const toplists: Array<ReturnType<typeof adaptQQToplist>> = [];
  for (const group of res?.toplist?.data?.group || []) {
    for (const item of group?.toplist || []) {
      if (CORE_TOPLIST_IDS.includes(item?.topId)) {
        toplists.push(adaptQQToplist(item));
      }
    }
  }

  return { newAlbums, newSongs, toplists };
}

export interface ToplistDetail {
  /** 与首页榜单卡片同构；上游没给榜单数据时为 null */
  topInfo: ToplistInfo | null;
  tracks: Track[];
}

export async function getToplistDetail(
  topId: number,
  offset = 0,
  num = 100
): Promise<ToplistDetail> {
  const res = await requestQQMusic<any>(
    {
      toplist: {
        module: 'musicToplist.ToplistInfoServer',
        method: 'GetDetail',
        param: { topId, offset, num },
      },
    },
    COMM_DEFAULT
  );

  const data = res?.toplist?.data || {};
  const songList = data.songInfoList || [];
  const raw = data.data || {};

  // ⚠️ 这里**不能**把上游字段直接摊开返回。
  // 详情接口给的是 `title` / `frontPicUrl` / `updateTips`，而首页卡片经
  // adaptQQToplist 之后是 `name` / `picUrl` / `updateFrequency` —— 是两套名字。
  // 曾经直接摊开，客户端按 `topInfo.name`、`topInfo.picUrl` 取值全是 undefined，
  // 表现为「榜单页封面空白、标题退化成兜底文案」，而首页却一切正常
  // （首页走的是适配器，映射是对的）。两头收口到同一个适配器上。
  const topInfo = adaptQQToplist(raw, { withSongs: false });
  if (topInfo) {
    // 榜单简介带 <br>，客户端多为纯文本渲染，必须先转纯文本
    topInfo.intro = toPlainText(raw.intro);
    topInfo.updateFrequency = toPlainText(raw.updateTips) || topInfo.updateFrequency;
  }

  return {
    topInfo,
    tracks: adaptQQTracks(songList),
  };
}

export interface PlaylistDetail {
  playlist: {
    id: string;
    name: string;
    coverImgUrl: string;
    picUrl: string;
    description: string;
    playCount: number;
    trackCount: number;
    creator: { nickname: string; userId: number };
    /** 风格标签（流行/摇滚/民谣…）。作为"按风格找更多网友歌单"的关键词 */
    tags: string[];
  };
  tracks: Track[];
}

/** 歌单风格标签：上游可能是字符串数组、逗号串，或 { tagName } 对象数组，统一成字符串数组 */
function parsePlaylistTags(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    return raw
      .split(/[,，|/]/)
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  if (Array.isArray(raw)) {
    return raw
      .map(item => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          return String(o.tagName ?? o.name ?? o.title ?? '').trim();
        }
        return '';
      })
      .filter(Boolean)
      .slice(0, 8);
  }
  return [];
}

export async function getPlaylistDetail(
  tid: string | number
): Promise<PlaylistDetail | null> {
  const numericTid = Number(tid);
  if (!Number.isFinite(numericTid) || numericTid <= 0) return null;

  const res = await requestQQMusic<any>(
    {
      playlist: {
        module: 'music.srfDissInfo.aiDissInfo',
        method: 'uniform_get_Dissinfo',
        param: { disstid: numericTid, userinfo: 1, tag: 1 },
      },
    },
    COMM_DEFAULT
  );

  const data = res?.playlist?.data;
  if (!data) return null;

  const dirinfo = data.dirinfo || {};
  const songlist = data.songlist || [];
  const tracks = adaptQQTracks(songlist);

  if (!dirinfo.title && tracks.length === 0) return null;

  return {
    playlist: {
      id: `qq_pl_${tid}`,
      name: dirinfo.title || 'QQ 音乐歌单',
      coverImgUrl: dirinfo.picurl || '',
      picUrl: dirinfo.picurl || '',
      description: dirinfo.desc || '',
      playCount: dirinfo.listennum || 0,
      trackCount: tracks.length,
      creator: {
        nickname: dirinfo.nickname || 'QQ 音乐官方',
        userId: 0,
      },
      tags: parsePlaylistTags(dirinfo.tags),
    },
    tracks,
  };
}

/** 单曲真实元数据。曲目缓存 miss 时用它兜底。 */
/**
 * 单曲详情（**读穿缓存**）。
 *
 * 此前直接裸打上游：`routes/catalog.ts:314`、`favorites.ts:94`、`resolve.ts:130`、`stream.ts:379`、
 * `daily-recommend.ts:218` 五个调用点各自打一次，而 `tracks` 表里本来就存着这些曲目 —— 
 * 等于同一首歌的元数据被反复请求（并直接抬高 QQ 2001 的触发率）。
 *
 * 现在先查 `tracks`（`upsertTracks` 写入的那份），命中即返回；未命中才打上游并顺手落库。
 * 需要强制刷新时传 `{ bypassCache: true }`。QQ 侧元数据变动很少，默认信任缓存。
 */
export async function getSongDetail(
  mid: string,
  opts: { bypassCache?: boolean } = {}
): Promise<Track | null> {
  if (!mid) return null;

  if (!opts.bypassCache) {
    const cached = getTracks([`qq_${mid}`])[0];
    if (cached) return cached;
  }

  try {
    const res = await requestQQMusic<any>(
      {
        songinfo: {
          module: 'music.pf_song_detail_svr',
          method: 'get_song_detail_yqq',
          param: { song_mid: mid },
        },
      },
      COMM_DEFAULT
    );

    const trackInfo = res?.songinfo?.data?.track_info;
    if (!trackInfo) return null;
    const track = adaptQQSong(trackInfo);
    upsertTracks([track]);   // 顺手落库，下次直接命中
    return track;
  } catch (err) {
    log.warn(`单曲详情失败 mid=${mid}: ${(err as Error)?.message ?? err}`);
    return null;
  }
}
