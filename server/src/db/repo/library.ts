/**
 * 曲库池仓储 + 推荐黑名单仓储。
 *
 * 实体与归属分离（见 006 迁移注释）：歌手和歌是全局的，"谁的曲库里有谁"
 * 是按用户的关联。黑名单也是纯用户维度 —— 不喜欢歌手只影响自己的推荐，
 * 不动全局实体（别的用户可能正听得起劲）。
 */

import { getDatabase, now, toNumber } from '../index.ts';
import type { Track } from '../../sources/qq/adapter.ts';

// ---------------------------------------------------------------------------
// 歌手实体（全局）
// ---------------------------------------------------------------------------

export interface LibraryArtist {
  mid: string;
  name: string;
  /** 上次拉热门歌的时间。NULL = 还没拉过（待建） */
  hotFetchedAt: number | null;
}

function rowToArtist(r: any): LibraryArtist {
  return { mid: r.mid, name: r.name ?? '', hotFetchedAt: r.hot_fetched_at ?? null };
}

export function upsertLibraryArtist(mid: string, name: string): void {
  if (!mid) return;
  getDatabase()
    .prepare(
      `INSERT INTO library_artists (mid, name) VALUES (?, ?)
       ON CONFLICT(mid) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE library_artists.name END`
    )
    .run(mid, name);
}

export function getLibraryArtist(mid: string): LibraryArtist | null {
  const row = getDatabase().prepare('SELECT * FROM library_artists WHERE mid = ?').get(mid);
  return row ? rowToArtist(row) : null;
}

// ---------------------------------------------------------------------------
// 用户归属（按用户隔离的池子）
// ---------------------------------------------------------------------------

export function linkUserArtist(userId: number, artistMid: string, origin = ''): void {
  if (!artistMid) return;
  getDatabase()
    .prepare(
      `INSERT INTO library_user_artists (user_id, artist_mid, origin, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, artist_mid) DO NOTHING`
    )
    .run(userId, artistMid, origin, now());
}

/** 解除归属（不喜欢歌手时用）。歌手实体保留，别的用户不受影响 */
export function unlinkUserArtist(userId: number, artistMid: string): void {
  getDatabase()
    .prepare('DELETE FROM library_user_artists WHERE user_id = ? AND artist_mid = ?')
    .run(userId, artistMid);
}

// ---------------------------------------------------------------------------
// 曲库曲目（全局，自带快照）
// ---------------------------------------------------------------------------

/**
 * 保存某歌手的曲库曲目（蓄水池模式：只增不减、更新热度，绝不全量物理删除）。
 *
 * @param options.isRanked 是否是按热度排序的曲目列表（如 getArtistSongs 默认 true，下标+1 作为 hot_rank；深挖专辑传 false，hot_rank 保持 0）
 */
