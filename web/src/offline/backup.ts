/**
 * 收藏列表导出 / 导入（纯 JSON 快照）。
 *
 * 只装收藏曲目：**不装账号、WebDAV 凭据、锚点、主题**。
 *   · 凭据属于服务端配置（`server/src/routes/backup.ts`，浏览器直连 WebDAV 那条路撞
 *     CORS 已作废，浏览器端的 WebDAV 模块已整体删除）；
 *   · 锚点/主题是设备本地状态，混进"数据备份"会让用户以为换机后能一键带走。
 *
 * 整库的加密备份（`.sm`）在服务端，走 `api/backup.ts`；这里只负责收藏这一层。
 */
import type { Track } from '@/api/types.ts';
import { downloadBlob, type DownloadResult } from '@/utils/download.ts';
import { fetchFavoriteTracks, batchAddFavorites } from '@/api/library.ts';

export interface FavoritesBackup {
  version: 1;
  app: 'suenmusic';
  type: 'favorites_backup';
  exportedAt: string;
  total: number;
  tracks: Track[];
}

export async function buildBackup(): Promise<FavoritesBackup> {
  let tracks: Track[] = [];
  try {
    const res = await fetchFavoriteTracks();
    tracks = res.tracks ?? [];
  } catch {
    tracks = [];
  }

  return {
    version: 1,
    app: 'suenmusic',
    type: 'favorites_backup',
    exportedAt: new Date().toISOString(),
    total: tracks.length,
    tracks,
  };
}

/**
 * 导出收藏 JSON。
 *
 * **必须走 `downloadBlob`**：安卓壳里 `blob:` + `<a download>` 不会触发系统下载，
 * 同仓为此专门写了 `SuenNativeBackup` 桥（MediaStore 落到 Downloads/SuenMusic）。
 *
 * @returns `'native'` = 已存进系统下载目录；`'browser'` = 已交给浏览器下载
 */
export async function downloadBackup(backup: FavoritesBackup): Promise<DownloadResult> {
  const name = `suenmusic_favorites_${backup.exportedAt.slice(0, 10)}.json`;
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
}

/** 增量导入收藏：重复的由服务端跳过 */
export async function applyBackup(text: string): Promise<ImportResult> {
  let data: Partial<FavoritesBackup>;
  try {
    data = JSON.parse(text) as Partial<FavoritesBackup>;
  } catch {
    throw new Error('不是有效的收藏备份文件');
  }
  if (!data || data.type !== 'favorites_backup' || !Array.isArray(data.tracks)) {
    throw new Error('备份结构不正确（缺少 tracks）');
  }

  if (data.tracks.length === 0) return { added: 0, skipped: 0 };

  // 不再吞异常：备份恢复是「数据兜底」路径，静默变成 0 首比直接报错危险得多
  //（用户会以为库里本来就有，换机时才发现备份没生效）。
  // 分片提交由 api/library.ts 的 batchAddFavorites 负责。
  const res = await batchAddFavorites(data.tracks);
  const added = res.added ?? 0;
  return { added, skipped: Math.max(0, data.tracks.length - added) };
}
