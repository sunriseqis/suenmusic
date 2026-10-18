/**
 * 本机备份：导出 / 导入 `.sm`（JSON 快照）。
 *
 * 与服务端无关 —— 服务端挂了，本机数据还是本机数据；任何手段（文件、WebDAV）
 * 只要能把这个 JSON 还原回来就能用。备份范围：收藏、不喜欢、锚点、主题。
 *
 * 格式与服务端导出的 `.sm` 内层结构对齐（`type: 'favorites_backup'`），
 * 多出的 dislikes / anchors / settings 字段旧版本会忽略。
 */
import type { Track } from '@/api/types.ts';
import {
  listDislikes,
  listFavorites,
  saveDislike,
  saveFavorite,
  type LocalDislike,
} from './localdb.ts';
import { getLocalAnchor, setLocalAnchor } from '@/api/direct/anchor.ts';
import { loadWebdav, saveWebdav, type WebdavConfig } from './webdav.ts';

const ANCHORS_KEY = 'suenmusic.anchors';
const THEME_KEY = 'suenmusic.theme';

export interface SmBackup {
  version: 1;
  app: 'suenmusic';
  type: 'favorites_backup';
  exportedAt: string;
  total: number;
  tracks: Track[];
  dislikes: LocalDislike[];
  anchors: Record<string, unknown>;
  /** 设备级偏好（主题等）。换设备时一起带走 */
  settings: { theme?: string };
  /** WebDAV 凭据：备份文件自包含，换机后直接能继续用同一个盘 */
  webdav?: WebdavConfig;
}

export async function buildBackup(): Promise<SmBackup> {
  const rows = await listFavorites();
  rows.sort((a, b) => a.addedAt - b.addedAt);
  const tracks = rows.map(r => r.track).filter((t): t is Track => !!t);
  const dislikes = await listDislikes();

  let anchors: Record<string, unknown> = {};
  try {
    anchors = JSON.parse(localStorage.getItem(ANCHORS_KEY) || '{}') as Record<string, unknown>;
  } catch {
    anchors = {};
  }

  let theme: string | undefined;
  try {
    theme = localStorage.getItem(THEME_KEY) || undefined;
  } catch {
    theme = undefined;
  }

  return {
    version: 1,
    app: 'suenmusic',
    type: 'favorites_backup',
    exportedAt: new Date().toISOString(),
    total: tracks.length,
    tracks,
    dislikes,
    anchors,
    settings: { theme },
    webdav: loadWebdav(),
  };
}

/** 触发浏览器/WebView 下载。原生端会走系统下载器 */
export function downloadBackup(backup: SmBackup): void {
  const name = `suenmusic_backup_${backup.exportedAt.slice(0, 10)}.sm`;
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export interface ImportResult {
  added: number;
  skipped: number;
  dislikes: number;
  anchors: number;
}

/**
 * 导入：合并而不是覆盖。
 * 已存在的收藏会被跳过（`saveFavorite` 以 id 为主键，重复写不会产生副本）。
 */
export async function applyBackup(text: string): Promise<ImportResult> {
  let data: Partial<SmBackup>;
  try {
    data = JSON.parse(text) as Partial<SmBackup>;
  } catch {
    throw new Error('不是有效的备份文件');
  }
  if (!data || data.type !== 'favorites_backup' || !Array.isArray(data.tracks)) {
    throw new Error('备份结构不正确（缺少 tracks）');
  }

  const existing = new Set((await listFavorites()).map(r => r.id));
  let added = 0;
  let skipped = 0;
  for (const t of data.tracks) {
    if (!t || typeof t.id !== 'string') continue;
    if (existing.has(t.id)) {
      skipped += 1;
      continue;
    }
    await saveFavorite(t);
    added += 1;
  }

  let dislikes = 0;
  for (const d of data.dislikes ?? []) {
    if (!d || (d.type !== 'track' && d.type !== 'artist') || !d.id) continue;
    await saveDislike(d.type, d.id, d.name ?? '');
    dislikes += 1;
  }

  let anchors = 0;
  for (const [trackId, a] of Object.entries(data.anchors ?? {})) {
    const rec = a as { bvid?: string; title?: string; author?: string; durationSec?: number };
    if (!rec?.bvid) continue;
    if (getLocalAnchor(trackId)) {
      skipped += 1;
      continue;
    }
    setLocalAnchor(trackId, {
      bvid: rec.bvid,
      title: rec.title ?? '',
      author: rec.author ?? '',
      durationSec: rec.durationSec ?? 0,
    });
    anchors += 1;
  }

  if (data.settings?.theme) {
    try {
      localStorage.setItem(THEME_KEY, data.settings.theme);
    } catch {
      /* 写不进去不阻断导入 */
    }
  }

  // WebDAV 凭据随备份恢复：备份文件自包含，换机后不用重填
  if (data.webdav?.url) {
    saveWebdav({
      url: data.webdav.url,
      user: data.webdav.user ?? '',
      pass: data.webdav.pass ?? '',
    });
  }

  return { added, skipped, dislikes, anchors };
}
