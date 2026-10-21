/**
 * 歌词四级兜底（2026-09-12 用户拍板）。
 *
 * 《风继续吹》现象：最新精选集版本的曲目在 QQ 没挂歌词，但**同录音的其他
 * 版本**（经典专辑版）有 —— 音频相同，歌词逐字一致。所以兜底链是：
 *
 *   1. QQ 本曲 mid（getQQLyric，带自己的正缓存）
 *   2. QQ 同曲异版本：搜「歌名 歌手」→ 同名 + 同歌手 + 时长差 ≤5s
 *      + 排除 Live/DJ/伴奏/演唱会版（现场版歌词时间轴完全不同，绝不能混）
 *   3. 网易云：搜歌（严格校验名字/歌手/时长）→ lyric_new（含翻译，质量更好）
 *   4. 全部落空 → null（前端显示"暂无歌词"）
 *
 * 结果（含"确认没有"的负结果）按曲目 id 缓存：歌词内容不可变，
 * 正结果 7 天、负结果 24 小时 —— 负结果不缓存的话每次播放都会重跑整条链。
 */

import { createLogger } from '../logger.ts';
import { getQQLyric, clearLyricCache } from '../sources/qq/lyric.ts';
import type { QQLyric } from '../sources/qq/lyric.ts';
import { fetchSearchSlice } from '../sources/qq/search.ts';
import { adaptQQTracks } from '../sources/qq/adapter.ts';
import { netease, neteaseRequest } from '../sources/netease/vendor.ts';
import type { Track } from '../sources/qq/adapter.ts';

const log = createLogger('lyric-fallback');

const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

/** 现场版/改编版的歌词时间轴与录音室版完全不同，绝不能跨版本借用 */
const JUNK_VERSION_RE = /(DJ\s*版|慢摇|加长版|remix|剪辑|片段|试听|演唱会|\(live\)|（live）|live版|伴奏)/i;

const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  lyric: QQLyric | null;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function cacheGet(id: string): QQLyric | null | undefined {
  const hit = cache.get(id);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(id);
    return undefined;
  }
  return hit.lyric ?? null;
}

function cacheSet(id: string, lyric: QQLyric | null): void {
  cache.set(id, {
    lyric,
    expiresAt: Date.now() + (lyric ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
  // 容量防御：负结果也可能堆很多，超过 1000 条清掉最旧的
  if (cache.size > 1000) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function hasLyric(l: QQLyric): boolean {
  return Boolean(l?.lrc?.lyric);
}

/**
 * 带四级兜底的歌词获取。
 *
 * @param track 曲目完整元数据（name/ar/dt 必须有，来自 tracks 缓存或回源）
 */
export async function getLyricForTrack(track: Track): Promise<QQLyric> {
  const cached = cacheGet(track.id);
  // null = 四级链路已确认没有歌词（负缓存），返回空形状而非重跑链路
  if (cached !== undefined) return cached ?? { lrc: { lyric: '' }, tlyric: { lyric: '' } };

  // ---- 第 1 级：本曲 ----
  const own = await getQQLyric(track.mid ?? String(track.id).replace(/^qq_/, ''));
  if (hasLyric(own)) {
    cacheSet(track.id, own);
    return own;
  }

  const artists = (track.ar ?? []).map(a => a.name).filter(Boolean);
  const artistMids = (track.ar ?? []).map(a => a.mid).filter(Boolean);
  const query = `${track.name} ${artists[0] ?? ''}`.trim();

  // ---- 第 2 级：QQ 同曲异版本（同录音 → 歌词逐字一致）----
  try {
    const { list } = await fetchSearchSlice('song', query, 0, 20);
    const candidates = adaptQQTracks(list).filter(
      c =>
        c.id !== track.id &&
        norm(c.name) === norm(track.name) &&
        (c.ar ?? []).some(a => artistMids.includes(a.mid) || artists.includes(a.name)) &&
        Math.abs((c.dt ?? 0) - (track.dt ?? 0)) <= 5000 &&
        !JUNK_VERSION_RE.test(c.name)
    );
    for (const cand of candidates.slice(0, 4)) {
      const alt = await getQQLyric(cand.mid ?? String(cand.id).replace(/^qq_/, ''));
      if (hasLyric(alt)) {
        log.info(`歌词兜底命中（QQ 同曲异版本）：${track.id} ← ${cand.id} 「${cand.name}」`);
        cacheSet(track.id, alt);
        return alt;
      }
    }
  } catch (err) {
    log.warn(`同曲异版本歌词搜索失败 ${track.id}: ${(err as Error)?.message ?? err}`);
  }

  // ---- 第 3 级：网易云（含翻译）----
  try {
    const sr = await netease.search(
      { keywords: query, type: 1, limit: 5 },
      neteaseRequest
    );
    const songs = ((sr?.body as any)?.result?.songs ?? []) as Array<{
      id: number;
      name: string;
      artists?: Array<{ name?: string }>;
      duration?: number;
    }>;
    const hit = songs.find(
      s =>
        norm(s.name) === norm(track.name) &&
        (s.artists ?? []).some(a => artists.includes(String(a.name ?? ''))) &&
        Math.abs((s.duration ?? 0) - (track.dt ?? 0)) <= 5000
    );
    if (hit) {
      const lr = await netease.lyricNew({ id: hit.id }, neteaseRequest);
      const body = lr?.body as { lrc?: { lyric?: string }; tlyric?: { lyric?: string } };
      const lrc = String(body?.lrc?.lyric ?? '');
      if (lrc) {
        log.info(`歌词兜底命中（网易云）：${track.id} ← netease ${hit.id}`);
        const result: QQLyric = {
          lrc: { lyric: lrc },
          tlyric: { lyric: String(body?.tlyric?.lyric ?? '') },
        };
        cacheSet(track.id, result);
        return result;
      }
    }
  } catch (err) {
    log.warn(`网易云歌词兜底失败 ${track.id}: ${(err as Error)?.message ?? err}`);
  }

  // ---- 第 4 级：如实放弃 ----
  log.info(`歌词四级兜底全部落空：${track.id}「${track.name}」`);
  cacheSet(track.id, null);
  return { lrc: { lyric: '' }, tlyric: { lyric: '' } };
}

export function resetLyricFallbackCache(): void {
  cache.clear();
  clearLyricCache();
}
