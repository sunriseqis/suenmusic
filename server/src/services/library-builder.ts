/**
 * 曲库后台建库器（本地回填优先、外网慢速特遣、单飞）。
 *
 * 设计演进（2026-09-16 改造）：
 *   - **本地回填优先（0 次网络请求）**：
 *     相似歌手名字进入队列后，优先从已采集的歌单池（playlist_pool_items）与
 *     本地曲目（tracks）中倒排索引反查 mid 与干净曲目。
 *     命中后就地建档并回填曲目（单歌手立省 2 次 QQ 搜索，彻底免疫 2001 限流）。
 *   - **外网慢速特遣（冷门歌手兜底）**：
 *     本地未命中的冷门歌手才走 QQ 搜索，严格限制单轮配额（每轮最多 2 个，间隔 4s）。
 *     一旦遇到 2001 限流，任务立即重新入队并整轮收工进入冷却，绝不硬刷。
 *   - **单飞与去重**：
 *     全局同时仅有一个 build 循环；已拉过曲目的歌手跳过；用户不喜欢歌手跳过。
 */

import { createLogger } from '../logger.ts';
import {
  artistHasTracks,
  enqueueBuildJob,
  getLibraryArtist,
  hasBuildJob,
  linkUserArtist,
  markArtistFetched,
  popBuildJob,
  saveLibraryTracks,
  upsertLibraryArtist,
  type BuildJob,
} from '../db/repo/library.ts';
import { getDislikeSets } from '../db/repo/library.ts';
import { deleteSetting, getSetting, setSetting } from '../db/repo/settings.ts';
import { getArtistSongs } from '../sources/qq/artist.ts';
import { fetchArtistSongsMulti } from './artist-songs-multi.ts';
import { fetchSearchSlice, qqCooldown } from '../sources/qq/search.ts';
import { findLocalArtist, findLocalTracksForArtist } from './local-catalog.ts';
import { businessNow } from '../utils/dates.ts';

const log = createLogger('library-builder');

export const SIMI_TRUNCATE = 20;

/**
 * 调度节奏控制：
 *   - 本地任务：内存/SQLite 查表回填，零网络开销，单轮可批量处理高达 200 个。
 *   - 外网任务：受控慢速特遣，每轮最多 2 个，间隔 4 秒，防止触碰 QQ 2001。
 */
const MAX_LOCAL_JOBS_PER_ROUND = 200;
const MAX_EXTERNAL_JOBS_PER_ROUND = 2;
const EXTERNAL_TICK_DELAY_MS = 4_000;

/**
 * 闲时窗口判定：每天凌晨 1:00 - 6:00（用户 2026-10-29 拍板，原 3:00-6:00 太窄）。
 * 白天（6:00 - 次日 1:00）严禁后台主动向 QQ 发起建库/补库网络请求，保证用户前台搜索 100% 顺畅。
 * 用 businessNow()（业务本地时区）取小时，避免容器跑 UTC 时窗口漂移。
 */
