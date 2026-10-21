/**
 * 池子健康线与"按需补库"（用户拍板：不要常驻打转，但要**池子低于线就自动补**）。
 *
 * ## 为什么需要它
 *
 * 用户原话："池子少于多少后台自动去补，这也要考虑。**全靠 AI 驱动，可能好几天都需要
 * 触发补库行为**。" —— 也就是说：不能只等生成时才补（那样连着几天都出不满），
 * 也不能让后台无脑常驻跑（浪费上游配额）。
 *
 * 折中：**条件驱动的定时检查** —— 每 10 分钟只"看一眼"，哪个来源低于健康线就补哪一个，
 * 补到 1.5 倍就停；全部健康就什么都不做。
 *
 * ## 健康线怎么定
 *
 * 一次生成消耗约 30 首（相似歌手 15 / 网友歌单 7 / 本尊老歌 5 / 榜单 3），
 * 再加"7 天冻结"带来的滚动消耗。用户要求"**冗余大一点**"，所以按
 * "两周的量 × 2 倍余量"设线，避免天天补。
 */
import { buildCandidatePool } from './ai-recall.ts';
import { setSetting } from '../db/repo/settings.ts';
import { qqCooldown } from '../sources/qq/search.ts';
import { refillPlaylistPool, buildStyleProfile } from './playlist-pool.ts';
import { getSimilarArtists } from './similar-artists.ts';
import { enqueueBuildJob } from '../db/repo/library.ts';
import { isNightIdleWindow, kickLibraryBuilder } from './library-builder.ts';
import { getDatabase } from '../db/index.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('library-topup');

/** 各来源的基准健康线（上限冗余）。低于它 → 只补这一个，补到 1.5 倍 */
export const POOL_FLOOR = { simi: 300, playlist: 150, seedOld: 120, chart: 60 } as const;

/** 全局相似歌手发散预算：无论有多少位种子，单次补库总探索目标不超过此预算，杜绝乘法爆炸 */
export const GLOBAL_SIMI_BUDGET = 25;

/** 补到健康线的几倍停手 */
const REFILL_TO = 1.5;

export interface TopUpReport {
  source: keyof typeof POOL_FLOOR;
  before: number;
  action: string;
}

