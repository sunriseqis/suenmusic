/**
 * 歌单仓储。
 *
 * 曲目内容（Track 详情）不在本表里，只存 track_id；展示时去 tracks 表 JOIN 取回。
 * 这样同一首歌被加进十个歌单也只存一份元数据。
 */

import { randomUUID } from 'node:crypto';
import type { Track } from '../../sources/qq/adapter.ts';
import { getDatabase, now, toNumber } from '../index.ts';

/** 位置步长。留出插空余量，避免每次插入都要重排整张表 */
const POSITION_STEP = 1000;

export interface PlaylistRow {
  id: string;
  userId: number;
  name: string;
  description: string;
  coverUrl: string;
  sort: number;
  trackCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistItem {
  id: number;
  trackId: string;
  position: number;
  addedAt: number;
  track: Track | null;
}

interface PlaylistDbRow {
  id: string;
  user_id: number;
  name: string;
  description: string;
  cover_url: string;
  sort: number;
  track_count?: number;
  first_cover?: string | null;
  created_at: number;
  updated_at: number;
}

function toPlaylist(r: PlaylistDbRow): PlaylistRow {
  return {
    id: r.id,
    userId: toNumber(r.user_id),
    name: r.name,
    description: r.description,
    // 没设封面时回落到首曲封面，避免客户端拿到空字符串去请求图片
    coverUrl: r.cover_url || r.first_cover || '',
    sort: toNumber(r.sort),
    trackCount: toNumber(r.track_count),
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  };
}

const MAX_NAME_LEN = 64;
const MAX_DESC_LEN = 1000;

export class PlaylistInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaylistInputError';
  }
}

function normalizeName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw new PlaylistInputError('歌单名不能为空');
  if (value.length > MAX_NAME_LEN) {
    throw new PlaylistInputError(`歌单名不能超过 ${MAX_NAME_LEN} 个字符`);
  }
  return value;
}

function normalizeDesc(desc: unknown): string {
  const value = typeof desc === 'string' ? desc.trim() : '';
  return value.slice(0, MAX_DESC_LEN);
}

// ---------- 歌单本体 ----------

export function createPlaylist(
  userId: number,
  input: { name: unknown; description?: unknown; coverUrl?: unknown }
): PlaylistRow {
  const db = getDatabase();
  const ts = now();
  const id = randomUUID();

  const maxRow = db
    .prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM playlists WHERE user_id = ?')
    .get(userId) as { m: number } | undefined;

  db.prepare(
    `INSERT INTO playlists (id, user_id, name, description, cover_url, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    normalizeName(input.name),
    normalizeDesc(input.description),
    typeof input.coverUrl === 'string' ? input.coverUrl : '',
    toNumber(maxRow?.m) + POSITION_STEP,
    ts,
    ts
  );

  return getPlaylist(userId, id)!;
}

export function getPlaylist(userId: number, id: string): PlaylistRow | null {
  const row = getDatabase()
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS track_count,
         (SELECT t.cover_url FROM playlist_items i
            JOIN tracks t ON t.id = i.track_id
           WHERE i.playlist_id = p.id AND t.cover_url <> ''
           ORDER BY i.position ASC, i.id ASC LIMIT 1) AS first_cover
       FROM playlists p
       WHERE p.id = ? AND p.user_id = ?`
    )
    .get(id, userId) as PlaylistDbRow | undefined;

  return row ? toPlaylist(row) : null;
}

