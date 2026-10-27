/**
 * 多源单曲搜索聚合：**酷狗为主 + 网易云为辅 + QQ 对质兜底**，零翻唱。
 *
 * 三段职责（用户 2026-10-26 定稿）：
 *   · 酷狗：第一顺位。条目自带 hash → 转 `kg_<albumAudioId>` 落库后点播 0 次二次搜索；
 *   · 网易云：并发辅源。补「酷狗没有、只有网易云有」的独有原唱（如《知我》国风堂/哦漏）；
 *   · QQ：门面兜底，并作为同曲比对源参与原唱对质。
 *
 * 零翻唱三级过滤：
 *   1. 单源认证硬门槛：酷狗 `IsOriginal===1`、网易云 `originCoverType===1`；
 *   2. 跨源原唱对质：汇总两源认证过的「歌名 → 原唱歌手集合」，同名条目歌手对不上即判翻唱剔除；
 *   3. 变种清洗：伴奏/纯音乐/钢琴/DJ/慢摇/变速/翻唱/flok 片段等一律丢弃（Live 保留但排后）。
 */

import { createLogger } from '../logger.ts';
import { kugouSearchSongs, kugouTrackToTrack } from '../sources/kugou/source.ts';
import { searchQQ, QQ_SEARCH_TYPE } from '../sources/qq/search.ts';
import { netease, neteaseRequest } from '../sources/netease/vendor.ts';
import { currentNeteaseCookie } from './netease-account.ts';
import type { Track } from '../sources/qq/adapter.ts';
import { upsertTracks } from '../db/repo/tracks.ts';

const log = createLogger('multi-search');

/** 变种/翻唱清洗：命中的一律不当作原唱 */
const VARIANT_RE = /(伴奏|纯音乐|钢琴|吉他|器乐|dj|慢摇|变速|remix|片段|消音|和声|翻唱|cover)/i;
/** 原唱本人的官方 Live：保留，排在录音室原版之后 */
const LIVE_RE = /(live|现场|演唱会)/i;

/** 常见异体/简繁差异归一，否则「夏日入侵企划」搜不到「夏日入侵企画」 */
const VARIANT_CHARS: Array<[RegExp, string]> = [
  [/企画/g, '企划'],
  [/計画/g, '计划'],
  [/飛/g, '飞'],
  [/陳/g, '陈'],
];

function norm(s: string): string {
  let out = String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[()（）[\]【】]/g, '');
  for (const [re, to] of VARIANT_CHARS) out = out.replace(re, to);
  return out;
}

/** 同曲去重键：歌名 + 是否 Live + 排序后的歌手名（与收藏去重口径一致：不看来源、不看 id） */
function dedupeKey(t: Track): string {
  const live = LIVE_RE.test(t.name) ? '1' : '0';
  const base = norm(t.name.replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, ''));
  const artists = (t.ar ?? [])
    .map(a => norm(a.name))
    .filter(Boolean)
    .sort()
    .join('/');
  return `${base}|${live}|${artists}`;
}

/** 网易云 cloudsearch 条目 → 统一 Track（`ne_` 前缀） */
function neteaseSongToTrack(s: Record<string, any>): Track {
  const ar = ((s.ar ?? []) as Array<Record<string, any>>).map(a => ({
    id: 'ne_ar_' + String(a.id ?? ''),
    mid: String(a.id ?? ''),
    name: String(a.name ?? ''),
    picUrl: '',
  }));
  const al = (s.al ?? {}) as Record<string, any>;
  const cover = String(al.picUrl ?? '');
  const albumId = 'ne_al_' + String(al.id ?? '0');
  const dt = Number(s.dt ?? s.duration ?? 0);
  const album = { id: albumId, mid: String(al.id ?? '0'), name: String(al.name ?? ''), picUrl: cover };
  return {
    id: 'ne_' + String(s.id),
    mid: String(s.id),
    name: String(s.name ?? ''),
    ar,
    artists: ar,
    al: album,
    album,
    dt,
    duration: Math.round(dt / 1000),
    playable: true,
    matched: true,
    privilege: { playMaxbr: 0, maxbr: 0, freeTrialPrivilege: { resConsumable: false } },
  } as Track;
}