/** 获取系统中活跃/有收藏的用户 ID 列表（用于多用户轮询调度） */
export function getActiveUserIds(): number[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT DISTINCT user_id FROM favorites
       UNION
       SELECT id AS user_id FROM users`
    )
    .all() as Array<{ user_id: number }>;
  const ids = rows.map(r => Number(r.user_id)).filter(n => Number.isFinite(n) && n > 0);
  return ids.length > 0 ? ids : [1];
}

/** 收藏歌手（种子） */
export function seeds(userId: number, limit = 20): Array<{ name: string; mid: string }> {
  return (
    getDatabase()
      .prepare(
        `SELECT json_extract(je.value, '$.name') AS artist_name, MAX(json_extract(je.value, '$.mid')) AS mid
           FROM favorites f JOIN tracks t ON t.id = f.track_id, json_each(t.artists_json) je
          WHERE f.user_id = ? AND json_extract(je.value, '$.name') != ''
          GROUP BY artist_name ORDER BY COUNT(DISTINCT f.track_id) DESC LIMIT ?`
      )
      .all(userId, limit) as unknown as Array<{ artist_name: string; mid: string }>
  ).map(r => ({ name: r.artist_name, mid: r.mid }));
}

/**
 * 自适应健康线计算：
 * 少样本/冷启动用户不会被硬卡在 300 首死线下每天夜间无效死磕；
 * 老用户（多位种子歌手）自动平滑提升到完整冗余线。
 */
export function getAdaptivePoolFloor(userId: number): {
  simi: number;
  playlist: number;
  seedOld: number;
  chart: number;
} {
  const seedList = seeds(userId);
  const seedCount = seedList.length;
  const simi = Math.min(POOL_FLOOR.simi, Math.max(60, seedCount * 40));
  const seedOld = Math.min(POOL_FLOOR.seedOld, Math.max(30, seedCount * 20));
  return {
    simi,
    playlist: POOL_FLOOR.playlist,
    seedOld,
    chart: POOL_FLOOR.chart,
  };
}

/**
 * 本地估数（零上游请求）：各来源"大致有多少可用候选"。
 *
 * 用来源归属做代理，不求精确 —— 目的是判断"该不该触发补库"，不是精确配比。
 */
function localCounts(userId: number): Record<keyof typeof POOL_FLOOR, number> {
  const db = getDatabase();
  const q = (sql: string, ...args: Array<string | number>): number =>
    Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);

  // 相似歌手：来自 simi 归属的歌手，其库内曲目数
  const simi = q(
    `SELECT COUNT(*) AS n FROM library_tracks lt
      WHERE lt.artist_mid IN (
        SELECT artist_mid FROM library_user_artists WHERE user_id = ? AND (origin LIKE 'simi%' OR origin LIKE 'topup:simi%')
      )`,
    userId
  );
  // 网友歌单：未消耗歌单里的曲目条数
  const playlist = q(
    `SELECT COUNT(*) AS n FROM playlist_pool_items pi
      WHERE pi.dissid IN (SELECT dissid FROM playlist_pool WHERE consumed_at IS NULL)`
  );
  // 本尊老歌：收藏歌手的库内曲目数
  const seedOld = q(
    `SELECT COUNT(*) AS n FROM library_tracks lt
      WHERE lt.artist_mid IN (
        SELECT DISTINCT json_extract(je.value, '$.mid') FROM favorites f
          JOIN tracks t ON t.id = f.track_id, json_each(t.artists_json) je
         WHERE f.user_id = ? AND json_extract(je.value, '$.mid') IS NOT NULL
      )`,
    userId
  );
  // 榜单：没有本地缓存，给一个保守常量（真要看它，得等生成时那次建池）
  const chart = POOL_FLOOR.chart;
  return { simi, playlist, seedOld, chart };
}

/**
 * 检查并补库（只补低于自适应健康线的来源）。
 *
 * @returns 本次做了什么（空数组 = 全部健康，什么都没做）
 */
export async function ensurePoolHealth(userId: number): Promise<TopUpReport[]> {
  // ① 非夜间闲时（3:00-6:00）严禁后台补库，防止白天与用户前台搜索争抢配额触发 2001 限流
  if (!isNightIdleWindow()) {
    return [];
  }

  /**
   * ⓪ 上游冷却中就跳过。
   *
   * 实测教训：体检本身要"数家底"（建一次池会打 QQ 榜单/搜索），正在生成时叠加
   * 直接把 QQ 打成 2001 限流（冷却 600s）。冷却期内什么都不做，等它自己恢复。
   */
  if (qqCooldown.active()) {
    log.info('QQ 冷却中，本次体检跳过（避免叠加限流）');
    return [];
  }

  const reports: TopUpReport[] = [];
  const floor = getAdaptivePoolFloor(userId);
  const counts = localCounts(userId);

  // ① 网友歌单：现成的补库入口（搜歌单 → 入库 → 取曲目）
  if (counts.playlist < floor.playlist) {
    const target = Math.ceil(floor.playlist * REFILL_TO);
    const added = await refillPlaylistPool(userId).catch(err => {
      log.warn(`网友歌单补库失败：${(err as Error).message}`);
      return 0;
    });
    reports.push({
      source: 'playlist',
      before: counts.playlist,
      action: `补 ${added} 张歌单（目标 ≈${target} 首可用曲目）`,
    });
  }

  // ② 相似歌手：按全局发散预算 GLOBAL_SIMI_BUDGET 分配给种子，平滑发散控量
  if (counts.simi < floor.simi) {
    const list = seeds(userId);
    if (list.length > 0) {
      // 每位种子分配到的邻居探索数：保证总探索量不超过 GLOBAL_SIMI_BUDGET，杜绝任务爆炸
      const perSeedBudget = Math.min(10, Math.max(2, Math.floor(GLOBAL_SIMI_BUDGET / list.length)));
      const names: string[] = [];
      const seenNames = new Set<string>();
      for (const sd of list) {
        if (names.length >= GLOBAL_SIMI_BUDGET) break;
        const neighbors = await getSimilarArtists(sd.name).catch(() => []);
        let countForThisSeed = 0;
        for (const n of neighbors) {
          if (countForThisSeed >= perSeedBudget || names.length >= GLOBAL_SIMI_BUDGET) break;
          const nameStr = (typeof n === 'string' ? n : String(n.name ?? '')).trim();
          if (nameStr && !seenNames.has(nameStr)) {
            seenNames.add(nameStr);
            names.push(nameStr);
            countForThisSeed += 1;
          }
        }
      }
      /**
       * ⚠️ 入口必须是 `artist_resolve`（payload = **歌手名**），不能自己解析 mid 之后
       * 直接入 `artist_songs`：
       *   - `artist_songs` 假定歌手已建档（要靠 library_artists 里的名字去拉歌）；
       *   - 直接入 artist_songs 会让建库器把 **origin 当成歌手名** → QQ 搜不到 →
       *     0 首 → 还被 markArtistFetched 标记"已拉过" → **永久死路**。
       * 走 resolve 入口，建库器自己完成"名字 → mid → 建档 → 拉热门歌"整条链。
       */
      let queued = 0;
      for (const name of names) {
        if (!name) continue;
        enqueueBuildJob(userId, 'artist_resolve', name, 'topup:simi');
        queued += 1;
      }
      reports.push({
        source: 'simi',
        before: counts.simi,
        action: `按全局预算(${GLOBAL_SIMI_BUDGET})从 ${list.length} 位种子探索出 ${names.length} 位邻居 → 排队解析并建库 ${queued} 位（走 artist_resolve 入口）`,
      });
    }
  }

  // ③ 本尊老歌：把"深挖几专辑"调大（建池时读这个设置）
  if (counts.seedOld < floor.seedOld) {
    const next = 8;
    setSetting('pool.deep_albums', String(next));
    reports.push({
      source: 'seedOld',
      before: counts.seedOld,
      action: `深挖专辑数 3 → ${next}（下次建池生效）`,
    });
  }

  // ④ 榜单：把"每榜取几首"调大
  if (counts.chart < floor.chart) {
    const next = 50;
    setSetting('pool.chart_top_n', String(next));
    reports.push({
      source: 'chart',
      before: counts.chart,
      action: `每榜取数 30 → ${next}（目标 ≈${Math.ceil(floor.chart * REFILL_TO)} 首，下次建池生效）`,
    });
  }

  if (reports.length === 0) {
    log.info(
      `池子健康（自适应健康线：相似 ${floor.simi} / 歌单 ${floor.playlist} / 老歌 ${floor.seedOld} / 榜单 ${floor.chart}）：` +
        `现有 相似歌手 ${counts.simi} / 网友歌单 ${counts.playlist} / 本尊老歌 ${counts.seedOld} / 榜单 ${counts.chart} ✓`
    );
  } else {
    for (const r of reports) {
      log.info(`补库触发 [${r.source}] 现有 ${r.before}（健康线 ${floor[r.source]}）→ ${r.action}`);
    }
    kickLibraryBuilder(userId);
  }
  return reports;
}

export function enqueueArtists(userId: number, mids: string[], origin: string): number {
  let n = 0;
  for (const mid of mids) {
    if (!mid) continue;
    enqueueBuildJob(userId, 'artist_songs', mid, origin);
    n += 1;
  }
  if (n > 0) kickLibraryBuilder(userId);
  return n;
}