export function listPlaylists(userId: number): PlaylistRow[] {
  const rows = getDatabase()
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS track_count,
         (SELECT t.cover_url FROM playlist_items i
            JOIN tracks t ON t.id = i.track_id
           WHERE i.playlist_id = p.id AND t.cover_url <> ''
           ORDER BY i.position ASC, i.id ASC LIMIT 1) AS first_cover
       FROM playlists p
       WHERE p.user_id = ?
       ORDER BY p.sort ASC, p.created_at ASC`
    )
    .all(userId) as unknown as PlaylistDbRow[];

  return rows.map(toPlaylist);
}

export interface PlaylistPatch {
  name?: unknown;
  description?: unknown;
  coverUrl?: unknown;
  sort?: unknown;
}

export function updatePlaylist(
  userId: number,
  id: string,
  patch: PlaylistPatch
): PlaylistRow | null {
  const current = getPlaylist(userId, id);
  if (!current) return null;

  const name = patch.name === undefined ? current.name : normalizeName(patch.name);
  const description =
    patch.description === undefined
      ? current.description
      : normalizeDesc(patch.description);
  const coverUrl =
    patch.coverUrl === undefined
      ? current.coverUrl
      : typeof patch.coverUrl === 'string'
        ? patch.coverUrl
        : current.coverUrl;
  const sort =
    patch.sort === undefined ? current.sort : toNumber(Number(patch.sort)) || current.sort;

  getDatabase()
    .prepare(
      `UPDATE playlists
          SET name = ?, description = ?, cover_url = ?, sort = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`
    )
    .run(name, description, coverUrl, sort, now(), id, userId);

  return getPlaylist(userId, id);
}

export function deletePlaylist(userId: number, id: string): boolean {
  const res = getDatabase()
    .prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return toNumber(res.changes) > 0;
}

function touch(playlistId: string): void {
  getDatabase()
    .prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
    .run(now(), playlistId);
}

/** 确认歌单属于该用户，否则返回 false。所有写操作都必须先过这一关。 */
export function ownsPlaylist(userId: number, id: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 AS x FROM playlists WHERE id = ? AND user_id = ?')
    .get(id, userId);
  return !!row;
}

// ---------- 曲目操作 ----------

export function listPlaylistItems(playlistId: string): PlaylistItem[] {
  const rows = getDatabase()
    .prepare(
      `SELECT i.id, i.track_id, i.position, i.added_at, t.payload_json
         FROM playlist_items i
         LEFT JOIN tracks t ON t.id = i.track_id
        WHERE i.playlist_id = ?
        ORDER BY i.position ASC, i.id ASC`
    )
    .all(playlistId) as Array<{
    id: number;
    track_id: string;
    position: number;
    added_at: number;
    payload_json: string | null;
  }>;

  return rows.map(r => {
    let track: Track | null = null;
    if (r.payload_json) {
      try {
        track = JSON.parse(r.payload_json) as Track;
      } catch {
        track = null;
      }
    }
    return {
      id: toNumber(r.id),
      trackId: r.track_id,
      position: toNumber(r.position),
      addedAt: toNumber(r.added_at),
      track,
    };
  });
}

/**
 * 追加曲目到歌单尾部。
 *
 * 同曲重复添加会被跳过（返回 added 计数不含重复项）—— 重复曲目在歌单里
 * 除了制造困惑没有实际价值，而且会让"移除"语义变得含糊。
 */
export function addTracks(
  userId: number,
  playlistId: string,
  trackIds: string[]
): { added: number; skipped: number } {
  const ids = [...new Set(trackIds.filter(id => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return { added: 0, skipped: 0 };

  const db = getDatabase();
  const existing = new Set(
    (
      db
        .prepare('SELECT track_id FROM playlist_items WHERE playlist_id = ?')
        .all(playlistId) as Array<{ track_id: string }>
    ).map(r => r.track_id)
  );

  const maxRow = db
    .prepare(
      'SELECT COALESCE(MAX(position), 0) AS m FROM playlist_items WHERE playlist_id = ?'
    )
    .get(playlistId) as { m: number } | undefined;
  let position = toNumber(maxRow?.m);

  const stmt = db.prepare(
    'INSERT INTO playlist_items (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)'
  );
  const ts = now();
  let added = 0;

  db.exec('BEGIN');
  try {
    for (const id of ids) {
      if (existing.has(id)) continue;
      position += POSITION_STEP;
      stmt.run(playlistId, id, position, ts);
      added++;
    }
    if (added > 0) touch(playlistId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { added, skipped: ids.length - added };
}

/** 按 item id 移除单条（推荐方式：同曲只可能被去重后存在一条） */
export function removeItem(
  userId: number,
  playlistId: string,
  itemId: number
): boolean {
  const res = getDatabase()
    .prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .run(itemId, playlistId);
  const changed = toNumber(res.changes) > 0;
  if (changed) touch(playlistId);
  return changed;
}

/** 按 track_id 移除（调用方手上只有曲目 id 时用） */
export function removeTrack(
  userId: number,
  playlistId: string,
  trackId: string
): number {
  const res = getDatabase()
    .prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND track_id = ?')
    .run(playlistId, trackId);
  const changed = toNumber(res.changes);
  if (changed > 0) touch(playlistId);
  return changed;
}

/**
 * 全量重排。
 *
 * 采用"全量覆盖"而不是交换两条：客户端拖拽后本来就持有完整顺序，
 * 全量写回只有一个写入点，不会出现交换过程中崩在中途导致的乱序。
 */
export function reorder(
  userId: number,
  playlistId: string,
  orderedItemIds: number[]
): boolean {
  const db = getDatabase();
  const current = listPlaylistItems(playlistId).map(i => i.id);

  // 入参必须恰好是当前全部条目的一个排列，否则说明客户端状态过期了
  if (current.length !== orderedItemIds.length) return false;
  const currentSet = new Set(current);
  const givenSet = new Set(orderedItemIds);
  if (givenSet.size !== orderedItemIds.length) return false;
  for (const id of orderedItemIds) {
    if (!currentSet.has(id)) return false;
  }

  const stmt = db.prepare(
    'UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?'
  );

  db.exec('BEGIN');
  try {
    orderedItemIds.forEach((id, index) => {
      stmt.run((index + 1) * POSITION_STEP, id, playlistId);
    });
    touch(playlistId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return true;
}

export function countPlaylists(userId: number): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?')
    .get(userId) as { n: number } | undefined;
  return toNumber(row?.n);
}
