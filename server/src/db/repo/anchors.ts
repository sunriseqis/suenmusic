/**
 * 曲目音源锚定映射仓储（持久层，永不过期）。
 *
 * 一行 = 「这首曲 trustable 地对应那个 B 站视频」。
 *   - pinned = 1：用户在锚定弹窗里手动选定，自动沉淀不得覆盖
 *   - pinned = 0：自动匹配成功后顺手沉淀，方便下次直接取流
 *
 * 解析器读取本表后只需「取流」两步轻请求，跳过「搜索 + 打分」重流程；
 * 这也是低置信（below_threshold）曲目的最终出路：用户手动锚定一次，
 * 之后永远可播。
 */

import { getDatabase, now, toNumber } from '../index.ts';

export interface TrackAnchor {
  trackId: string;
  bvid: string;
  title: string;
  author: string;
  durationSec: number;
  pinned: boolean;
}

interface AnchorDbRow {
  track_id: string;
  bvid: string;
  title: string;
  author: string;
  duration_sec: number;
  pinned: number;
}

function toAnchor(row: AnchorDbRow): TrackAnchor {
  return {
    trackId: row.track_id,
    bvid: row.bvid,
    title: row.title ?? '',
    author: row.author ?? '',
    durationSec: toNumber(row.duration_sec),
    pinned: toNumber(row.pinned) === 1,
  };
}

export function getAnchor(trackId: string): TrackAnchor | null {
  if (!trackId) return null;
  const row = getDatabase()
    .prepare('SELECT * FROM track_anchors WHERE track_id = ?')
    .get(trackId) as AnchorDbRow | undefined;
  return row ? toAnchor(row) : null;
}

/**
 * 写入/更新锚定映射。
 *
 * `pinned=true`（用户手动锚定）无条件覆盖；`pinned=false`（自动沉淀）
 * 只允许覆盖非手动行 —— 用户拍板过的映射不能被算法悄悄换掉。
 */
export function saveAnchor(
  trackId: string,
  data: { bvid: string; title?: string; author?: string; durationSec?: number },
  pinned: boolean
): void {
  if (!trackId || !data.bvid) return;

  const ts = now();
  const db = getDatabase();
  const base =
    'INSERT INTO track_anchors (track_id, bvid, title, author, duration_sec, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  const args = [
    trackId,
    data.bvid,
    data.title ?? '',
    data.author ?? '',
    toNumber(data.durationSec),
    pinned ? 1 : 0,
    ts,
    ts,
  ];

  if (pinned) {
    // 手动锚定：无条件覆盖（用户改主意时必须生效）
    db.prepare(
      `${base} ON CONFLICT(track_id) DO UPDATE SET
         bvid = excluded.bvid, title = excluded.title, author = excluded.author,
         duration_sec = excluded.duration_sec, pinned = excluded.pinned, updated_at = excluded.updated_at`
    ).run(...args);
  } else {
    // 自动沉淀：只覆盖非手动行（SQLite 里 WHERE 的裸列名指原行）
    db.prepare(
      `${base} ON CONFLICT(track_id) DO UPDATE SET
         bvid = excluded.bvid, title = excluded.title, author = excluded.author,
         duration_sec = excluded.duration_sec, pinned = excluded.pinned, updated_at = excluded.updated_at
       WHERE pinned = 0`
    ).run(...args);
  }
}

export function deleteAnchor(trackId: string): void {
  if (!trackId) return;
  getDatabase().prepare('DELETE FROM track_anchors WHERE track_id = ?').run(trackId);
}
