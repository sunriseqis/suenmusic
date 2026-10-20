/**
 * 收藏去重：调用服务端 `/api/favorites/dedup`。
 *
 * 判定口径（服务端统一）：**歌名 + 主歌手**完全相同视为重复，
 * 保留最早收藏的那条，其余删除。
 */
import { http } from '@/api/client.ts';

export interface DupGroup {
  key: string;
  name: string;
  artist: string;
  keepId: string;
  removeIds: string[];
}

export async function previewDedupe(): Promise<{ groups: DupGroup[]; duplicateCount: number }> {
  const res = await http.post<{
    ok: boolean;
    duplicateCount: number;
    groups: DupGroup[];
  }>('/api/favorites/dedup/preview');
  return {
    groups: res.groups ?? [],
    duplicateCount: res.duplicateCount ?? 0,
  };
}

export async function applyDedupe(_groups?: DupGroup[]): Promise<number> {
  const res = await http.post<{
    ok: boolean;
    removedCount: number;
  }>('/api/favorites/dedup');
  return res.removedCount ?? 0;
}
