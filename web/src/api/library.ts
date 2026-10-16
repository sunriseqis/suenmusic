/**
 * 用户库：收藏与自建歌单。
 *
 * 与 `catalog.ts` 的区别：那边是 QQ 侧的公开目录数据，这边是**用户自己的数据**。
 * 这里的写操作都会顺带把曲目快照写进服务端缓存表，避免"收藏了但列表空白"。
 */

import { http, requestBlob } from './client.ts';
import type {
  FavoritePage,
  PlaylistItemEntry,
  Track,
  UserPlaylist,
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

/** 批量收藏（利用已有的 import 接口）。传完整 track 对象以便服务端写入缓存 */
export function batchAddFavorites(
  tracks: Track[]
): Promise<{ ok: boolean; received: number; added: number; total: number }> {
  return http.post('/api/favorites/import', { tracks }, { timeoutMs: 30_000 });
}

/** 收藏的曲目原文（详情页用） */
export function fetchFavoriteTracks(): Promise<{ tracks: Track[] }> {
  return http.get('/api/favorites/tracks');
}

// ---------------------------------------------------------------------------
// 自建歌单
// ---------------------------------------------------------------------------

export function fetchPlaylists(): Promise<{ playlists: UserPlaylist[] }> {
  return http.get('/api/playlists');
}

export function createPlaylist(input: {
  name: string;
  description?: string;
  coverUrl?: string;
}): Promise<{ playlist: UserPlaylist }> {
  return http.post('/api/playlists', input);
}

export function fetchPlaylist(id: string): Promise<{
  playlist: UserPlaylist;
  items: PlaylistItemEntry[];
  /** 曲目快照缺失的 trackId，客户端可据此回源补全 */
  missing: string[];
}> {
  return http.get(`/api/playlists/${encodeURIComponent(id)}`);
}

export function updatePlaylist(
  id: string,
  patch: { name?: string; description?: string; coverUrl?: string; sort?: number }
): Promise<{ playlist: UserPlaylist }> {
  return http.patch(`/api/playlists/${encodeURIComponent(id)}`, patch);
}

export function deletePlaylist(id: string): Promise<{ ok: boolean }> {
  return http.delete(`/api/playlists/${encodeURIComponent(id)}`);
}

export function addPlaylistTracks(
  id: string,
  trackIds: string[],
  tracks?: Track[]
): Promise<{ ok: boolean; added: number }> {
  return http.post(`/api/playlists/${encodeURIComponent(id)}/tracks`, {
    trackIds,
    tracks,
  });
}

export function removePlaylistItem(
  playlistId: string,
  itemId: string
): Promise<{ ok: boolean }> {
  return http.delete(
    `/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(itemId)}`
  );
}

/** 重排曲目。`itemIds` 必须覆盖歌单全部条目，否则服务端会拒绝 */
export function reorderPlaylist(
  id: string,
  itemIds: string[]
): Promise<{ ok: boolean }> {
  return http.put(`/api/playlists/${encodeURIComponent(id)}/order`, { itemIds });
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

/** 导出当前用户的收藏歌单与用户画像备份（.sm 归档二进制流） */
export function exportSmBackup(): Promise<Blob> {
  return requestBlob('/api/favorites/export');
}

/** 预检 .sm 备份文件（查看曲目数与画像摘要） */
export function previewSmBackup(data: string): Promise<SmPreviewResult> {
  return http.post('/api/favorites/preview-sm', { data }, { timeoutMs: 30_000 });
}

/** 恢复 .sm 备份文件（传入 base64 字符串，可选择是否恢复音乐画像） */
export function importSmBackup(data: string, importPersona = false): Promise<SmImportResult> {
  return http.post('/api/favorites/import-sm', { data, importPersona }, { timeoutMs: 120_000 });
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

/** 预检重复曲目（按歌名+主歌手分组） */
export function previewFavoritesDedup(): Promise<FavoritesDedupPreviewResult> {
  return http.post('/api/favorites/dedup/preview', {});
}

/** 执行去重清理（保留最早收藏的版本） */
export function executeFavoritesDedup(): Promise<FavoritesDedupResult> {
  return http.post('/api/favorites/dedup', {});
}

