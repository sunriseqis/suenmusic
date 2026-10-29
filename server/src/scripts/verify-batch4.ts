/**
 * 修复批 4（P2-A 打标循环 / P2-B 缓存 LRU）实测脚本。
 *
 * 用法：node src/scripts/verify-batch4.ts
 *
 * **全程在 /tmp 临时库跑**：不碰线上库、不联网、不调 AI。
 * P2-A 用的是**启发式打标（零网络零 token）**，跑几千首也不烧钱。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = '/tmp/suenmusic-verify-batch4';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
process.env.SUENMUSIC_DB = dir + '/sandbox.db';

const { openDatabase, migrate, getDatabase } = await import('../db/index.ts');
const { syncLibraryTrackTags, SYNC_TAG_MAX_ROUNDS } = await import('../services/ai-tags.ts');
const { albumCacheSizes, latestAlbumSongsOf } = await import('../services/ai-recall.ts');
const { lruGet, lruSet } = await import('../utils/lru.ts');

const results: string[] = [];
const check = (name: string, pass: boolean, detail: string): void => {
  results.push((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
};

openDatabase();
migrate(getDatabase());

// ---------------- P2-A：syncLibraryTrackTags 循环打完存量 ----------------
function seedUntagged(prefix: string, n: number): void {
  const db = getDatabase();
  const ins = db.prepare(
    'INSERT INTO library_tracks (id, artist_mid, payload_json, added_at) VALUES (?, ?, ?, ?)'
  );
  const ts = Date.now();
  db.exec('BEGIN');
  try {
    for (let i = 0; i < n; i += 1) {
      const id = prefix + '_' + i;
      ins.run(
        id,
        'qq_ar_seed',
        JSON.stringify({ id, name: prefix + ' 测试曲目 ' + i, ar: [{ name: '测试歌手' }], al: { name: '测试专辑' }, duration: 200 }),
        ts
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
const untaggedCount = (): number =>
  Number(
    (
      getDatabase()
        .prepare(
          'SELECT COUNT(*) AS n FROM library_tracks lt LEFT JOIN track_tags g ON g.track_id = lt.id WHERE g.track_id IS NULL'
        )
        .get() as { n?: number }
    )?.n ?? 0
  );

// ① 存量 1200 首 > 单批 200 首：循环应把 1200 首全部打完
seedUntagged('kg_a', 1200);
const beforeA = untaggedCount();
const t0 = Date.now();
const totalA = syncLibraryTrackTags(200);
const msA = Date.now() - t0;
const afterA = untaggedCount();
check(
  'P2-A 循环打完存量（1200 首 / 单批 200）',
  totalA === 1200 && afterA === 0,
  '打标 ' + totalA + ' 首（旧实现只会打 200）· 剩余未打标 ' + beforeA + '→' + afterA +
    ' · 推断轮数 ' + Math.ceil(totalA / 200) + ' 轮 + 1 轮空转确认 · 耗时 ' + msA + 'ms'
);

// ② 上限保护：maxRounds=2、单批 200 → 最多 400 首，剩下的留给下次
seedUntagged('kg_b', 500);
const capped = syncLibraryTrackTags(200, 2);
const afterCap = untaggedCount();
check(
  'P2-A 上限保护（maxRounds=2 × 200 = 400 封顶）',
  capped === 400 && afterCap === 100,
  '本次打标 ' + capped + ' 首 · 剩余 ' + afterCap + ' 首（SYNC_TAG_MAX_ROUNDS=' + SYNC_TAG_MAX_ROUNDS + ' 为日常默认）'
);

// ③ 幂等 + 追平：再跑两次把剩下 100 首打完，第三次应为 0（不重复打标）
const second = syncLibraryTrackTags(200, 2);
const third = syncLibraryTrackTags(200, 2);
check(
  'P2-A 幂等收尾（剩余 100 → 0，再跑返回 0）',
  second === 100 && third === 0 && untaggedCount() === 0,
  '第二次 ' + second + ' 首 · 第三次 ' + third + ' 首 · 剩余 ' + untaggedCount() + ' 首'
);

// ---------------- P2-B：LRU 淘汰 ----------------
// ① 纯 helper：上限 3，写 4 条 → 最旧的被淘汰
const m = new Map<string, number>();
lruSet(m, 'a', 1, 3);
lruSet(m, 'b', 2, 3);
lruSet(m, 'c', 3, 3);
lruSet(m, 'd', 4, 3);
const helperEvicted = !m.has('a') && m.has('b') && m.has('c') && m.has('d') && m.size === 3;
const keysAfter4 = JSON.stringify([...m.keys()]);
// ② 命中刷新顺序：读 b 后写 e → 淘汰的是 c（b 已刷新到队尾）
lruGet(m, 'b');
lruSet(m, 'e', 5, 3);
check(
  'P2-B LRU 淘汰最旧 + 命中刷新',
  helperEvicted && !m.has('c') && m.has('b') && m.has('e') && m.size === 3,
  '写入 4 条后=' + keysAfter4 + ' · 读 b（刷新到队尾）再写 e 后=' + JSON.stringify([...m.keys()]) + '（淘汰 c）'
);

// ③ 真实缓存（latestAlbumCache）：灌入 cap+5 个歌手，条目数应封顶
const caps = albumCacheSizes().caps;
let gateCalls = 0;
const probe = {
  listAlbums: async (seed: { name: string; mid: string }) =>
    [{ id: 'alb_' + seed.mid, mid: 'alb_' + seed.mid, name: '测试专辑 ' + seed.mid, size: 8, publishTime: '2026-10-01' }] as any[],
  loadSongs: async (albumMid: string) =>
    [{ id: 't_' + albumMid, name: '曲目 ' + albumMid, ar: [{ name: '测试歌手' }] }] as any[],
  gate: async () => {
    gateCalls += 1;
    return true;
  },
};
const N = caps.latest + 5;
for (let i = 0; i < N; i += 1) {
  await latestAlbumSongsOf(1, { name: 'S' + i, mid: 'mid_' + i }, 5, probe);
}
const sizesAfter = albumCacheSizes();
check(
  'P2-B latestAlbumCache 条目数封顶（灌 ' + N + ' 个歌手，上限 ' + caps.latest + '）',
  sizesAfter.latest === caps.latest,
  '灌入 ' + N + ' 个 key → 实际条目 ' + sizesAfter.latest + '（旧实现会是 ' + N + '）· gate 调用 ' + gateCalls
);
// ④ 淘汰证据：最早写进去的 mid_0 已被淘汰（要重新打上游 = gate 被调用）；
//    最后写进去的 mid_(N-1) 还在（fresh → 不打 gate）
const g0 = gateCalls;
await latestAlbumSongsOf(1, { name: 'S0', mid: 'mid_0' }, 5, probe);
const evictedReFetched = gateCalls === g0 + 1;
const g1 = gateCalls;
await latestAlbumSongsOf(1, { name: 'S' + (N - 1), mid: 'mid_' + (N - 1) }, 5, probe);
check(
  'P2-B 最早条目被淘汰、最新条目仍命中',
  evictedReFetched && gateCalls === g1,
  'mid_0 重新打上游 gate ' + g0 + '→' + gateCalls + ' · mid_' + (N - 1) + ' 命中不打 gate（' + g1 + '→' + gateCalls + '）'
);

// ⑤ 另外两张缓存走同一条 LRU 通道（静态核验：detail/list 都要真取上游，沙箱里打不到）
const src = readFileSync(fileURLToPath(new URL('../services/ai-recall.ts', import.meta.url)), 'utf8');
const detailWired =
  /lruGet\(latestAlbumDetailCache, mid\)/.test(src) &&
  /lruSet\(latestAlbumDetailCache, mid,[\s\S]{0,120}LATEST_ALBUM_DETAIL_CACHE_MAX\)/.test(src);
const listWired =
  /lruGet\(latestAlbumListCache, seed\.mid\)/.test(src) &&
  /lruSet\(latestAlbumListCache, seed\.mid,[\s\S]{0,120}LATEST_ALBUM_LIST_CACHE_MAX\)/.test(src);
check(
  'P2-B detail/list 两张缓存同样走 lruGet/lruSet（静态核验）',
  detailWired && listWired,
  'detail=' + detailWired + ' list=' + listWired + ' · 上限 detail ' + caps.detail + ' / list ' + caps.list
);

console.log(results.join('\n'));
console.log('SUMMARY ' + results.filter(r => r.startsWith('PASS')).length + '/' + results.length + ' passed');
process.exit(results.every(r => r.startsWith('PASS')) ? 0 : 1);
