/**
 * 曲目级「源钉」仓储（用户手动指定该曲只用某个音源）。
 */

import { getDatabase, now } from '../index.ts';

export type PinnableSource = 'kugou' | 'netease';

export interface SourcePin {
  trackId: string;
  source: PinnableSource;
  createdAt: number;
}

export function getPin(trackId: string): SourcePin | null {
  if (!trackId) return null;
  const row = getDatabase()
    .prepare('SELECT track_id, source, created_at FROM track_source_pins WHERE track_id = ?')
    .get(trackId) as { track_id: string; source: string; created_at: number } | undefined;
  if (!row) return null;
  return {
    trackId: row.track_id,
    source: row.source as PinnableSource,
    createdAt: toNum(row.created_at),
  };
}

export function setPin(trackId: string, source: PinnableSource): void {
  if (!trackId) return;
  getDatabase()
    .prepare(
      `INSERT INTO track_source_pins (track_id, source, created_at) VALUES (?, ?, ?)
       ON CONFLICT(track_id) DO UPDATE SET source = excluded.source, created_at = excluded.created_at`
    )
    .run(trackId, source, now());
}

export function deletePin(trackId: string): void {
  if (!trackId) return;
  getDatabase().prepare('DELETE FROM track_source_pins WHERE track_id = ?').run(trackId);
}

function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}
