/**
 * 本机收藏去重。
 *
 * 与服务端无关：收藏本来就存在本地（IndexedDB），去重只是把同名的多条合并。
 * 判定口径：**歌名 + 歌手集合**完全相同视为重复，保留最早收藏的那条，
 * 其余删除 —— 与旧服务端实现一致，避免"同一首歌两个版本被误删"。
 */
import { listFavorites, removeFavorite, type LocalFavorite } from './localdb.ts';

export interface DupGroup {
  key: string;
  name: string;
  artist: string;
  keepId: string;
  removeIds: string[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '');
}

function keyOf(row: LocalFavorite): string {
  const t = row.track;
  if (!t) return row.id;
  const name = normalize(t.name || '');
  const artist = (t.ar ?? [])
    .map(a => normalize(a.name || ''))
    .filter(Boolean)
    .sort()
    .join('/');
  return `${name}|${artist}`;
}

export async function previewDedupe(): Promise<{ groups: DupGroup[]; duplicateCount: number }> {
  const rows = await listFavorites();
  // 早收藏的排前面：保留最早那条
  rows.sort((a, b) => a.addedAt - b.addedAt);

  const buckets = new Map<string, LocalFavorite[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const arr = buckets.get(k);
    if (arr) arr.push(r);
    else buckets.set(k, [r]);
  }

  const groups: DupGroup[] = [];
  let duplicateCount = 0;
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    const keep = list[0]!;
    const removeIds = list.slice(1).map(x => x.id);
    duplicateCount += removeIds.length;
    groups.push({
      key,
      name: keep.track?.name || keep.id,
      artist: (keep.track?.ar ?? []).map(a => a.name).join('/'),
      keepId: keep.id,
      removeIds,
    });
  }
  return { groups, duplicateCount };
}

export async function applyDedupe(groups: DupGroup[]): Promise<number> {
  let removed = 0;
  for (const g of groups) {
    for (const id of g.removeIds) {
      await removeFavorite(id);
      removed += 1;
    }
  }
  return removed;
}
