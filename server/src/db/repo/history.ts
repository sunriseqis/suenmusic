/**
 * 播放历史仓储。
 *
 * 这是"多端实时同步"的落点。关键设计：
 *
 *   1. **只追加，不 upsert**。每次播放都插新行，保留完整时间线。
 *      如果按 (user_id, track_id) 做 upsert，就再也还原不出"最近听了什么"，
 *      也无法统计播放次数随时间的变化。
 *   2. **增量同步走游标，不用 offset**。多端并发上报时 offset 分页必然漏数据，
 *      因为"第 20 条之后"在一端写入后会指向不同的记录。
 *      这里用 (played_at, id) 复合游标，严格单调递增，不会漏也不会重。
 *   3. 客户端只需保存上次拉到的游标字符串，下次带上即可拿到全部增量。
 */

import type { Track } from '../../sources/qq/adapter.ts';
import { getDatabase, now, toNumber } from '../index.ts';

export interface PlayHistoryRow {
  id: number;
  trackId: string;
  playedAt: number;
  playedMs: number;
  durationMs: number;
  completed: boolean;
  source: string;
  deviceId: string;
  track: Track | null;
}

export interface RecordPlayInput {
  userId: number;
  trackId: string;
  /** 客户端上报的播放时刻；不传则用服务端时间 */
  playedAt?: number;
  playedMs?: number;
  durationMs?: number;
  completed?: boolean;
  source?: string;
  deviceId?: string;
}

/**
 * 游标就是记录 id。
 *
 * **为什么不用 `played_at`（时间）当游标**：
 * 客户端会补报离线期间攒下的记录，`playedAt` 可能是昨天甚至上周。
 * 这种记录会插进时间线的"中间"，而任何已经越过那个时间点的客户端
 * 用时间游标都再也拉不到它 —— 数据静静丢失，且无从察觉。
 *
 * `id` 是 AUTOINCREMENT，每次插入必然严格递增，与业务时间无关。
 * 用它当游标可以保证：**只要写入过，客户端一定能拉到**。
 * 展示顺序仍按 `played_at` 由客户端自行决定。
 */
export function encodeCursor(id: number): string {
  return String(id);
}

/**
 * 解析游标。兼容历史上出现过的 `<playedAt>:<id>` 复合格式
 * （取冒号后半段作为 id），避免旧客户端升级瞬间失效。
 */
export function decodeCursor(cursor: string | undefined | null): { id: number } | null {
  if (!cursor) return null;

  const text = String(cursor).trim();
  if (!text) return null;

  const raw = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
  if (!/^\d+$/.test(raw)) return null;

  const id = Number(raw);
  return Number.isFinite(id) ? { id } : null;
}

