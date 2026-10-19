/**
 * 存量曲目元数据回填（按**歌手名**反查，一次性迁移，可中断可续跑）。
 *
 * ⚠️ 为什么不是"按歌曲 mid 拉单曲详情"：这批曲目多来自搜索召回行，其中不少
 * 在 QQ 上已经没有条目（详情接口返回空），但它们**仍然可播**（走网易云音源）。
 * 实测：`处处遗憾`、`爱是对的` 的 QQ 详情都是空的。
 * 所以歌手身份必须**按名字反查 QQ 歌手搜索**，而不是相信曲目自带的 mid。
 *
 * 走 QQ 歌手搜索分片（不是歌曲分片），逐名留间隔；中断后重跑自动跳过已修好的。
 *
 * 用法：
 *   npm run backfill:artists -- --limit 10     # 试跑 10 个歌手名
 *   npm run backfill:artists                    # 全量
 */
import { getDatabase } from '../db/index.ts';
import { fetchSearchSlice, qqCooldown } from '../sources/qq/search.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('backfill');

/** 每个歌手名之间的间隔 */
const GAP_MS = 1200;

const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

interface BrokenName {
  name: string;
  tracks: number;
}

/** 收集"歌手缺 mid"的**名字**（按名字聚合，一个名字只需查一次） */
function brokenArtistNames(limit: number): BrokenName[] {
  return (
    getDatabase()
      .prepare(
        `SELECT json_extract(je.value, '$.name') AS artist_name, COUNT(DISTINCT t.id) AS tracks
           FROM tracks t, json_each(t.artists_json) je
          WHERE json_extract(je.value, '$.mid') = ''
            AND json_extract(je.value, '$.name') != ''
          GROUP BY artist_name
          ORDER BY tracks DESC
          LIMIT ?`
      )
      .all(limit) as unknown as Array<{ artist_name: string; tracks: number }>
  ).map(r => ({ name: r.artist_name, tracks: r.tracks }));
}

/** 名字 → QQ 歌手 mid（要求规范化后完全相等，防止"周深/周深深"这类误配） */
async function lookupArtistMid(name: string): Promise<string | null> {
  const { list } = await fetchSearchSlice('singer', name, 0, 5);
  const hit = list.find((a: any) => norm(a?.singerName ?? a?.name) === norm(name));
  const mid = String(hit?.singerMID ?? hit?.mid ?? '');
  return mid || null;
}

/** 把这位歌手的 mid 补进所有相关曲目（只动缺 mid 的那一条艺术家记录） */
function fillArtistMid(name: string, mid: string): number {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, artists_json, payload_json FROM tracks t
        WHERE EXISTS (
              SELECT 1 FROM json_each(t.artists_json) je
               WHERE json_extract(je.value, '$.name') = ?
                 AND json_extract(je.value, '$.mid') = ''
            )`
    )
    .all(name) as Array<{ id: string; artists_json: string; payload_json: string }>;

  const update = db.prepare('UPDATE tracks SET artists_json = ?, payload_json = ? WHERE id = ?');
  let n = 0;
  for (const row of rows) {
    const patch = (list: any[]): void => {
      for (const a of list) {
        if (a && norm(a.name) === norm(name) && !a.mid) {
          a.mid = mid;
          a.id = `qq_ar_${mid}`;
        }
      }
    };
    try {
      const ar = JSON.parse(row.artists_json || '[]') as any[];
      patch(ar);
      const payload = JSON.parse(row.payload_json || '{}') as any;
      if (Array.isArray(payload.ar)) patch(payload.ar);
      if (Array.isArray(payload.artists)) patch(payload.artists);
      update.run(JSON.stringify(ar), JSON.stringify(payload), row.id);
      n += 1;
    } catch (err) {
      log.warn(`曲目 JSON 修补失败 ${row.id}: ${(err as Error)?.message ?? err}`);
    }
  }
  return n;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) || 20 : 500;

  const names = brokenArtistNames(limit);
  log.info(`待回填歌手 ${names.length} 位（合计 ${names.reduce((s, n) => s + n.tracks, 0)} 首曲目）`);
  let ok = 0;
  let miss = 0;

  for (const [i, item] of names.entries()) {
    // 搜索分片有 2001 风控：冷却中就先等一会儿，别硬撞
    if (qqCooldown.active()) {
      const wait = Math.min(qqCooldown.snapshot().remainingMs, 90_000);
      log.info(`QQ 搜索冷却中，等待 ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
    try {
      const mid = await lookupArtistMid(item.name);
      if (mid) {
        const n = fillArtistMid(item.name, mid);
        ok += 1;
        log.info(`✓ ${item.name} → ${mid}（补进 ${n} 首）`);
      } else {
        miss += 1;
        log.warn(`✗ ${item.name}：QQ 歌手搜索无精确匹配（该歌手不进种子）`);
      }
    } catch (err) {
      miss += 1;
      log.warn(`✗ ${item.name}: ${(err as Error)?.message ?? err}`);
    }
    if ((i + 1) % 10 === 0) log.info(`进度 ${i + 1}/${names.length}`);
    await sleep(GAP_MS);
  }

  log.info(`回填完成：成功 ${ok} 位，未命中 ${miss} 位`);
  process.exit(0);
}

void main();
