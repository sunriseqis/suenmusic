/**
 * 通用上游缓存（一层内存 L1 + 一层表 L2）。
 *
 * 口径（用户拍板）：「缓存做成表、表是全局的，所有上游请求先查本地表，
 * 没有才去打上游」。此前除 tracks / play_sources / artist_simi_cache 外
 * 全用内存 Map，进程重启即清零，重启后必然重复打 QQ（并撞上限流）。
 *
 * 设计要点：
 * 1. **异常只 warn，绝不抛**。缓存是性能设施，坏掉不能让专辑页打不开 ——
 *    数据库恢复窗口（getDatabase 抛 DatabaseRestoringError）、JSON 损坏、
 *    SQL 出错全部退化成本次未命中。
 * 2. **不缓存"未命中/失败"**。只由调用方在真正拿到结果后 cachePut，
 *    否则一次上游抽风会被固化成一个 TTL 周期的错误结果。
 * 3. 调用方自己的内存 Map 保留为 L1：表读要走 SQLite + JSON.parse，
 *    热路径上内存命中仍然是零成本。
 */

import { getDatabase, now } from '../db/index.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('upstream-cache');

/**
 * 读缓存。命中且未过期返回解析后的 payload，否则返回 null。
 *
 * @param kind  业务类型（lyric / album_detail / artist_detail / ...）
 * @param key   唯一标识一次请求的字符串（由调用方拼装）
 * @param ttlMs 有效期；`fetched_at` 早于 now - ttlMs 视为过期
 */
export function cacheGet<T>(kind: string, key: string, ttlMs: number): T | null {
  try {
    const row = getDatabase()
      .prepare('SELECT payload_json, fetched_at FROM upstream_cache WHERE kind = ? AND key = ?')
      .get(kind, key) as { payload_json?: string; fetched_at?: number } | undefined;

    if (!row || typeof row.payload_json !== 'string') return null;

    // 过期的行不删（交给 pruneUpstreamCache 批量清），这里只当未命中
    if (now() - Number(row.fetched_at) > ttlMs) return null;

    return JSON.parse(row.payload_json) as T;
  } catch (err) {
    log.warn(`读上游缓存失败 kind=${kind} key=${key}: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/** 写缓存（同 kind+key 覆盖）。payload 必须可 JSON 序列化。 */
export function cachePut(kind: string, key: string, payload: unknown): void {
  try {
    const payloadJson = JSON.stringify(payload);
    // undefined / 函数序列化后会变成 undefined，写进 NOT NULL 列才报错，提前挡住
    if (typeof payloadJson !== 'string') return;

    getDatabase()
      .prepare(
        `INSERT INTO upstream_cache (kind, key, payload_json, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, key)
         DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`
      )
      .run(kind, key, payloadJson, now());
  } catch (err) {
    log.warn(`写上游缓存失败 kind=${kind} key=${key}: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * 删掉超过 ttl 的行，返回删除条数。
 *
 * 用固定的数据保留期而不是「各自 kind 的 TTL」：多 kind 各有 TTL，
 * 逐 kind 判定要维护一张对照表；统一留一个足够宽的上限（见 index.ts 的 8 天），
 * 过期行本来就已不被读取，这里只负责别让表无限长。
 */
export function pruneUpstreamCache(ttlMs: number): number {
  try {
    const result = getDatabase()
      .prepare('DELETE FROM upstream_cache WHERE fetched_at < ?')
      .run(now() - ttlMs);
    return Number(result.changes ?? 0);
  } catch (err) {
    log.warn(`清理上游缓存失败: ${(err as Error)?.message ?? err}`);
    return 0;
  }
}
