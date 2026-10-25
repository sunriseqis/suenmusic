#!/usr/bin/env node
/**
 * 清理已入池的翻奏 / 钢琴 / 纯音乐条目。
 *
 * 为什么需要它：统一判定（src/services/content-filter.ts）只能拦住**新**入池的脏条目，
 * 而在它上线之前，网友歌单里已经灌进池子的钢琴集还躺在 `playlist_pool_items` 里，
 * 每日推荐照样会挑到它们。所以这里做一次性（可重复执行）清理。
 *
 * ⚠️ **只删 `playlist_pool_items`，绝不动 `tracks` 表**：
 * 曲目本身是正常数据（能被搜索、能播放、能进收藏），只是不该被推荐链路选中。
 * 判定规则与推荐链路是同一份（直接 import content-filter），不会出现"脚本删的和
 * 线上拦的不是一批"这种口径漂移。
 *
 * 用法：
 *   node scripts/purge-covers.mjs [--dry-run]
 *     --dry-run  只统计不删除（先看规模）
 *   库路径沿用服务端口径：SUENMUSIC_DB（默认 ./data/suenmusic.db）
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isCoverOrInstrumental } from '../src/services/content-filter.ts';

const SERVER_ROOT = resolve(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const dbPath = resolve(SERVER_ROOT, process.env.SUENMUSIC_DB ?? './data/suenmusic.db');

if (!existsSync(dbPath)) {
  process.stderr.write(`数据库不存在：${dbPath}\n`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const countRows = () =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM playlist_pool_items').get()?.n ?? 0);

const before = countRows();
const rows = db
  .prepare('SELECT dissid, track_id, payload_json FROM playlist_pool_items')
  .all();

/** @type {Array<{ dissid: string, trackId: string }>} */
const doomed = [];
const samples = [];
for (const row of rows) {
  let track;
  try {
    track = JSON.parse(row.payload_json);
  } catch {
    continue; // 坏载荷交给上游 ing 逻辑，不在这里瞎删
  }
  if (!isCoverOrInstrumental(track)) continue;
  doomed.push({ dissid: String(row.dissid), trackId: String(row.track_id) });
  if (samples.length < 10) {
    const artist = (track.ar ?? []).map(a => a?.name).filter(Boolean).join('/');
    samples.push(`${track.name} | ${artist} | ${track.al?.name ?? ''}`);
  }
}

if (samples.length > 0) {
  process.stdout.write('命中示例（曲名 | 歌手 | 专辑）：\n');
  for (const s of samples) process.stdout.write(`  - ${s}\n`);
}

if (!dryRun && doomed.length > 0) {
  const del = db.prepare('DELETE FROM playlist_pool_items WHERE dissid = ? AND track_id = ?');
  db.exec('BEGIN');
  try {
    for (const d of doomed) del.run(d.dissid, d.trackId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const after = dryRun ? before - doomed.length : countRows();
process.stdout.write(
  `\n${dryRun ? '[dry-run] ' : ''}playlist_pool_items：${before} → ${after}（删除 ${doomed.length} 条）\n`
);
process.stdout.write('tracks 表未改动（曲目保留，只是不再进推荐）。\n');
db.close();
