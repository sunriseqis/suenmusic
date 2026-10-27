/**
 * 歌手曲目多源拉取（Step 5 建库用）。
 *
 * 顺序（用户 2026-10-26 定稿）：酷狗为主 → 网易云为辅 → QQ 兜底。
 *
 * 为什么不直接复用 multi-search：搜索聚合一次要打三个源，建库是批量任务，
 * 必须按「够用就停」逐级回退，否则一次建库会把三个上游全打一遍。
 */

import { createLogger } from '../logger.ts';
import { kugouSearchSongs, kugouTrackToTrack } from '../sources/kugou/source.ts';
import { netease, neteaseRequest } from '../sources/netease/vendor.ts';
import { currentNeteaseCookie } from './netease-account.ts';
import { getArtistSongs } from '../sources/qq/artist.ts';
import type { Track } from '../sources/qq/adapter.ts';

const log = createLogger('artist-songs-multi');

/** 认为「够了」的条数：达到就停，不再往下一个源要 */
const ENOUGH = 8;
/** 变种/翻唱清洗（与 multi-search 同口径） */
const VARIANT_RE = /(伴奏|纯音乐|钢琴|吉他|器乐|dj|慢摇|变速|remix|片段|消音|和声|翻唱|cover)/i;

function norm(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()（）[\]【】]/g, '')
    .replace(/企画/g, '企划');
}

export interface ArtistSongsMultiResult {
  songs: Track[];
  source: 'kugou' | 'netease' | 'qq' | 'none';
  /** 本次消耗的上游请求数（建库配额核算用） */
  requests: number;
  /** 各源命中数，便于 dry-run 观察 */
  detail: { kugou: number; netease: number; qq: number };
}

/** 酷狗：按歌手名搜索并过滤「属于该歌手 + 官方原唱」 */
async function fromKugou(name: string, limit: number): Promise<Track[]> {
  const rows = await kugouSearchSongs(name, 30);
  const target = norm(name);
  const picked = rows.filter(r => {
    if (VARIANT_RE.test(r.name)) return false;
    if (!r.isOriginal) return false;
    return r.singers.some(s => {
      const n = norm(s.name);
      return n.length > 0 && (n.includes(target) || target.includes(n));
    });
  });
  return picked.slice(0, limit).map(t => kugouTrackToTrack(t));
}

/** 网易云：名字 → artistId → artist/songs */
async function fromNetease(name: string, limit: number): Promise<{ songs: Track[]; requests: number }> {
  const cookie = currentNeteaseCookie();
  const sr: any = await netease.cloudsearch({ keywords: name, type: 100, limit: 10, cookie }, neteaseRequest);
  const artists = (sr?.body?.result?.artists ?? []) as Array<Record<string, any>>;
  const target = norm(name);
  const hit = artists.find(a => norm(String(a.name ?? '')) === target) ?? artists[0];
  if (!hit?.id) return { songs: [], requests: 1 };

  const ar: any = await netease.artistSongs(
    { id: Number(hit.id), limit, offset: 0, order: 'hot', cookie },
    neteaseRequest,
  );
  const rows = (ar?.body?.songs ?? []) as Array<Record<string, any>>;
  const songs = rows.slice(0, limit).map(s => {
    const ar0 = ((s.ar ?? []) as Array<Record<string, any>>).map(a => ({
      id: 'ne_ar_' + String(a.id ?? ''),
      mid: String(a.id ?? ''),
      name: String(a.name ?? ''),
      picUrl: '',
    }));
    const sal = (s.al ?? {}) as Record<string, any>;
    const dt = Number(s.dt ?? 0);
    const album = {
      id: 'ne_al_' + String(sal.id ?? '0'),
      mid: String(sal.id ?? '0'),
      name: String(sal.name ?? ''),
      picUrl: String(sal.picUrl ?? '').replace(/^http:/, 'https:'),
    };
    return {
      id: 'ne_' + String(s.id),
      mid: String(s.id),
      name: String(s.name ?? ''),
      ar: ar0,
      artists: ar0,
      al: album,
      album,
      dt,
      duration: Math.round(dt / 1000),
      playable: true,
      matched: true,
      privilege: { playMaxbr: 0, maxbr: 0, freeTrialPrivilege: { resConsumable: false } },
    } as Track;
  });
  return { songs, requests: 2 };
}

/** 多源拉歌手曲目；stopWhenEnough=false 时三源都拉（dry-run 观察用） */
export async function fetchArtistSongsMulti(
  name: string,
  limit = 30,
  opts: { stopWhenEnough?: boolean } = {},
): Promise<ArtistSongsMultiResult> {
  const stopWhenEnough = opts.stopWhenEnough !== false;
  const detail = { kugou: 0, netease: 0, qq: 0 };
  let requests = 0;
  let songs: Track[] = [];
  let source: ArtistSongsMultiResult['source'] = 'none';

  // ① 酷狗
  try {
    const kg = await fromKugou(name, limit);
    requests += 1;
    detail.kugou = kg.length;
    if (kg.length > 0) {
      songs = kg;
      source = 'kugou';
    }
  } catch (err) {
    requests += 1;
    log.warn('酷狗歌手曲目失败 ' + name + '：' + (err as Error).message);
  }
  if (stopWhenEnough && songs.length >= ENOUGH) {
    return { songs, source, requests, detail };
  }

  // ② 网易云
  try {
    const ne = await fromNetease(name, limit);
    requests += ne.requests;
    detail.netease = ne.songs.length;
    if (ne.songs.length > 0) {
      const seen = new Set(songs.map(s => norm(s.name)));
      for (const s of ne.songs) {
        if (seen.has(norm(s.name))) continue;
        songs.push(s);
      }
      if (source === 'none') source = 'netease';
    }
  } catch (err) {
    requests += 2;
    log.warn('网易云歌手曲目失败 ' + name + '：' + (err as Error).message);
  }
  if (stopWhenEnough && songs.length >= ENOUGH) {
    return { songs: songs.slice(0, limit), source, requests, detail };
  }

  // ③ QQ 兜底
  try {
    const qq = await getArtistSongs('', name, limit, 1);
    requests += 1;
    detail.qq = qq.songs.length;
    if (qq.songs.length > 0) {
      const seen = new Set(songs.map(s => norm(s.name)));
      for (const s of qq.songs) {
        if (seen.has(norm(s.name))) continue;
        songs.push(s);
      }
      if (source === 'none') source = 'qq';
    }
  } catch (err) {
    requests += 1;
    log.warn('QQ 歌手曲目失败 ' + name + '：' + (err as Error).message);
  }

  return { songs: songs.slice(0, limit), source, requests, detail };
}
