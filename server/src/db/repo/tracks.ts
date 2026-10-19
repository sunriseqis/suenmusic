/**
 * 曲目缓存仓储。
 *
 * QQ 音乐是元数据的真相源，这张表只做两件事：
 *   1. 少打上游（搜索页翻回来时不必重新请求）
 *   2. 让歌单 / 收藏 / 历史能在上游不可用时仍然显示出曲目信息
 *
 * 因此完整 Track 存进 payload_json，表列只用于检索和排序。
 */

import type { Track } from '../../sources/qq/adapter.ts';
import { getDatabase, now, toNumber } from '../index.ts';

interface TrackRow {
  id: string;
  payload_json: string;
}

function safeParse(json: string): Track | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Track) : null;
  } catch {
    return null;
  }
}

/**
 * 写入或更新曲目缓存。完整 Track 已存在时覆盖 payload，
 * 但保留更早的 fetched_at 语义 —— 这里 fetched_at 表示"上游取回时间"，
 * 每次 upsert 都刷新，用于判断缓存新鲜度。
 */
export function upsertTracks(tracks: Array<Track | null | undefined>): number {
  const valid = tracks.filter((t): t is Track => !!t && typeof t.id === 'string' && t.id !== '');
  if (valid.length === 0) return 0;

  const db = getDatabase();
  const ts = now();

  const stmt = db.prepare(`
    INSERT INTO tracks (
      id, mid, name, artists_json, album_id, album_mid, album_name,
      cover_url, duration_ms, payload_json, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name         = excluded.name,
      artists_json = excluded.artists_json,
      album_id     = excluded.album_id,
      album_mid    = excluded.album_mid,
      album_name   = excluded.album_name,
      cover_url    = excluded.cover_url,
      duration_ms  = excluded.duration_ms,
      payload_json = excluded.payload_json,
      fetched_at   = excluded.fetched_at,
      updated_at   = excluded.updated_at
  `);

  db.exec('BEGIN');
  try {
    for (const t of valid) {
      stmt.run(
        t.id,
        t.mid ?? '',
        t.name ?? '',
        JSON.stringify(t.ar ?? []),
        t.al?.id ?? '',
        t.al?.mid ?? '',
        t.al?.name ?? '',
        t.al?.picUrl ?? '',
        toNumber(t.dt),
        JSON.stringify(t),
        ts,
        ts
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return valid.length;
}

/**
 * 按传入顺序返回曲目。缺失的 id 会被跳过（返回数组可能比入参短），
 * 调用方需要自己对齐顺序 —— 歌单场景下 position 由 playlist_items 决定，
 * 这里只负责把内容补齐。
 */
export function getTracks(ids: string[]): Track[] {
  const unique = [...new Set(ids.filter(id => typeof id === 'string' && id !== ''))];
  if (unique.length === 0) return [];

  const db = getDatabase();
  const placeholders = unique.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, payload_json FROM tracks WHERE id IN (${placeholders})`)
    .all(...unique) as unknown as TrackRow[];

  const byId = new Map<string, Track>();
  for (const row of rows) {
    const track = safeParse(row.payload_json);
    if (track) byId.set(row.id, track);
  }

  return unique.map(id => byId.get(id)).filter((t): t is Track => !!t);
}

export function getTrack(id: string): Track | null {
  return getTracks([id])[0] ?? null;
}

/** 清掉超过指定年龄的缓存条目，避免库无限增长（严格保护收藏夹与歌单引用的曲目） */
export function pruneTracks(olderThanMs: number): number {
  const cutoff = now() - olderThanMs;
  const res = getDatabase()
    .prepare(
      `DELETE FROM tracks
        WHERE fetched_at < ?
          AND id NOT IN (SELECT track_id FROM favorites)
          AND id NOT IN (SELECT track_id FROM playlist_items)`
    )
    .run(cutoff);
  return toNumber(res.changes);
}

export function countTracks(): number {
  const row = getDatabase().prepare('SELECT COUNT(*) AS n FROM tracks').get() as
    | { n: number }
    | undefined;
  return toNumber(row?.n);
}