export function isNightIdleWindow(): boolean {
  const hour = businessNow().getUTCHours();
  return hour >= 1 && hour < 6;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

/**
 * 多源上线时间（2026-10-27）。此前只拉过 QQ 单源的歌手，
 * `hot_fetched_at` 早于它 → 强制走多源重拉，把 kg_/ne_ 补进来。
 */
const MULTI_SOURCE_LAUNCH_TS = Date.parse('2026-10-27T00:00:00+08:00');

// ---------------------------------------------------------------------------
// 重试上限（P1-C）：暂时性失败不许无限重入队
// ---------------------------------------------------------------------------

/**
 * 同一个建库任务允许的**重试次数**上限（= 最多 4 次尝试）。
 *
 * 为什么必须有：`hasBuildJob` 只查「在队否」，而 runLoop 是「先 pop 再处理」——
 * 弹出后队列里就没有这条了，catch 到暂时性失败时 `hasBuildJob` 恒为 false，
 * 于是每次都重入队 → 下一轮 kick 又弹出同一条 → 又失败 → 再重入队。
 * QQ 长期 2001 时这就是一台**空转机**：队列永远只有一条、永远失败、永远重入队。
 */
export const MAX_BUILD_RETRY = 3;

/**
 * 重试计数存在 `app_settings`（现有键值表）里，而不是给 `library_build_queue`
 * 加 `retry_count` 列 —— 加列要跑迁移，复用键值表零迁移、且重启后不丢。
 */
const BUILD_RETRY_KEY_PREFIX = 'library_build_retry:';

/**
 * 失败记录的保鲜期：超过这个时长的计数视为过期、重新给机会。
 *
 * QQ 2001 是**时段性**故障（某个时段被限流/风控），不是永久坏歌。
 * 不留过期，一次长时间故障会把这批任务永久钉死；留了过期，下个闲时窗口
 * 会重新试 —— 但仍受 `MAX_BUILD_RETRY` 约束，不会再空转。
 */
const BUILD_RETRY_TTL_MS = 6 * 60 * 60 * 1000;

interface BuildRetryState {
  /** 已连续失败次数 */
  count: number;
  /** 最后一次失败时间（毫秒），用于保鲜期判定 */
  at: number;
}

const buildRetryKey = (kind: string, payload: string): string =>
  `${BUILD_RETRY_KEY_PREFIX}${kind}:${payload}`;

function readBuildRetry(kind: string, payload: string): BuildRetryState | null {
  const key = buildRetryKey(kind, payload);
  let raw: string | null = null;
  try {
    raw = getSetting(key);
  } catch {
    return null; // DB 恢复窗口等：读不到就当作没失败过，绝不因为护栏本身阻断建库
  }
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const count = Number(obj?.count ?? 0);
    const at = Number(obj?.at ?? 0);
    if (!Number.isFinite(count) || count <= 0) return null;
    if (!at || Date.now() - at > BUILD_RETRY_TTL_MS) {
      clearBuildRetry(kind, payload); // 过期：清掉，重新给机会
      return null;
    }
    return { count, at };
  } catch {
    return null;
  }
}

function writeBuildRetry(kind: string, payload: string, state: BuildRetryState): void {
  try {
    setSetting(buildRetryKey(kind, payload), JSON.stringify(state));
  } catch {
    /* 记不上就算了：上限是防空转的护栏，不该因为护栏写不进去而中断建库 */
  }
}

/** 任务成功（或判永久失败）时清掉失败计数 */
export function clearBuildRetry(kind: string, payload: string): void {
  try {
    deleteSetting(buildRetryKey(kind, payload));
  } catch {
    /* 同上 */
  }
}

export type BuildFailureAction = 'requeued' | 'dropped';

/**
 * 建库任务失败后的处置（P1-C）：判定暂时性/永久性，并给暂时性失败加**重试上限**。
 *
 * 超过 `MAX_BUILD_RETRY` 次重试就**不再重入队** —— pop 已经把它移出队列，
 * 所以「不再入队」= 标记失败并移出队列，队列得以排空，空转停止。
 *
 * @returns 'requeued' 已重新入队（调用侧本轮应收工）；'dropped' 不再入队
 */
export function handleBuildJobFailure(job: BuildJob, err: unknown): BuildFailureAction {
  const msg = (err as Error)?.message ?? String(err);
  const transient =
    qqCooldown.active() || /2001|限流|风控|timeout|aborted|ECONN|fetch failed|network/i.test(msg);

  if (!transient) {
    clearBuildRetry(job.kind, job.payload);
    log.warn(`建库任务失败 kind=${job.kind} payload=${job.payload}: ${msg} → 判定永久失败，丢弃`);
    return 'dropped';
  }

  const count = (readBuildRetry(job.kind, job.payload)?.count ?? 0) + 1;
  writeBuildRetry(job.kind, job.payload, { count, at: Date.now() });

  if (count > MAX_BUILD_RETRY) {
    log.warn(
      `建库任务失败 kind=${job.kind} payload=${job.payload}: ${msg} → ` +
        `已连续失败 ${count} 次（重试上限 ${MAX_BUILD_RETRY} 次），标记失败并移出队列，不再重入队`
    );
    return 'dropped';
  }

  if (!hasBuildJob(job.kind, job.payload)) {
    enqueueBuildJob(job.userId, job.kind, job.payload, job.origin);
  }
  log.warn(
    `建库任务失败 kind=${job.kind} payload=${job.payload}: ${msg} → ` +
      `判定暂时性失败，任务重新入队（第 ${count}/${MAX_BUILD_RETRY} 次重试，本轮收工）`
  );
  return 'requeued';
}

