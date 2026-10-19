/**
 * 每日推荐溯源（诊断工具）：当前歌单里每一首是从哪来的。
 *
 * 回答三类问题：
 *   1. 这首歌属于哪位种子（本尊 / 某位种子的相似歌手 / 榜单探索位 / 来源不明）；
 *   2. 是不是用户收藏里已有的歌（去重是否生效）；
 *   3. 库里有没有这位歌手（没有的话它是怎么进来的）。
 *
 * 用法：
 *   npm run daily:explain                 # 解释 admin(1) 当天缓存的歌单
 *   npm run daily:explain -- 5            # 指定用户
 *   npm run daily:explain -- 1 --json /tmp/daily.json   # 解释指定文件
 */
import { readFileSync } from 'node:fs';
import { getDatabase } from '../db/index.ts';
import { getLibraryTracks } from '../db/repo/library.ts';
import { netease, neteaseRequest } from '../sources/netease/vendor.ts';
import { getToplistDetail } from '../sources/qq/home.ts';
import type { Track } from '../sources/qq/adapter.ts';

const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

const CHART_TOPLIST_IDS = [62, 26, 27, 4];
const CHART_TOP_N = 10;

async function neteaseArtistIdOf(name: string): Promise<number | null> {
  try {
    const res = await netease.search({ keywords: name, type: 100, limit: 5 }, neteaseRequest);
    const artists = ((res?.body as any)?.result?.artists ?? []) as Array<{ id: number; name: string }>;
    const hit = artists.find(a => norm(a.name) === norm(name));
    return hit ? Number(hit.id) : null;
  } catch {
    return null;
  }
}

