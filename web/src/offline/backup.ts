/**
 * 本机备份：导出 / 导入 `.sm`（JSON 快照）。
 *
 * 与服务端真相源对齐：导出时从服务端获取最新收藏列表与不喜欢列表，
 * 导入时批量回写至服务端。备份范围：收藏、不喜欢、锚点、主题。
 */
import type { Track } from '@/api/types.ts';
import { downloadBlob, type DownloadResult } from '@/utils/download.ts';
import { fetchFavoriteTracks, batchAddFavorites } from '@/api/library.ts';
import { fetchDislikes, addDislike, type DislikeItem } from '@/api/recommend.ts';
import { anchorTrack } from '@/api/playback.ts';
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
  dislikes: DislikeItem[];
  anchors: Record<string, unknown>;
  /** 设备级偏好（主题等）。换设备时一起带走 */
  settings: { theme?: string };
  /** WebDAV 凭据：备份文件自包含，换机后直接能继续用同一个盘 */
  webdav?: WebdavConfig;
}

export async function buildBackup(): Promise<SmBackup> {
  let tracks: Track[] = [];
  try {
    const res = await fetchFavoriteTracks();
    tracks = res.tracks ?? [];
  } catch {
    tracks = [];
  }

  let dislikes: DislikeItem[] = [];
  try {
    const res = await fetchDislikes();
    dislikes = res.dislikes ?? [];
  } catch {
    dislikes = [];
  }

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

/**
 * 导出 .sm 备份。
 *
 * **必须走 `downloadBlob`**：安卓壳里 `blob:` + `<a download>` 不会触发系统下载，
 * 同仓为此专门写了 `SuenNativeBackup` 桥（MediaStore 落到 Downloads/SuenMusic）。
 * 之前这里自己拼 `<a download>` —— 壳里点「导出」什么都没生成，界面却报「已导出」，
 * 换机时才发现备份不存在。
 *
 * @returns `'native'` = 已存进系统下载目录；`'browser'` = 已交给浏览器下载
 */
export async function downloadBackup(backup: SmBackup): Promise<DownloadResult> {
  const name = `suenmusic_backup_${backup.exportedAt.slice(0, 10)}.sm`;
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const result = await downloadBlob(blob, name);
  if (result === 'failed') {
    throw new Error('导出失败：系统没有保存文件（可改用 Web 面板导出）');
  }
  return result;
}

export interface ImportResult {
  added: number;
  skipped: number;
  dislikes: number;
  anchors: number;
}

/**
 * 导入备份至服务端。
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

  let added = 0;
  let skipped = 0;
  if (data.tracks.length > 0) {
    // 不再吞异常：备份恢复是「数据兜底」路径，静默变成 0 首比直接报错危险得多
    //（用户会以为库里本来就有，换机时才发现备份没生效）。
    // 分片提交由 api/library.ts 的 batchAddFavorites 负责。
    const res = await batchAddFavorites(data.tracks);
    added = res.added ?? 0;
    skipped = Math.max(0, data.tracks.length - added);
  }

  let dislikes = 0;
  for (const d of data.dislikes ?? []) {
    const targetId = (d as any).targetId || (d as any).id;
    if (!d || (d.type !== 'track' && d.type !== 'artist') || !targetId) continue;
    try {
      await addDislike(d.type, targetId, d.name ?? '');
      dislikes += 1;
    } catch {
      /* ignore */
    }
  }

  let currentAnchors: Record<string, unknown> = {};
  try {
    currentAnchors = JSON.parse(localStorage.getItem(ANCHORS_KEY) || '{}');
  } catch {
    currentAnchors = {};
  }
  let anchors = 0;
  for (const [trackId, a] of Object.entries(data.anchors ?? {})) {
    const rec = a as { bvid?: string; title?: string; author?: string; durationSec?: number };
    if (!rec?.bvid) continue;
    currentAnchors[trackId] = rec;
    anchors += 1;
    try {
      await anchorTrack(trackId, {
        bvid: rec.bvid,
        title: rec.title || '',
        author: rec.author || '',
        durationSec: rec.durationSec || 0,
      });
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.setItem(ANCHORS_KEY, JSON.stringify(currentAnchors));
  } catch {
    /* ignore */
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