let building = false;

/**
 * 触发一轮建库。幂等：已在跑就直接返回。
 * fire-and-forget —— 调用方不等它。
 */
export function kickLibraryBuilder(userId: number): void {
  if (building) return;
  building = true;
  // `.finally()` 只保证收尾、**不吞拒绝** —— 少一个 catch，建库循环里任何一次
  // DB 异常（典型：数据库恢复期间的 DatabaseRestoringError）都会变成未处理的
  // Promise 拒绝并终止进程（2026-10-21 重审 R-2）。
  void runLoop(userId)
    .catch(err => {
      log.warn(`建库循环失败：${(err as Error)?.message ?? String(err)}`);
    })
    .finally(() => {
      building = false;
    });
}

async function runLoop(triggerUserId: number): Promise<void> {
  let localProcessed = 0;
  let externalProcessed = 0;
  let consecutiveExternalSkips = 0;

  for (;;) {
    if (localProcessed >= MAX_LOCAL_JOBS_PER_ROUND) {
      log.info(`本轮本地回填已达上限 ${MAX_LOCAL_JOBS_PER_ROUND} 个，收工`);
      break;
    }

    const job = popBuildJob();
    if (!job) break;

    // 预检是否为纯本地任务
    let isLikelyLocal = false;
    if (job.kind === 'artist_resolve') {
      isLikelyLocal = findLocalArtist(job.payload) !== null;
    } else {
      isLikelyLocal =
        artistHasTracks(job.payload) || findLocalTracksForArtist(job.payload).length > 0;
    }

    // 若需要打外网搜索，先做闲时窗口、配额与冷却守卫
    if (!isLikelyLocal) {
      if (!isNightIdleWindow()) {
        if (!hasBuildJob(job.kind, job.payload)) {
          enqueueBuildJob(job.userId, job.kind, job.payload, job.origin);
        }
        consecutiveExternalSkips += 1;
        if (consecutiveExternalSkips >= 5) {
          log.info(`当前非夜间闲时（1:00-6:00），暂停后台外网建库，仅保留本地回填`);
          break;
        }
        continue;
      }

      if (externalProcessed >= MAX_EXTERNAL_JOBS_PER_ROUND) {
        if (!hasBuildJob(job.kind, job.payload)) {
          enqueueBuildJob(job.userId, job.kind, job.payload, job.origin);
        }
        consecutiveExternalSkips += 1;
        if (consecutiveExternalSkips >= 5) {
          log.info(
            `已连续遇到 ${consecutiveExternalSkips} 个外网任务（本轮配额已满），本地可回填任务已排空，收工`
          );
          break;
        }
        continue;
      }
    }

    try {
      const { resolvedLocally } = await processJob(job);
      clearBuildRetry(job.kind, job.payload); // 成功：失败计数归零
      if (resolvedLocally) {
        localProcessed += 1;
        consecutiveExternalSkips = 0;
        await sleep(5); // 稍微让出微任务循环
      } else {
        externalProcessed += 1;
        consecutiveExternalSkips = 0;
        await sleep(EXTERNAL_TICK_DELAY_MS);
      }
    } catch (err) {
      // P1-C：暂时性失败带重试上限（超过就标记失败并移出队列），
      // 永久失败直接丢弃 —— 两条路都不会无限重入队。
      if (handleBuildJobFailure(job, err) === 'requeued') break; // 本轮收工，下一轮 kick 再来
    }
  }

  const total = localProcessed + externalProcessed;
  if (total > 0) {
    log.info(`本轮建库完成：本地回填 ${localProcessed} 个，外网特遣 ${externalProcessed} 个`);
  }
}

async function processJob(job: BuildJob): Promise<{ resolvedLocally: boolean }> {
  if (job.kind === 'artist_resolve') {
    return resolveArtistName(job);
  } else {
    return fetchArtistSongs(job);
  }
}

/**
 * 歌手名 → mid（本地歌单优先，未命中才走 QQ 搜索）
 */