/** 把两个列表 1:1 交替穿插（酷狗先），让双源各自的头部曲目都能排到前面 */
function interleave(a: Track[], b: Track[]): Track[] {
  const out: Track[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

export interface MultiSongsResult {
  songs: Track[];
  /** 酷狗失败/为空而主要靠兜底时为 true */
  degraded: boolean;
  /** 本次实际用到的源 */
  sources: string[];
}

export async function searchSongsMulti(query: string, limit = 20): Promise<MultiSongsResult> {
  const q = query.trim();
  if (!q) return { songs: [], degraded: false, sources: [] };

  const qNorm = norm(q);
  const sources: string[] = [];

  /** 相关性：歌名或歌手名必须与查询词相关（挡掉搜「晴天」带出《好不容易》这类噪声） */
  const relevant = (name: string, artists: string[]) =>
    norm(name).includes(qNorm) ||
    qNorm.includes(norm(name)) ||
    artists.some(x => norm(x).includes(qNorm) || qNorm.includes(norm(x)));

  // ---- 并发拉酷狗与网易云 ----
  const kugouTask = (async () => {
    try {
      const rows = await kugouSearchSongs(q, 30);
      return rows.filter(r => {
        if (VARIANT_RE.test(r.name)) return false;
        if (!r.isOriginal) return false;
        return relevant(r.name, r.singers.map(s => s.name));
      });
    } catch (err) {
      log.warn(`酷狗搜索失败：${(err as Error).message}`);
      return [];
    }
  })();

  const neteaseTask = (async () => {
    try {
      const r: any = await netease.cloudsearch(
        { keywords: q, type: 1, limit: 30, cookie: currentNeteaseCookie() },
        neteaseRequest,
      );
      const songs = r?.body?.result?.songs ?? [];
      // 官方原唱认证硬门槛：只放行 originCoverType === 1
      return (songs as Array<Record<string, any>>).filter(s => {
        if (Number(s.originCoverType ?? 0) !== 1) return false;
        if (VARIANT_RE.test(String(s.name ?? ''))) return false;
        const artists = ((s.ar ?? []) as Array<Record<string, any>>).map(a => String(a.name ?? ''));
        return relevant(String(s.name ?? ''), artists);
      });
    } catch (err) {
      log.warn(`网易云云搜索失败：${(err as Error).message}`);
      return [];
    }
  })();

  const [kugouRows, neteaseRows] = await Promise.all([kugouTask, neteaseTask]);

  const kugouSongs = kugouRows.map(t => kugouTrackToTrack(t));
  const neteaseSongs = neteaseRows.map(s => neteaseSongToTrack(s));
  if (kugouSongs.length > 0) sources.push('kugou');
  if (neteaseSongs.length > 0) sources.push('netease');

  // ---- 跨源原唱对质：两源认证过的「歌名 → 原唱歌手集合」 ----
  const authority = new Map<string, Set<string>>();
  const addAuthority = (name: string, artists: string[]) => {
    const key = norm(name);
    if (!authority.has(key)) authority.set(key, new Set());
    for (const a of artists) authority.get(key)!.add(norm(a));
  };
  for (const t of kugouSongs) addAuthority(t.name, (t.ar ?? []).map(a => a.name));
  for (const t of neteaseSongs) addAuthority(t.name, (t.ar ?? []).map(a => a.name));

  /** 歌手是否命中权威集合（名字归一化后互含即算命中，兼容「周杰伦」vs「周杰伦 Jay Chou」） */
  const artistOk = (t: Track): boolean => {
    const auth = authority.get(norm(t.name));
    if (!auth || auth.size === 0) return true; // 没有任何源认证过 → 不作判断
    return (t.ar ?? []).some(a => {
      const n = norm(a.name);
      for (const x of auth) {
        if (n.includes(x) || x.includes(n)) return true;
      }
      return false;
    });
  };

  // ---- QQ 辅源（对质用）：始终拉取，用来挡掉「同名但歌手不符」的野鸡条目 ----
  let qqSongs: Track[] = [];
  try {
    const r = await searchQQ(q, { limit, slices: [QQ_SEARCH_TYPE.song] as never });
    qqSongs = (r.songs ?? []).filter(t => {
      if (VARIANT_RE.test(t.name)) return false;
      return relevant(t.name, (t.ar ?? []).map(a => a.name));
    });
  } catch (err) {
    log.warn(`QQ 辅源搜索失败：${(err as Error).message}`);
  }

  // 酷狗与网易云条目也要过一遍对质：能杀掉酷狗侧的同名翻唱（如《知我》里的伪原唱条目）
  const keptKugou = kugouSongs.filter(artistOk);
  const keptNetease = neteaseSongs.filter(artistOk);
  // QQ 条目只有在对质通过时才保留（它没有官方原唱标记，全靠对质）
  const keptQQ = qqSongs.filter(t => artistOk(t));

  const dropped =
    kugouSongs.length - keptKugou.length + (neteaseSongs.length - keptNetease.length) + (qqSongs.length - keptQQ.length);
  if (dropped > 0) log.debug(`跨源对质剔除 ${dropped} 条同名翻唱`);

  // ---- 排序：精确命中置顶 → 酷狗/网易云 1:1 穿插 → QQ 补位 ----
  const exact = (t: Track) => (norm(t.name) === qNorm ? 0 : 1);
  const tier0 = [...keptKugou, ...keptNetease, ...keptQQ].filter(t => exact(t) === 0);
  const tier1 = interleave(
    keptKugou.filter(t => exact(t) === 1),
    keptNetease.filter(t => exact(t) === 1),
  );
  const tier2 = keptQQ.filter(t => exact(t) === 1);

  const seen = new Set<string>();
  const songs: Track[] = [];
  for (const t of [...tier0, ...tier1, ...tier2]) {
    const k = dedupeKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    songs.push(t);
    if (songs.length >= limit) break;
  }

  // 落库：酷狗条目带 kugouMeta（点播直取），其余照常
  const toSave = [...keptKugou, ...keptNetease, ...keptQQ];
  if (toSave.length > 0) {
    try {
      upsertTracks(toSave);
    } catch (err) {
      log.warn(`落库失败：${(err as Error).message}`);
    }
  }

  return { songs, degraded: keptKugou.length === 0, sources };
}
