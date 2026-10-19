/**
 * 相似歌手发散预览（诊断工具）。
 *
 * 用途：肉眼看"种子歌手 → 网易云相似歌手"这一步会飘到哪里 ——
 * 每个种子打印它的相似歌手名单 + 我们库里是否已经有这位歌手/多少首歌，
 * 用来判断发散质量（是否跑题、是否全是同质名字）。
 *
 * 用法：
 *   npm run simi:preview -- 五月天 周杰伦
 *   npm run simi:preview -- 五月天 周杰伦 陶喆 王力宏 --songs
 *
 * 只读：不写库、不入队（除了网易云/QQ 的只读查询）。
 */
import { getDatabase } from '../db/index.ts';
import { netease, neteaseRequest } from '../sources/netease/vendor.ts';

const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

interface SimiArtist {
  name: string;
  /** 我们曲库里是否有这位歌手（按名字匹配，无则 null） */
  libMid: string | null;
  libTracks: number;
  /** 抽 2 首库里的代表作，方便判断风格是否跑题 */
  samples: string[];
}

async function neteaseArtistIdOf(name: string): Promise<number | null> {
  const res = await netease.search({ keywords: name, type: 100, limit: 5 }, neteaseRequest);
  const artists = ((res?.body as any)?.result?.artists ?? []) as Array<{ id: number; name: string }>;
  const hit = artists.find(a => norm(a.name) === norm(name));
  return hit ? Number(hit.id) : null;
}

async function simiArtists(neteaseId: number): Promise<string[]> {
  const res = await netease.simiArtist({ id: neteaseId }, neteaseRequest);
  const artists = ((res?.body as any)?.artists ?? []) as Array<{ name?: string }>;
  return artists.map(a => String(a?.name ?? '')).filter(Boolean);
}

function libInfo(name: string, withSongs: boolean): { mid: string | null; count: number; samples: string[] } {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT a.mid AS mid, COUNT(t.id) AS cnt
         FROM library_artists a
         LEFT JOIN library_tracks t ON t.artist_mid = a.mid
        WHERE a.name = ?
        GROUP BY a.mid`
    )
    .get(name) as { mid: string; cnt: number } | undefined;
  if (!row) return { mid: null, count: 0, samples: [] };
  const samples = withSongs
    ? (db
        .prepare(
          `SELECT json_extract(payload_json, '$.name') AS name
             FROM library_tracks WHERE artist_mid = ? LIMIT 3`
        )
        .all(row.mid) as Array<{ name: string }>).map(r => r.name)
    : [];
  return { mid: row.mid, count: Number(row.cnt), samples };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const withSongs = args.includes('--songs');
  const names = args.filter(a => !a.startsWith('--'));
  if (names.length === 0) {
    console.error('用法：npm run simi:preview -- 五月天 周杰伦 [--songs]');
    process.exit(1);
  }

  for (const name of names) {
    const id = await neteaseArtistIdOf(name);
    if (!id) {
      console.log(`\n【${name}】网易云歌手 id 未命中 —— 这一环就会断（无法发散）`);
      continue;
    }
    const simi = await simiArtists(id);
    const self = libInfo(name, false);
    console.log(
      `\n【${name}】(netease id=${id}) 相似歌手 ${simi.length} 位；本尊库里 ${self.count} 首`
    );
    const rows: SimiArtist[] = simi.map(n => {
      const info = libInfo(n, withSongs);
      return { name: n, libMid: info.mid, libTracks: info.count, samples: info.samples };
    });
    rows.forEach((r, i) => {
      const mark = r.libMid ? `库✓ ${r.libTracks}首` : '库✗';
      const tail = withSongs && r.samples.length > 0 ? `  例：${r.samples.join(' / ')}` : '';
      console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(22, '　')} ${mark}${tail}`);
    });
  }
  process.exit(0);
}

void main();