export function saveLibraryTracks(
  artistMid: string,
  tracks: Track[],
  options?: { isRanked?: boolean }
): void {
  if (!artistMid || tracks.length === 0) return;
  const db = getDatabase();
  const ts = now();
  const isRanked = options?.isRanked !== false;

  const ins = db.prepare(
    `INSERT INTO library_tracks (id, artist_mid, payload_json, added_at, hot_rank)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       payload_json = excluded.payload_json,
       hot_rank = CASE WHEN excluded.hot_rank > 0 THEN excluded.hot_rank ELSE library_tracks.hot_rank END`
  );

  // node:sqlite 没有 better-sqlite3 的 .transaction() 助手，手动 BEGIN/COMMIT
  db.exec('BEGIN');
  try {
    tracks.forEach((t, i) => {
      const rank = isRanked ? i + 1 : 0;
      ins.run(t.id, artistMid, JSON.stringify(t), ts, rank);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function findLibraryArtistsByNames(names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (names.length === 0) return out;
  const db = getDatabase();
  const placeholders = names.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT mid, name FROM library_artists WHERE name IN (${placeholders})`)
    .all(...names) as unknown as Array<{ mid: string; name: string }>;
  for (const r of rows) out.set(r.name, r.mid);
  return out;
}

/** 取一批歌手的全部曲库曲目 */
export function getLibraryTracks(artistMids: string[]): Track[] {  if (artistMids.length === 0) return [];
  const db = getDatabase();
  const placeholders = artistMids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, artist_mid, payload_json FROM library_tracks WHERE artist_mid IN (${placeholders})`
    )
    .all(...artistMids) as Array<{ id: string; artist_mid: string; payload_json: string }>;

  const out: Track[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue; // 同一曲目可能被多位歌手的快照重复携带
    seen.add(row.id);
    try {
      const t = JSON.parse(row.payload_json) as Track;
      if (t?.id) out.push(t);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

export function artistHasTracks(artistMid: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 AS x FROM library_tracks WHERE artist_mid = ? LIMIT 1')
    .get(artistMid);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// 建库队列
// ---------------------------------------------------------------------------

export type BuildJobKind = 'artist_resolve' | 'artist_songs';

export interface BuildJob {
  id: number;
  userId: number;
  kind: BuildJobKind;
  /** artist_resolve = 歌手名（待换 mid）；artist_songs = 歌手 mid */
  payload: string;
  origin: string;
}

export function enqueueBuildJob(
  userId: number,
  kind: BuildJobKind,
  payload: string,
  origin = ''
): void {
  if (!payload) return;
  getDatabase()
    .prepare(
      'INSERT INTO library_build_queue (user_id, kind, payload, origin, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(userId, kind, payload, origin, now());
}

/** 队列去重：同类同 payload 的待处理任务只留一个 */
export function hasBuildJob(kind: BuildJobKind, payload: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 AS x FROM library_build_queue WHERE kind = ? AND payload = ? LIMIT 1')
    .get(kind, payload);
  return Boolean(row);
}

/** 弹出最老的一个任务。处理成功/失败都由调用方决定是否重入队 */
export function popBuildJob(): BuildJob | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM library_build_queue ORDER BY id LIMIT 1')
    .get() as any;
  if (!row) return null;
  db.prepare('DELETE FROM library_build_queue WHERE id = ?').run(row.id);
  return {
    id: toNumber(row.id),
    userId: toNumber(row.user_id),
    kind: row.kind as BuildJobKind,
    payload: String(row.payload ?? ''),
    origin: String(row.origin ?? ''),
  };
}

// ---------------------------------------------------------------------------
// 滚动刷新
// ---------------------------------------------------------------------------

export function markArtistFetched(mid: string): void {
  getDatabase().prepare('UPDATE library_artists SET hot_fetched_at = ? WHERE mid = ?').run(now(), mid);
}

// ---------------------------------------------------------------------------
// 推荐黑名单（用户维度）
// ---------------------------------------------------------------------------

export type DislikeType = 'track' | 'artist';

export interface DislikeRow {
  type: DislikeType;
  targetId: string;
  name: string;
  createdAt: number;
}

export function addDislike(userId: number, type: DislikeType, targetId: string, name: string): void {
  if (!targetId) return;
  getDatabase()
    .prepare(
      `INSERT INTO user_dislikes (user_id, type, target_id, name, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, type, target_id) DO UPDATE SET name = excluded.name`
    )
    .run(userId, type, targetId, name, now());
}

export function removeDislike(userId: number, type: DislikeType, targetId: string): void {
  getDatabase()
    .prepare('DELETE FROM user_dislikes WHERE user_id = ? AND type = ? AND target_id = ?')
    .run(userId, type, targetId);
}

export function listDislikes(userId: number): DislikeRow[] {
  const rows = getDatabase()
    .prepare('SELECT type, target_id, name, created_at FROM user_dislikes WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Array<{ type: string; target_id: string; name: string; created_at: number }>;
  return rows.map(r => ({
    type: r.type === 'artist' ? 'artist' : 'track',
    targetId: r.target_id,
    name: r.name ?? '',
    createdAt: toNumber(r.created_at),
  }));
}

/** 生成过滤用：一次拿齐两类黑名单 */
export function getDislikeSets(userId: number): { trackIds: Set<string>; artistMids: Set<string> } {
  const rows = listDislikes(userId);
  const trackIds = new Set<string>();
  const artistMids = new Set<string>();
  for (const r of rows) {
    if (r.type === 'artist') artistMids.add(r.targetId);
    else trackIds.add(r.targetId);
  }
  return { trackIds, artistMids };
}
