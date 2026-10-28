/**
 * 音源解析结果缓存仓储（持久层）。
 *
 * 与 stream.ts 里的内存 LRU 是互补关系：
 *   内存 LRU —— 热路径，命中在微秒级，但进程重启即失效
 *   本表     —— 冷启动后的第一道防线，直接消除重启后的第一批 B 站搜索请求
 *
 * **负缓存也落库**。匹配失败（无候选 / 低于阈值 / 风控）如果不记，服务重启后
 * 会把同一批"注定匹配不到"的曲子再打一遍上游 —— 这正是风控的主要来源。
 */

import type { ResolveResult } from '../../sources/bilibili/stream.ts';
import { getDatabase, now, toNumber } from '../index.ts';

/**
 * 负缓存存活时间：60 秒。
 *
 * ⚠️ 曾经是 10 分钟，那是个实打实的坑：一条失败结果会把这首歌"毒住"整整 10 分钟 ——
 * 期间用户怎么重试都播不出来（每次都命中同一条缓存失败），换一首再切回来、
 * 或者等够 10 分钟又突然能播，表现为"随机不可用"。
 * 保护上游的价值远小于"用户重试立刻有反应"，所以压到 60 秒；
 * 用户显式重试另有 `retry` 参数直接无视失败缓存（见 resolveTrack）。
 * 代价仅是：同一首持续失败的歌会被多重搜几次上游。
 */
export const NEGATIVE_TTL_MS = 60 * 1000;

/** 成功结果的最长存活时间。B 站地址有签名时效，不能无限信任 */
export const POSITIVE_MAX_TTL_MS = 30 * 60 * 1000;

/** 在 URL 自身的 deadline 之前预留的余量，避免取到"刚好过期"的地址 */
const DEADLINE_SAFETY_MS = 60 * 1000;

export interface PlaySourceRow {
  trackId: string;
  ok: boolean;
  bvid: string;
  score: number;
  audioUrl: string;
  bandwidth: number;
  matchedTitle: string;
  matchedAuthor: string;
  durationDiff: number;
  reason: string;
  message: string;
  resolvedAt: number;
  expiresAt: number;
  /** 音源来源。旧行缺列时按 bilibili 处理（迁移 004 的 DEFAULT 保证） */
  source: 'bilibili' | 'netease' | 'kugou';
  /** B 站视频封面（显示层兜底，曲目无 Q 音专辑封面时用） */
  coverUrl: string;
  /**
   * 解析当时**实际生效**的音质（lossless / exhigh / high / standard）。
   * 空串 = 旧行或上游没给 → 读出方一律保守报 standard，绝不猜更高档。
   */
  currentQuality: string;
  /** 该音源真的取得到的档位列表（音源层产出，空数组 = 未知） */
  availableQualities: string[];
}

/**
 * 计算缓存过期时间。
 *
 * 优先信任 B 站地址里自带的 `deadline`（秒级 Unix 时间戳）—— 那是签名真正的失效点，
 * 比任何猜测都准；取不到 deadline 时才退回固定 TTL。
 */
export function computeExpiry(audioUrl: string, from: number = now()): number {
  const hardCap = from + POSITIVE_MAX_TTL_MS;

  if (audioUrl) {
    const match = /[?&]deadline=(\d+)/.exec(audioUrl);
    if (match) {
      const deadlineMs = Number(match[1]) * 1000 - DEADLINE_SAFETY_MS;
      if (Number.isFinite(deadlineMs)) {
        // 地址可能已经过期（deadline 在过去），此时取一个短 TTL 让它在下次请求时刷新
        return Math.min(hardCap, Math.max(from + 30_000, deadlineMs));
      }
    }
  }

  return hardCap;
}

interface SourceDbRow {
  track_id: string;
  ok: number;
  bvid: string;
  score: number;
  audio_url: string;
  bandwidth: number;
  matched_title: string;
  matched_author: string;
  duration_diff: number;
  reason: string;
  message: string;
  resolved_at: number;
  expires_at: number;
  source: string;
  cover_url: string;
  current_quality: string;
  available_qualities: string;
}

