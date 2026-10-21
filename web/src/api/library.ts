/**
 * 用户库：收藏与自建歌单。
 *
 * 与 `catalog.ts` 的区别：那边是 QQ 侧的公开目录数据，这边是**用户自己的数据**。
 * 这里的写操作都会顺带把曲目快照写进服务端缓存表，避免"收藏了但列表空白"。
 */

import { http } from './client.ts';
import { fetchTracksBatch } from './catalog.ts';
import type {
  FavoritePage,
  Track,
} from './types.ts';

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

export function fetchFavorites(
  opts: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {}
): Promise<FavoritePage> {
  return http.get<FavoritePage>('/api/favorites', {
    query: { limit: opts.limit, cursor: opts.cursor ?? undefined },
    signal: opts.signal,
  });
}

/** 批量查"是否已收藏"。列表页渲染时用，避免每行发一次请求 */
export function checkFavorites(ids: string[]): Promise<{ favorites: Record<string, boolean> }> {
  return http.post('/api/favorites/check', { ids: ids.slice(0, 500) });
}

/** 收藏。传完整 `track` 可以把快照一并写进缓存 */
export function addFavorite(trackId: string, track?: Track): Promise<{ ok: boolean }> {
  return http.post('/api/favorites', track ? { trackId, track } : { trackId });
}

export function removeFavorite(trackId: string): Promise<{ ok: boolean }> {
  return http.delete(`/api/favorites/${encodeURIComponent(trackId)}`);
}

/**
 * 单次导入的条数上限。服务端硬上限 500（`routes/favorites.ts`），留点余量。
 */
const FAVORITE_IMPORT_MAX_ITEMS = 400;

/**
 * 单次导入的字节上限。
 *
 * 服务端全局 bodyLimit 只有 256KB（`app.ts`），`/api/favorites/import` 没有覆写，
 * 所以曲目对象总字节超了就是 413。这里按 180KB 切，给 JSON 包装与中文转义留余量。
 */
const FAVORITE_IMPORT_MAX_BYTES = 180 * 1024;

export interface FavoriteImportResult {
  ok: boolean;
  received: number;
  added: number;
  total: number;
  /** 实际分了几批提交 */
  batches: number;
}

/**
 * 批量收藏（利用已有的 import 接口）。传完整 track 对象以便服务端写入缓存。
 *
 * **必须分片**：2026-10-21 前的实现把整份 tracks 一次发出去，收藏数超过 500 首
 * （或字节数超过 256KB）时服务端直接 400/413 —— 而调用方（备份恢复）又把异常
 * 吞了，于是「恢复成功，新增 0 首」。这里按条数与字节数双约束切，任一批失败
 * 都抛错并带上已完成数量，绝不让调用方误以为成功。
 */
export async function batchAddFavorites(tracks: Track[]): Promise<FavoriteImportResult> {
  const chunks: Track[][] = [];
  let current: Track[] = [];
  let currentBytes = 0;

  for (const track of tracks) {
    const size = JSON.stringify(track).length;
    if (current.length >= FAVORITE_IMPORT_MAX_ITEMS || currentBytes + size > FAVORITE_IMPORT_MAX_BYTES) {
      if (current.length > 0) chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(track);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);

  let received = 0;
  let added = 0;
  let total = 0;

  for (const [index, chunk] of chunks.entries()) {
    try {
      const res = await http.post<{
        ok: boolean;
        received: number;
        added: number;
        total: number;
      }>('/api/favorites/import', { tracks: chunk }, { timeoutMs: 30_000 });
      received += res.received ?? chunk.length;
      added += res.added ?? 0;
      total = res.total ?? total;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `导入第 ${index + 1}/${chunks.length} 批失败（已成功写入 ${added} 首）：${reason}`
      );
    }
  }

  return { ok: true, received, added, total, batches: chunks.length };
}

/** 收藏的曲目原文（详情页用） */
/** 收藏分页的页大小（服务端 `/api/favorites` 上限 200） */
const FAVORITE_PAGE_SIZE = 200;
/** 翻页硬上限：20 万首。防止服务端游标异常时把客户端拖死 */
const FAVORITE_MAX_PAGES = 1000;

/**
 * 收藏的全部曲目原文（备份导出、详情页用）。
 *
 * **必须翻页**：以前这里裸调 `/api/favorites/tracks`，而那个端点默认 `limit=200`、
 * 客户端又不带参也不翻页 —— 收藏超过 200 首时 `.sm` 备份只含最新 200 首，
 * `total` 也跟着写 200，界面显示"导出成功"，换机恢复时才发现少了一半歌
 *（与审计批次 C-1 的导入侧截断完全对称，2026-10-21 重审 F 修的就是这条）。
 *
 * 走 `/api/favorites` 的复合游标而不是给 tracks 端点传 limit：游标分页对
 * "翻页期间又收藏了新歌"是稳定的，limit 分页会漏/重。
 * `track` 为 null（快照缺失）的条目用 `/api/tracks/batch` 补一次。
 */
export async function fetchFavoriteTracks(signal?: AbortSignal): Promise<{ tracks: Track[] }> {
  const byId = new Map<string, Track>();
  const missingIds = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < FAVORITE_MAX_PAGES; page++) {
    const res = await fetchFavorites({ limit: FAVORITE_PAGE_SIZE, cursor, signal });
    for (const item of res.items) {
      if (item.track) byId.set(item.track.id, item.track);
      else missingIds.add(item.trackId);
    }
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }

  // 快照缺失的曲目补齐（每批 500，与服务端上限一致）
  const pending = [...missingIds].filter(id => !byId.has(id));
  for (let i = 0; i < pending.length; i += 500) {
    const chunk = pending.slice(i, i + 500);
    try {
      const { tracks } = await fetchTracksBatch(chunk, signal);
      for (const t of tracks) byId.set(t.id, t);
    } catch {
      // 补不齐不影响恢复：能拿到多少导出多少（条目仍会出现在备份里，只是少了元数据）
    }
  }

  return { tracks: [...byId.values()] };
}

// ---------------------------------------------------------------------------
// QQ 音乐歌单导入（导入直接进收藏，自动去重）
// ---------------------------------------------------------------------------

export interface QQPlaylistImportResult {
  ok: boolean;
  playlistName: string;
  received: number;
  added: number;
  skipped: number;
  total: number;
}

/** 粘贴 QQ 音乐歌单分享链接 / 纯数字 id，导入到收藏 */
export function importQQPlaylist(link: string): Promise<QQPlaylistImportResult> {
  return http.post('/api/favorites/import-qq-playlist', { link }, { timeoutMs: 30_000 });
}

// ---------------------------------------------------------------------------
// .sm 软加密归档导出与恢复（favorites.json + persona.md）
// ---------------------------------------------------------------------------

export interface SmPreviewResult {
  ok: boolean;
  totalTracks: number;
  hasPersona: boolean;
  personaSummary: string;
}

export interface SmImportResult {
  ok: boolean;
  received: number;
  added: number;
  skipped: number;
  total: number;
  personaImported: boolean;
}

// ---------------------------------------------------------------------------
// 收藏歌单去重
// ---------------------------------------------------------------------------

export interface FavoritesDedupGroup {
  name: string;
  artist: string;
  count: number;
  keepId: string;
  removeIds: string[];
}

export interface FavoritesDedupPreviewResult {
  ok: boolean;
  duplicateCount: number;
  duplicateGroups: FavoritesDedupGroup[];
  totalFavorites: number;
}

export interface FavoritesDedupResult {
  ok: boolean;
  removedCount: number;
  remainingCount: number;
}