async function resolveArtistName(job: BuildJob): Promise<{ resolvedLocally: boolean }> {
  const name = job.payload;

  // ① 优先本地反查
  const local = findLocalArtist(name);
  if (local) {
    const mid = local.mid;
    const cleanName = local.name || name;

    const { artistMids } = getDislikeSets(job.userId);
    if (artistMids.has(mid)) {
      return { resolvedLocally: true };
    }

    upsertLibraryArtist(mid, cleanName);
    linkUserArtist(job.userId, mid, job.origin);

    // ① 本地回填**只作保底**，不再短路多源（用户 2026-10-29 拍板）。
    //    之前命中即 markArtistFetched + return，导致 fetchArtistSongsMulti 永不被调用，
    //    library_tracks 100% 是 QQ 单源（kg_/ne_ 各 0）。
    if (!artistHasTracks(mid)) {
      const localTracks = findLocalTracksForArtist(mid);
      if (localTracks.length > 0) {
        saveLibraryTracks(mid, localTracks);
        log.info(
          `[本地回填] 歌手「${cleanName}」(${mid}) 命中本地歌单，保底入库 ${localTracks.length} 首曲目（零网络请求），继续走多源补源`
        );
      }
    }

    // ② 继续走多源补源：拉多源并入库（saveLibraryTracks 内部按 name+首歌手 去重，
    //    同曲不同源 id 只留首个命中的源）。
    //    强制条件：曲目不足 或 hot_fetched_at 早于多源上线时间（历史单源歌手必须重拉）。
    const existing = getLibraryArtist(mid)?.hotFetchedAt ?? null;
    const staleSingleSource = existing === null || existing < MULTI_SOURCE_LAUNCH_TS;
    const needMulti = !artistHasTracks(mid) || staleSingleSource;
    if (needMulti) {
      const multi = await fetchArtistSongsMulti(cleanName, 30);
      if (multi.songs.length > 0) {
        saveLibraryTracks(mid, multi.songs);
        log.info(
          `[多源建库] 歌手「${cleanName}」(${mid}) 本地保底后多源补源 ${multi.songs.length} 首` +
            ` 源=${multi.source} (酷狗${multi.detail.kugou}/网易云${multi.detail.netease}/QQ${multi.detail.qq})`
        );
      } else {
        log.info(`[多源建库] 歌手「${cleanName}」(${mid}) 多源无新增曲目（保留本地保底）`);
      }
      markArtistFetched(mid);
    }
    return { resolvedLocally: true };
  }

  // ② 本地未命中，走外网特遣搜索（QQ 未冷却时先查 QQ singer mid，否则或失败时走多源直接拉歌建档）
  const targetNorm = norm(name);
  let mid: string | null = null;

  if (!qqCooldown.active()) {
    const res = await fetchSearchSlice('singer', name, 0, 5);
    const { list } = res;

    if (res.code !== 2001 && list.length > 0) {
      // 1. 同名精确匹配
      let hit =
        list.find((a: any) => norm(a?.singerName ?? a?.name) === targetNorm) ?? null;

      // 2. 别名与包含容错：如 "陈奕迅 (Eason Chan)" 包含 "陈奕迅"，或 "Beyond"
      if (!hit) {
        hit = list.find((a: any) => {
          const aNorm = norm(a?.singerName ?? a?.name);
          return aNorm && (aNorm.includes(targetNorm) || targetNorm.includes(aNorm));
        }) ?? null;
      }

      // 3. 高置信度首选兜底：搜特定人名且首条结果前缀匹配
      if (!hit) {
        const firstNorm = norm(list[0]?.singerName ?? list[0]?.name);
        if (firstNorm && (firstNorm.startsWith(targetNorm.slice(0, 2)) || targetNorm.startsWith(firstNorm.slice(0, 2)))) {
          hit = list[0];
        }
      }

      mid = String(hit?.singerMID ?? hit?.mid ?? '') || null;
    }
  }

  // QQ 冷却/2001/未搜到时，直接用多源拉曲目并从曲目反推歌手 mid 建档
  if (!mid) {
    const multi = await fetchArtistSongsMulti(name, 30);
    if (multi.songs.length === 0) {
      log.debug(`相似歌手换 mid 失败（多源均无曲目）：${name}`);
      return { resolvedLocally: false };
    }
    const matchedAr = multi.songs[0]?.ar?.find(a => {
      const aNorm = norm(a.name);
      return aNorm && (aNorm.includes(targetNorm) || targetNorm.includes(aNorm));
    }) ?? multi.songs[0]?.ar?.[0];
    mid = String(matchedAr?.mid || `ne_${targetNorm}`);

    const { artistMids } = getDislikeSets(job.userId);
    if (artistMids.has(mid)) {
      return { resolvedLocally: false };
    }
    upsertLibraryArtist(mid, matchedAr?.name || name);
    saveLibraryTracks(mid, multi.songs);
    markArtistFetched(mid);
    linkUserArtist(job.userId, mid, job.origin);
    log.info(
      `[多源建库] 歌手「${name}」(${mid}) 一步建档入库 ${multi.songs.length} 首 (源=${multi.source})`,
    );
    return { resolvedLocally: false };
  }

  const { artistMids } = getDislikeSets(job.userId);
  if (artistMids.has(mid)) {
    return { resolvedLocally: false };
  }

  upsertLibraryArtist(mid, name);
  linkUserArtist(job.userId, mid, job.origin);
  if (!artistHasTracks(mid) && !hasBuildJob('artist_songs', mid)) {
    enqueueBuildJob(job.userId, 'artist_songs', mid, job.origin);
  }
  return { resolvedLocally: false };
}