/** available_qualities 以 JSON 数组文本落库；解不开就当未知（空数组） */
function parseQualities(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const arr = JSON.parse(text) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toRow(r: SourceDbRow): PlaySourceRow {
  return {
    trackId: r.track_id,
    ok: toNumber(r.ok) === 1,
    bvid: r.bvid,
    score: toNumber(r.score),
    audioUrl: r.audio_url,
    bandwidth: toNumber(r.bandwidth),
    matchedTitle: r.matched_title,
    matchedAuthor: r.matched_author,
    durationDiff: toNumber(r.duration_diff),
    reason: r.reason,
    message: r.message,
    resolvedAt: toNumber(r.resolved_at),
    expiresAt: toNumber(r.expires_at),
    // ⚠️ 归一化必须保留全部已知源：曾写成「非 netease 即 bilibili」，酷狗命中会被
    //    静默改标成 bilibili（客户端音源角标跟着错、CDN 请求头也跟着错）。
    source: r.source === 'netease' || r.source === 'kugou' ? r.source : 'bilibili',
    coverUrl: r.cover_url ?? '',
    currentQuality: r.current_quality ?? '',
    availableQualities: parseQualities(r.available_qualities),
  };
}

/** 把解析结果写进缓存。成功与失败都会落库，只是 TTL 不同。 */
export function saveSource(
  trackId: string,
  result: ResolveResult,
  ttlMs?: number
): void {
  if (!trackId) return;

  const ts = now();
  const expiresAt = result.ok
    ? computeExpiry(result.sourceUrl ?? '', ts)
    : ts + (ttlMs ?? NEGATIVE_TTL_MS);

  getDatabase()
    .prepare(
      `INSERT INTO play_sources (
         track_id, ok, bvid, score, audio_url, bandwidth,
         matched_title, matched_author, duration_diff, reason, message,
         resolved_at, expires_at, source, cover_url,
         current_quality, available_qualities
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(track_id) DO UPDATE SET
         ok             = excluded.ok,
         bvid           = excluded.bvid,
         score          = excluded.score,
         audio_url      = excluded.audio_url,
         bandwidth      = excluded.bandwidth,
         matched_title  = excluded.matched_title,
         matched_author = excluded.matched_author,
         duration_diff  = excluded.duration_diff,
         reason         = excluded.reason,
         message        = excluded.message,
         resolved_at    = excluded.resolved_at,
         expires_at     = excluded.expires_at,
         source         = excluded.source,
         cover_url      = excluded.cover_url,
         current_quality = excluded.current_quality,
         available_qualities = excluded.available_qualities`
    )
    .run(
      trackId,
      result.ok ? 1 : 0,
      result.bvid ?? '',
      toNumber(result.score),
      result.sourceUrl ?? '',
      toNumber(result.bandwidth),
      result.matchedTitle ?? '',
      result.matchedAuthor ?? '',
      toNumber(result.durationDiff),
      result.reason ?? '',
      result.message ?? '',
      ts,
      expiresAt,
      result.source ?? 'bilibili',
      result.coverUrl ?? '',
      result.currentQuality ?? '',
      JSON.stringify(result.availableQualities ?? [])
    );
}

/** 读取未过期的缓存行；过期或不存在返回 null（调用方据此重新解析） */
export function getSource(trackId: string): PlaySourceRow | null {
  if (!trackId) return null;

  const row = getDatabase()
    .prepare('SELECT * FROM play_sources WHERE track_id = ? AND expires_at > ?')
    .get(trackId, now()) as SourceDbRow | undefined;

  return row ? toRow(row) : null;
}

/**
 * 把缓存行还原成 ResolveResult。
 *
 * 注意：成功结果里的 sourceUrl 是**解析当时的签名地址**，可能已经失效。
 * 因此 HTTP 层在取流收到 403 时必须重解析一次，而不是把 403 透传给客户端。
 */
export function rowToResult(row: PlaySourceRow): ResolveResult {
  if (!row.ok) {
    return {
      ok: false,
      reason: (row.reason || 'error') as ResolveResult['reason'],
      bvid: row.bvid || null,
      sourceUrl: null,
      score: row.score,
      message: row.message || undefined,
      source: row.source,
    };
  }

  /**
   * 音质只信列里的实际值，**不再从 trackId 后缀猜**：
   * 猜不出来时报 standard（宁可少报，绝不虚报 —— 旧代码在这里按源猜 high/lossless，
   * 客户端据此把「无损/极高」从置灰变可点，用户点完必然降级）。
   */
  const currentQuality = row.currentQuality || 'standard';

  return {
    ok: true,
    bvid: row.bvid || null,
    sourceUrl: row.audioUrl || null,
    score: row.score,
    matchedTitle: row.matchedTitle || undefined,
    matchedAuthor: row.matchedAuthor || undefined,
    durationDiff: row.durationDiff || undefined,
    bandwidth: row.bandwidth || undefined,
    source: row.source,
    coverUrl: row.coverUrl || undefined,
    currentQuality,
    availableQualities: row.availableQualities.length ? row.availableQualities : undefined,
  };
}

/** 清理过期条目。返回值仅用于日志。 */
export function pruneSources(): number {
  const res = getDatabase()
    .prepare('DELETE FROM play_sources WHERE expires_at <= ?')
    .run(now());
  return toNumber(res.changes);
}

/**
 * 清掉某个音源的**失败缓存行**（成功行不动）。
 *
 * 唯一用途是酷狗验证码通过后：60 秒负缓存里躺着一条 20028 的失败结论，
 * 不清掉的话用户点完验证回来再解析仍会命中它、继续被提示去验证。
 */
export function deleteNegativeSources(source: 'bilibili' | 'netease' | 'kugou'): number {
  const res = getDatabase()
    .prepare('DELETE FROM play_sources WHERE source = ? AND ok = 0')
    .run(source);
  return toNumber(res.changes);
}

export function deleteSource(trackId: string): void {
  getDatabase()
    .prepare('DELETE FROM play_sources WHERE track_id = ? OR track_id LIKE ?')
    .run(trackId, `${trackId}:%`);
}

export function countSources(): { total: number; positive: number } {
  const db = getDatabase();
  const total = db.prepare('SELECT COUNT(*) AS n FROM play_sources').get() as
    | { n: number }
    | undefined;
  const positive = db
    .prepare('SELECT COUNT(*) AS n FROM play_sources WHERE ok = 1')
    .get() as { n: number } | undefined;
  return { total: toNumber(total?.n), positive: toNumber(positive?.n) };
}
