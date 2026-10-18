/**
 * 首页与详情（直连模式）：新碟首发 / 新歌首发 / 巅峰榜 / 榜单详情 / 专辑详情。
 *
 * 服务端把这三块聚合在 `sources/qq/home.ts` 里，一次 `musicu.fcg` 多 module
 * 请求拿全。客户端照搬同一组 module 与参数 —— 这些参数是踩出来的，
 * 尤其是新碟的 `sin`（不是 `page`），多传少传都会变成 10006。
 */
import type { Album, HomeData, Toplist, Track, TrackArtist } from '@/api/types.ts';
import { qqSongToTrack } from './catalog.ts';
import { httpJson, type QqSong } from './upstream.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://y.qq.com/',
  'Content-Type': 'application/json',
};

const ALBUM_COVER = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000';

/** 首页要展示的官方核心榜单：飙升 / 热歌 / 新歌 / 流行指数 */
const CORE_TOPLIST_IDS = [62, 26, 27, 4];

type Rec = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function https(url: string): string {
  return url.replace(/^http:/, 'https:');
}

export async function qqPost(payload: Rec): Promise<Rec> {
  const r = await httpJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: HEADERS,
    data: { comm: { ct: 19, cv: 1859 }, ...payload },
  });
  if (r.status !== 200) throw new Error(`QQ HTTP ${r.status}`);
  return (r.json as Rec) ?? {};
}

export function trackFromRaw(raw: unknown): Track | null {
  const s = (raw ?? {}) as Rec & {
    songInfo?: Rec;
    singer?: Array<{ name?: string }>;
    album?: { mid?: string; name?: string };
  };
  // 专辑详情的每一项是 `{ songInfo: {...} }`，曲目字段都在里面
  const o = (s.songInfo ?? s) as Rec & {
    singer?: Array<{ name?: string }>;
    album?: { mid?: string; name?: string };
  };
  const singers = Array.isArray(o.singer) ? o.singer : [];
  const q: QqSong = {
    mid: str(o.mid) || str(o.songmid),
    name: str(o.name) || str(o.title),
    artist: singers.map(x => str(x.name)).filter(Boolean).join('/') || '未知歌手',
    album: str(o.album?.name) || str(o.albumname),
    albumMid: str(o.album?.mid) || str(o.albummid),
    durationSec: Number(o.interval ?? 0) || 0,
  };
  return q.mid ? qqSongToTrack(q) : null;
}

function albumFromRaw(raw: unknown): Album | null {
  const a = (raw ?? {}) as Rec & {
    basicInfo?: Rec;
    singers?: Array<{ name?: string }>;
    singer?: Array<{ name?: string }>;
  };
  const b = (a.basicInfo ?? a) as Rec;
  const mid = str(b.albumMid) || str(b.mid);
  if (!mid) return null;
  const rawSingers = (a.singers ?? a.singer ?? []) as Array<{ name?: string }>;
  const artists: TrackArtist[] = rawSingers.map((s, i) => ({
    id: `qq_ar_${mid}_${i}`,
    mid: '',
    name: str(s.name),
    picUrl: '',
  }));
  return {
    id: `qq_al_${mid}`,
    mid,
    name: str(b.albumName) || str(b.name),
    picUrl: `${ALBUM_COVER}${mid}.jpg`,
    publishTime: str(b.publishDate) || str(b.release_time) || str(b.publicTime),
    description: str(b.desc),
    company: str(b.company),
    type: '',
    size: Number(b.songNum ?? 0) || 0,
    artists,
    artist: artists[0] ?? { name: '' },
  };
}

function toplistFromRaw(raw: unknown): Toplist | null {
  const t = (raw ?? {}) as Rec;
  const topId = Number(t.topId ?? 0);
  if (!topId) return null;
  const cover = https(str(t.frontPicUrl) || str(t.headPicUrl));
  return {
    id: `qq_top_${topId}`,
    topId,
    name: str(t.title) || '排行榜',
    picUrl: cover,
    coverImgUrl: cover,
    updateFrequency: str(t.updateTips) || '每日更新',
    playCount: Number(t.listenNum ?? 0) || 0,
    type: 'toplist',
    songList: [],
  };
}

/** 首页三块内容，与服务端同一组 module，一次往返 */
export async function directHome(): Promise<HomeData> {
  const res = await qqPost({
    newSongs: {
      module: 'newsong.NewSongServer',
      method: 'get_new_song_info',
      param: { type: 5 },
    },
    newAlbum: {
      module: 'newalbum.NewAlbumServer',
      method: 'get_new_album_info',
      param: { area: 1, sin: 0, num: 12 },
    },
    toplist: { module: 'musicToplist.ToplistInfoServer', method: 'GetAll', param: {} },
  });

  const songMod = res.newSongs as { data?: { songlist?: unknown[] } } | undefined;
  const albumMod = res.newAlbum as { data?: { albums?: unknown[] } } | undefined;
  const topMod = res.toplist as
    | { data?: { group?: Array<{ toplist?: unknown[] }> } }
    | undefined;

  const newSongs = (songMod?.data?.songlist ?? [])
    .map(trackFromRaw)
    .filter((t): t is Track => !!t)
    .slice(0, 12);

  const newAlbums = (albumMod?.data?.albums ?? [])
    .map(albumFromRaw)
    .filter((a): a is Album => !!a);

  const toplists: Toplist[] = [];
  for (const g of topMod?.data?.group ?? []) {
    for (const item of g?.toplist ?? []) {
      const t = toplistFromRaw(item);
      if (t && CORE_TOPLIST_IDS.includes(t.topId)) toplists.push(t);
    }
  }

  return { newAlbums, newSongs, toplists };
}

/** 榜单详情。id 形如 `qq_top_62` */
export async function directToplist(id: string): Promise<{
  topInfo: Toplist | null;
  tracks: Track[];
}> {
  const topId = Number(id.replace(/^qq_top_/, '')) || 0;
  const res = await qqPost({
    toplist: {
      module: 'musicToplist.ToplistInfoServer',
      method: 'GetDetail',
      param: { topId, offset: 0, num: 100 },
    },
  });
  const mod = res.toplist as
    | { data?: { data?: unknown; songInfoList?: unknown[] } }
    | undefined;
  const data = mod?.data;
  return {
    topInfo: toplistFromRaw(data?.data),
    tracks: (data?.songInfoList ?? [])
      .map(trackFromRaw)
      .filter((t): t is Track => !!t),
  };
}

/** 专辑详情。id 形如 `qq_al_<mid>` */
export async function directAlbum(id: string): Promise<{
  album: Album;
  songs: Track[];
  notice: string | null;
}> {
  const albumMid = id.replace(/^qq_al_/, '');
  const res = await qqPost({
    detail: {
      module: 'music.musichallAlbum.AlbumInfoServer',
      method: 'GetAlbumDetail',
      param: { albumMid },
    },
    songs: {
      module: 'music.musichallAlbum.AlbumSongList',
      method: 'GetAlbumSongList',
      param: { albumMid, begin: 0, num: 100, order: 2 },
    },
  });
  const detail = res.detail as { data?: Rec } | undefined;
  const songsMod = res.songs as { data?: { songList?: unknown[] } } | undefined;
  const album = albumFromRaw(detail?.data ?? {});
  if (!album) throw new Error('专辑不存在');
  return {
    album,
    songs: (songsMod?.data?.songList ?? [])
      .map(trackFromRaw)
      .filter((t): t is Track => !!t),
    notice: null,
  };
}