async function simiNames(name: string): Promise<string[]> {
  try {
    const id = await neteaseArtistIdOf(name);
    if (!id) return [];
    const res = await netease.simiArtist({ id }, neteaseRequest);
    return (((res?.body as any)?.artists ?? []) as Array<{ name?: string }>)
      .map(a => String(a?.name ?? ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

interface Seed {
  mid: string;
  name: string;
  hits: number;
}

function collectSeeds(userId: number): Seed[] {
  return getDatabase()
    // ⚠️ 必须按表达式分组：`GROUP BY name` 会撞上 tracks.name（歌名），
    // 结果按歌名聚合，种子统计全乱（实测踩过：五月天 31 首变成 2 首）
    .prepare(
      `SELECT artist_name AS name, COUNT(DISTINCT track_id) AS hits FROM (
         SELECT json_extract(je.value, '$.name') AS artist_name, f.track_id AS track_id
           FROM favorites f JOIN tracks t ON t.id = f.track_id, json_each(t.artists_json) je
          WHERE f.user_id = ? AND json_extract(je.value, '$.name') != ''
       ) GROUP BY artist_name ORDER BY hits DESC LIMIT 20`
    )
    .all(userId) as unknown as Seed[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const userId = Number(args.find(a => /^\d+$/.test(a)) ?? 1);
  const jsonIdx = args.indexOf('--json');
  const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

  // ---- 歌单来源：文件或当天缓存 ----
  let tracks: Track[];
  if (jsonPath) {
    tracks = (JSON.parse(readFileSync(jsonPath, 'utf8')) as { tracks: Track[] }).tracks ?? [];
  } else {
    const row = getDatabase()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(`recommend_daily:${userId}`) as { value: string } | undefined;
    tracks = row ? ((JSON.parse(row.value) as { tracks: Track[] }).tracks ?? []) : [];
  }
  if (tracks.length === 0) {
    console.log('没有可解释的歌单（缓存为空）');
    process.exit(0);
  }

  // ---- 种子 + 名单 + 收藏 + 榜单 ----
  const seeds = collectSeeds(userId).filter(s => s.name);
  const favIds = new Set(
    (getDatabase()
      .prepare('SELECT track_id FROM favorites WHERE user_id = ?')
      .all(userId) as unknown as Array<{ track_id: string }>).map(r => r.track_id)
  );
  const seedByName = new Map(seeds.map(s => [norm(s.name), s]));
  /**
   * 归属优先查**库里的链接**（library_user_artists.origin = `seed:X` / `near:Y`），
   * 这是生成时写下的真实来源、零网络请求；网易云名单只作为兜底
   * （实测：依赖网易云接口时一旦被限流，所有归属都变成"不明"）。
   */
  const originByMid = new Map<string, string>();
  const originByName = new Map<string, string>();
  const linkRows = getDatabase()
    .prepare(
      `SELECT l.origin, a.mid, a.name
         FROM library_user_artists l JOIN library_artists a ON a.mid = l.artist_mid
        WHERE l.user_id = ?`
    )
    .all(userId) as unknown as Array<{ origin: string; mid: string; name: string }>;
  for (const r of linkRows) {
    // ⚠️ origin 里的名字是"它从哪个种子发散出来的"，**不等于**这位歌手就是那个种子：
    //    seed:X + 歌手名就是 X  → 本尊（X 自己的歌）
    //    seed:X / near:X 其余   → 相似歌手（X 的邻域）
    const from = r.origin.slice(r.origin.indexOf(':') + 1);
    const isSelf = r.origin.startsWith('seed:') && norm(r.name) === norm(from);
    originByMid.set(
      r.mid,
      isSelf ? `本尊：${from}` : `相似歌手：${from} 的邻域`
    );
    originByName.set(norm(r.name), originByMid.get(r.mid) ?? '');
  }
  const simiCache = new Map<string, Set<string>>();
  for (const s of seeds) {
    simiCache.set(s.name, new Set((await simiNames(s.name)).map(norm)));
  }
  const chartIds = new Set<string>();
  for (const id of CHART_TOPLIST_IDS) {
    try {
      const d = await getToplistDetail(id, 0, CHART_TOP_N);
      for (const t of d.tracks) chartIds.add(t.id);
    } catch {
      /* 忽略 */
    }
  }

  const libTracks = getLibraryTracks(
    (
      getDatabase().prepare('SELECT DISTINCT artist_mid FROM library_tracks').all() as unknown as Array<{
        artist_mid: string;
      }>
    ).map(r => r.artist_mid)
  );
  const inLibrary = new Set(libTracks.map(t => t.id));

  console.log(`\n用户 ${userId} 的当日歌单溯源（${tracks.length} 首）\n`);
  console.log(' #  歌名                          歌手                来源');
  console.log('─'.repeat(96));
  const summary = { seed: 0, near: 0, chart: 0, unknown: 0, dupFav: 0 };
  tracks.forEach((t, i) => {
    const artists = (t.ar ?? []).map(a => String(a?.name ?? ''));
    let source = '？';
    const ownNomatch: string[] = [];
    for (const a of artists) {
      const s = seedByName.get(norm(a));
      if (s) {
        source = `本尊：${s.name}（收藏 ${s.hits} 首）`;
        summary.seed += 1;
        break;
      }
    }
    if (source === '？') {
      // 1) 库里记录的来源（生成时写入，权威且离线可查）
      const libOrigin =
        originByMid.get(String(t.ar?.[0]?.mid ?? '')) ?? originByName.get(norm(artists[0] ?? ''));
      if (libOrigin) {
        source = libOrigin;
        summary.near += 1;
      } else {
        // 2) 兜底：网易云相似歌手名单（可能被限流）
        let best: { seed: string; hits: number } | null = null;
        for (const s of seeds) {
          if (simiCache.get(s.name)?.has(norm(artists[0] ?? ''))) {
            if (!best || s.hits > best.hits) best = { seed: s.name, hits: s.hits };
          }
        }
        if (best) {
          source = `相似歌手：${best.seed} 的邻域`;
          summary.near += 1;
        } else if (chartIds.has(t.id)) {
          source = '榜单探索位';
          summary.chart += 1;
        } else {
          source = '来源不明（不在任何种子的名单里）';
          ownNomatch.push(artists.join('/'));
          summary.unknown += 1;
        }
      }
    }
    const dup = favIds.has(t.id) ? '  ⚠️ 已在收藏里' : '';
    if (favIds.has(t.id)) summary.dupFav += 1;
    const mark = inLibrary.has(t.id) ? '' : ' (库✗)';
    console.log(
      `${String(i + 1).padStart(2)}  ${String(t.name ?? '?').slice(0, 28).padEnd(30, ' ')} ` +
        `${artists.join('、').slice(0, 18).padEnd(20, ' ')} ${source}${mark}${dup}`
    );
  });
  console.log('─'.repeat(96));
  console.log(
    `本尊 ${summary.seed} · 相似歌手 ${summary.near} · 榜单 ${summary.chart} · ` +
      `不明 ${summary.unknown} · 与收藏重复 ${summary.dupFav}`
  );
  process.exit(0);
}

void main();
