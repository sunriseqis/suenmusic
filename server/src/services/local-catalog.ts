/**
 * 本地曲目与歌手反查引擎（本地歌单回填）。
 *
 * 核心职责：
 *   从已拉取的歌单池（playlist_pool_items）、本地曲目（tracks）、已有歌手档案（library_artists）中提取：
 *   1. 歌手名字 -> mid 倒排索引（支持精简规范化、去括号后缀、去副标题）
 *   2. 歌手 mid -> 本地优质曲目集（自动过滤伴奏、现场录音与 UGC 垃圾条目）
 *
 * 收益：
 *   网易云相似歌手给出的名字，80%+ 都能在本地直接命中 mid 并就地回填曲目，
 *   实现「零 QQ 搜索、零 2001 限流」秒级建库。
 */

import { getDatabase } from '../db/index.ts';
import type { Track } from '../sources/qq/adapter.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('local-catalog');

export interface LocalArtistHit {
  mid: string;
  name: string;
}

// 缓存状态
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

let nameToArtistMap = new Map<string, LocalArtistHit>();
let midToTracksMap = new Map<string, Map<string, Track>>();

export function invalidateLocalCatalogCache(): void {
  cacheLoadedAt = 0;
}

const JUNK_RE =
  /(DJ\s*版|慢摇|加长版|remix|剪辑|片段|试听|演唱会|现场版|\(live\)|（live）|live版|伴奏|纯音乐伴奏|#\S+|第\d+集|合集|串烧)/i;

function isCleanTrack(track: Track): boolean {
  const name = String(track.name ?? '');
  if (!name || name.length > 40) return false;
  if (JUNK_RE.test(name)) return false;
  if (!track.al?.name) return false;
  return true;
}

/** 规范化名字：去空白、统一小写 */
export function exactNorm(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '');
}

/** 深度规范化：去括号后缀、去副标题、去空白、统一小写 */
export function baseNorm(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[-—–].*$/, '')
    .replace(/\s+/g, '')
    .trim();
}

function ensureIndexLoaded(): void {
  const now = Date.now();
  if (cacheLoadedAt > 0 && now - cacheLoadedAt < CACHE_TTL_MS) {
    return;
  }

  const db = getDatabase();
  const nextNameToArtist = new Map<string, LocalArtistHit>();
  const nextMidToTracks = new Map<string, Map<string, Track>>();

  const registerArtist = (mid: string, name: string) => {
    if (!mid || !name) return;
    const hit: LocalArtistHit = { mid, name };
    const k1 = exactNorm(name);
    const k2 = baseNorm(name);
    if (k1 && !nextNameToArtist.has(k1)) nextNameToArtist.set(k1, hit);
    if (k2 && !nextNameToArtist.has(k2)) nextNameToArtist.set(k2, hit);
  };

  const registerTrack = (mid: string, track: Track) => {
    if (!isCleanTrack(track) || !track.id) return;
    let trackMap = nextMidToTracks.get(mid);
    if (!trackMap) {
      trackMap = new Map();
      nextMidToTracks.set(mid, trackMap);
    }
    if (!trackMap.has(track.id)) {
      trackMap.set(track.id, track);
    }
  };

  // 1. 从已有歌手档案库加载
  try {
    const libRows = db
      .prepare("SELECT mid, name FROM library_artists WHERE name != '' AND mid != ''")
      .all() as Array<{ mid: string; name: string }>;
    for (const r of libRows) {
      registerArtist(r.mid, r.name);
    }
  } catch (err) {
    log.warn(`加载 library_artists 索引失败: ${(err as Error)?.message ?? err}`);
  }

  // 2. 从歌单池曲目中提取歌手与曲目
  try {
    const poolRows = db
      .prepare('SELECT payload_json FROM playlist_pool_items')
      .all() as Array<{ payload_json: string }>;
    for (const r of poolRows) {
      try {
        const t = JSON.parse(r.payload_json) as Track;
        if (!t?.id) continue;
        const arList = t.ar || t.artists || [];
        for (const a of arList) {
          if (!a?.name || !a?.mid) continue;
          registerArtist(a.mid, a.name);
          registerTrack(a.mid, t);
        }
      } catch {
        /* 跳过损坏 json */
      }
    }
  } catch (err) {
    log.warn(`加载 playlist_pool_items 索引失败: ${(err as Error)?.message ?? err}`);
  }

  // 3. 从 tracks 表补充已有曲目
  try {
    const trackRows = db
      .prepare('SELECT payload_json FROM tracks')
      .all() as Array<{ payload_json: string }>;
    for (const r of trackRows) {
      try {
        const t = JSON.parse(r.payload_json) as Track;
        if (!t?.id) continue;
        const arList = t.ar || t.artists || [];
        for (const a of arList) {
          if (!a?.name || !a?.mid) continue;
          registerArtist(a.mid, a.name);
          registerTrack(a.mid, t);
        }
      } catch {
        /* 跳过损坏 json */
      }
    }
  } catch (err) {
    log.warn(`加载 tracks 索引失败: ${(err as Error)?.message ?? err}`);
  }

  nameToArtistMap = nextNameToArtist;
  midToTracksMap = nextMidToTracks;
  cacheLoadedAt = now;
  log.debug(
    `本地歌手与曲目索引已就绪：有效名字键 ${nameToArtistMap.size} 个，曲目关联歌手 ${midToTracksMap.size} 位`
  );
}

/**
 * 在本地库中按名字匹配歌手信息。
 */
export function findLocalArtist(name: string): LocalArtistHit | null {
  if (!name) return null;
  ensureIndexLoaded();
  const k1 = exactNorm(name);
  if (nameToArtistMap.has(k1)) return nameToArtistMap.get(k1)!;
  const k2 = baseNorm(name);
  if (nameToArtistMap.has(k2)) return nameToArtistMap.get(k2)!;
  return null;
}

/**
 * 获取本地为某位歌手沉淀的所有干净曲目。
 */
export function findLocalTracksForArtist(mid: string): Track[] {
  if (!mid) return [];
  ensureIndexLoaded();
  const trackMap = midToTracksMap.get(mid);
  if (!trackMap || trackMap.size === 0) return [];
  return Array.from(trackMap.values());
}