/**
 * 拉某歌手的热门歌进曲库（本地优先）
 */
async function fetchArtistSongs(job: BuildJob): Promise<{ resolvedLocally: boolean }> {
  const mid = job.payload;
  const artist = getLibraryArtist(mid);
  const name = artist?.name ?? job.origin;

  // 1. 已有曲目：仅当 hot_fetched_at 早于多源上线时间时才强制重拉（补 kg_/ne_）
  const fetchedAt = artist?.hotFetchedAt ?? null;
  const staleSingleSource = fetchedAt === null || fetchedAt < MULTI_SOURCE_LAUNCH_TS;
  if (artistHasTracks(mid) && !staleSingleSource) {
    markArtistFetched(mid);
    linkUserArtist(job.userId, mid, job.origin);
    return { resolvedLocally: true };
  }

  // 2. 本地歌单池回填（只作保底，不再短路多源 —— 见 resolveArtistName 同款改造）
  const localTracks = findLocalTracksForArtist(mid);
  if (localTracks.length > 0) {
    const cleanName = localTracks[0]?.ar?.find(a => a.mid === mid)?.name ?? name;
    upsertLibraryArtist(mid, cleanName);
    saveLibraryTracks(mid, localTracks);
    linkUserArtist(job.userId, mid, job.origin);
    log.info(
      `[本地回填] 歌手曲目「${name}」(${mid}) 命中本地歌单，保底回填 ${localTracks.length} 首（零网络请求），继续走多源补源`
    );
    // 不 return：继续往下走多源补源
  }

  // 3. 走多源外网拉取（酷狗为主 → 网易云为辅 → QQ 兜底，不受 QQ 冷却阻塞）
  //    本地已有保底曲目时也照拉，靠 saveLibraryTracks 的 name+首歌手 去重归一 id。

  /**
   * 多源拉取（用户 2026-10-26 定稿）：**酷狗为主 → 网易云为辅 → QQ 兜底**。
   *
   * 逐级回退而不是三源齐发：建库是批量任务，一次齐发会把三个上游都打一遍。
   * 夜间窗口与配额守卫在 runLoop 里，这里只负责「按顺序要数据」。
   */
  const multi = await fetchArtistSongsMulti(name || mid, 30);
  const songs = multi.songs;
  log.info(
    `[多源建库] 歌手「${name}」(${mid}) 命中 ${songs.length} 首` +
      ` 源=${multi.source} 请求=${multi.requests} ` +
      `(酷狗${multi.detail.kugou}/网易云${multi.detail.netease}/QQ${multi.detail.qq})`,
  );

  if (songs.length === 0) {
    upsertLibraryArtist(mid, name);
    markArtistFetched(mid);
    return { resolvedLocally: false };
  }

  upsertLibraryArtist(mid, songs[0]?.ar?.find(a => a.mid === mid)?.name ?? name);
  saveLibraryTracks(mid, songs);
  markArtistFetched(mid);
  linkUserArtist(job.userId, mid, job.origin);
  return { resolvedLocally: false };
}
