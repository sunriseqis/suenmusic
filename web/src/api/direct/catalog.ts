/**
 * 直连目录：把上游返回的原始行转成应用内的 `Track`，并提供无服务端时的搜索。
 *
 * 这一层存在的理由：`upstream.ts` 只管"把请求发出去、把 JSON 拿回来"，
 * 而界面要的是 `Track`（带 `ar`/`al`/`dt` 这些字段）。转换集中在这里，
 * 免得每个调用点各写一遍、字段名还写得不一样。
 */

import type { SearchResult, Track, TrackAlbum, TrackArtist } from '@/api/types.ts';
import { qqSearch, type QqSong } from './upstream.ts';

const ALBUM_COVER = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000';

/** QQ 搜索结果 → 应用内的 Track。缺的字段给安全默认值，不编造 URL */
export function qqSongToTrack(song: QqSong): Track {
  const names = song.artist.split('/').map(s => s.trim()).filter(Boolean);
  const ar: TrackArtist[] = (names.length > 0 ? names : ['未知歌手']).map((name, i) => ({
    id: `qq_ar_${song.mid}_${i}`,
    mid: '',
    name,
    picUrl: '',
  }));

  const albumMid = song.albumMid ?? '';
  const picUrl = albumMid ? `${ALBUM_COVER}${albumMid}.jpg` : '';
  const al: TrackAlbum = {
    id: albumMid ? `qq_al_${albumMid}` : '',
    mid: albumMid,
    name: song.album,
    picUrl,
  };

  const durationSec = song.durationSec ?? 0;

  return {
    id: `qq_${song.mid}`,
    mid: song.mid,
    name: song.name,
    ar,
    artists: ar,
    al,
    album: { id: al.id, name: al.name, picUrl: al.picUrl },
    dt: durationSec * 1000,
    duration: durationSec,
    playable: true,
    // 直连没有"多源打分"这一步，`matched` 表示的是"服务端匹配过"，这里不适用
    matched: false,
    privilege: {
      playMaxbr: 0,
      maxbr: 0,
      freeTrialPrivilege: { resConsumable: false },
    },
  };
}

/**
 * 无服务端时的搜索。
 *
 * 只做单曲：QQ 搜索一次就能拿到歌名/歌手/专辑/时长，足够支撑"搜到 → 播放"。
 * 专辑/歌手/歌单分片需要各自的详情接口，等主流程稳定后再补
 * （它们现在返回空数组，界面不会因此报错，只是那三个 tab 没有结果）。
 */
export async function directSearch(
  q: string,
  page = 1,
  limit = 30
): Promise<SearchResult> {
  const songs = await qqSearch(q, limit, page);
  return {
    query: q,
    type: 'song',
    page,
    limit,
    songs: songs.map(qqSongToTrack).filter(t => t.mid.length > 0),
    albums: [],
    artists: [],
    playlists: [],
    mvs: [],
    hasMore: {
      song: songs.length >= limit,
      album: false,
      artist: false,
      playlist: false,
    },
    degraded: null,
  };
}