export function recordPlay(input: RecordPlayInput): number {
  const res = getDatabase()
    .prepare(
      `INSERT INTO play_history
         (user_id, track_id, played_at, played_ms, duration_ms, completed, source, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.userId,
      input.trackId,
      input.playedAt ?? now(),
      Math.max(0, Math.floor(input.playedMs ?? 0)),
      Math.max(0, Math.floor(input.durationMs ?? 0)),
      input.completed ? 1 : 0,
      input.source || 'unknown',
      input.deviceId || ''
    );

  return toNumber(res.lastInsertRowid);
}

export interface ListHistoryOptions {
  /** 上一页拿到的游标。不传表示从头（最早的记录）开始 */
  since?: string | null;
  limit?: number;
}

export interface HistoryPage {
  items: PlayHistoryRow[];
  /**
   * 下一页游标。
   * 有数据时是最后一条的 id；已追平时**回显传入的 since**，
   * 让客户端可以继续拿着同一个游标轮询，不必自己记住位置。
   */
  nextCursor: string | null;
  /** 是否还有下一页（比 nextCursor 更明确的判断依据） */
  hasMore: boolean;
}

function parsePayload(json: string | null): Track | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Track;
  } catch {
    return null;
  }
}

function toHistoryRow(r: Record<string, unknown> & { payload_json: string | null }): PlayHistoryRow {
  return {
    id: toNumber(r.id as number),
    trackId: String(r.track_id),
    playedAt: toNumber(r.played_at as number),
    playedMs: toNumber(r.played_ms as number),
    durationMs: toNumber(r.duration_ms as number),
    completed: toNumber(r.completed as number) === 1,
    source: String(r.source ?? 'unknown'),
    deviceId: String(r.device_id ?? ''),
    track: parsePayload(r.payload_json),
  };
}

/**
 * 增量拉取播放历史，按**插入顺序**（id 升序）返回。
 *
 * 升序是刻意的：增量同步的语义是"把客户端没见过的补给它"，
 * 只有顺序推进游标才能保证不漏。需要时间倒序展示由客户端自行排序 ——
 * 记录里带着 `playedAt`，客户端想怎么排都行。
 */
export function listHistory(
  userId: number,
  options: ListHistoryOptions = {}
): HistoryPage {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const cursor = decodeCursor(options.since);

  const params: Array<string | number> = [userId];
  let where = 'WHERE h.user_id = ?';

  if (cursor) {
    where += ' AND h.id > ?';
    params.push(cursor.id);
  }

  // 多取一条判断是否还有下一页
  params.push(limit + 1);

  const rows = getDatabase()
    .prepare(
      `SELECT h.*, t.payload_json
         FROM play_history h
         LEFT JOIN tracks t ON t.id = h.track_id
         ${where}
        ORDER BY h.id ASC
        LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown> & { payload_json: string | null }>;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(toHistoryRow);

  const last = items[items.length - 1];
  return {
    items,
    nextCursor: last ? encodeCursor(last.id) : (options.since ?? null),
    hasMore,
  };
}

/**
 * 最近播放（倒序、可选去重）。
 *
 * 去重取每首歌**最后一次**播放那一行。
 *
 * 实现上刻意不用 `GROUP BY track_id + MAX(played_at) + MAX(id)`：
 * 那两个 MAX 是**独立**求出来的，只要"最大 id 的那行"不是"最大 played_at 的那行"
 * （离线补报的时间会乱序，很容易出现），外层 `h.id = mi AND h.played_at = mp`
 * 就匹配不到任何行 —— 查询返回空集，而且**不报任何错**。
 * 改用关联子查询明确表达"按 (played_at, id) 倒序取第一行"，语义唯一。
 */
export function recentTracks(
  userId: number,
  options: { limit?: number; dedupe?: boolean } = {}
): PlayHistoryRow[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const db = getDatabase();

  if (options.dedupe === false) {
    const rows = db
      .prepare(
        `SELECT h.*, t.payload_json
           FROM play_history h
           LEFT JOIN tracks t ON t.id = h.track_id
          WHERE h.user_id = ?
          ORDER BY h.played_at DESC, h.id DESC
          LIMIT ?`
      )
      .all(userId, limit) as Array<Record<string, unknown> & { payload_json: string | null }>;

    return rows.map(toHistoryRow);
  }

  const rows = db
    .prepare(
      `SELECT h.*, t.payload_json
         FROM play_history h
         LEFT JOIN tracks t ON t.id = h.track_id
        WHERE h.user_id = ?
          AND h.id = (
            SELECT h2.id
              FROM play_history h2
             WHERE h2.user_id = h.user_id
               AND h2.track_id = h.track_id
             ORDER BY h2.played_at DESC, h2.id DESC
             LIMIT 1
          )
        ORDER BY h.played_at DESC, h.id DESC
        LIMIT ?`
    )
    .all(userId, limit) as Array<Record<string, unknown> & { payload_json: string | null }>;

  return rows.map(toHistoryRow);
}

/** 跨端续播：取某首歌最近一次的播放进度 */
export function lastProgress(
  userId: number,
  trackId: string
): { playedMs: number; playedAt: number } | null {
  const row = getDatabase()
    .prepare(
      `SELECT played_ms, played_at FROM play_history
        WHERE user_id = ? AND track_id = ?
        ORDER BY played_at DESC, id DESC LIMIT 1`
    )
    .get(userId, trackId) as { played_ms: number; played_at: number } | undefined;

  return row
    ? { playedMs: toNumber(row.played_ms), playedAt: toNumber(row.played_at) }
    : null;
}

export function deleteHistoryEntry(userId: number, id: number): boolean {
  const res = getDatabase()
    .prepare('DELETE FROM play_history WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return toNumber(res.changes) > 0;
}

/** 清空某用户全部历史（隐私操作，必须有） */
export function clearHistory(userId: number): number {
  const res = getDatabase()
    .prepare('DELETE FROM play_history WHERE user_id = ?')
    .run(userId);
  return toNumber(res.changes);
}

export function countHistory(userId: number): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM play_history WHERE user_id = ?')
    .get(userId) as { n: number } | undefined;
  return toNumber(row?.n);
}
