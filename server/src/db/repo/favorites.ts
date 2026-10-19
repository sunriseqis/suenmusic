/**
 * 收藏仓储。
 *
 * 收藏是幂等的布尔关系（收藏 / 取消），用 (user_id, track_id) 做主键，
 * 重复收藏直接走 INSERT OR IGNORE —— 客户端不必先查询再决定插入。
 */

import type { Track } from '../../sources/qq/adapter.ts';
import { getDatabase, now, toNumber } from '../index.ts';

export interface FavoriteItem {
  trackId: string;
  createdAt: number;
  track: Track | null;
}

export interface ListFavoritesOptions {
  limit?: number;
  /** 游标：上一页最后一条的时间戳（毫秒） */
  beforeCreatedAt?: number;
  /** 与 beforeCreatedAt 配合，处理同一毫秒内多条记录的情况 */
  beforeTrackId?: string;
}

export interface FavoritePage {
  items: FavoriteItem[];
  nextCursor: { createdAt: number; trackId: string } | null;
}

function parsePayload(json: string | null): Track | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Track;
  } catch {
    return null;
  }
}

/** 收藏。已存在时静默成功（幂等）。 */
export function addFavorite(userId: number, trackId: string): boolean {
  const res = getDatabase()
    .prepare('INSERT OR IGNORE INTO favorites (user_id, track_id, created_at) VALUES (?, ?, ?)')
    .run(userId, trackId, now());
  return toNumber(res.changes) > 0;
}

export function removeFavorite(userId: number, trackId: string): boolean {
  const res = getDatabase()
    .prepare('DELETE FROM favorites WHERE user_id = ? AND track_id = ?')
    .run(userId, trackId);
  return toNumber(res.changes) > 0;
}

export function isFavorite(userId: number, trackId: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND track_id = ?')
    .get(userId, trackId);
  return !!row;
}

/**
 * 分页列出收藏，按收藏时间倒序。
 *
 * 用 (created_at, track_id) 复合游标而不是 offset：收藏是高频写操作，
 * 用 offset 分页时中途新增一条就会导致第二页漏掉一条。
 */
export function listFavorites(
  userId: number,
  options: ListFavoritesOptions = {}
): FavoritePage {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const params: Array<string | number> = [userId];
  let where = 'WHERE f.user_id = ?';

  if (options.beforeCreatedAt !== undefined) {
    // 复合比较：时间更早，或时间相同但 track_id 更小
    where += ' AND (f.created_at < ? OR (f.created_at = ? AND f.track_id < ?))';
    params.push(
      options.beforeCreatedAt,
      options.beforeCreatedAt,
      options.beforeTrackId ?? ''
    );
  }

  params.push(limit + 1); // 多取一条判断是否还有下一页

  const rows = getDatabase()
    .prepare(
      `SELECT f.track_id, f.created_at, t.payload_json
         FROM favorites f
         LEFT JOIN tracks t ON t.id = f.track_id
         ${where}
        ORDER BY f.created_at DESC, f.track_id DESC
        LIMIT ?`
    )
    .all(...params) as Array<{
    track_id: string;
    created_at: number;
    payload_json: string | null;
  }>;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const last = page[page.length - 1];
  return {
    items: page.map(r => ({
      trackId: r.track_id,
      createdAt: toNumber(r.created_at),
      track: parsePayload(r.payload_json),
    })),
    nextCursor:
      hasMore && last
        ? { createdAt: toNumber(last.created_at), trackId: last.track_id }
        : null,
  };
}

export function countFavorites(userId: number): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?')
    .get(userId) as { n: number } | undefined;
  return toNumber(row?.n);
}
