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
import { getArtistSongs } from '../sources/qq/artist.ts';
import { fetchSearchSlice, qqCooldown } from '../sources/qq/search.ts';
import { findLocalArtist, findLocalTracksForArtist } from './local-catalog.ts';

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
 * 闲时窗口判定：每天凌晨 3:00 - 6:00
 * 白天（6:00 - 次日 3:00）严禁后台主动向 QQ 发起建库/补库网络请求，保证用户前台搜索 100% 顺畅。
 */
export function isNightIdleWindow(): boolean {
  const hour = new Date().getHours();
  return hour >= 3 && hour < 6;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

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
          log.info(`当前非夜间闲时（3:00-6:00），暂停后台外网建库，仅保留本地回填`);
          break;
        }
        continue;
      }

      if (qqCooldown.active() || externalProcessed >= MAX_EXTERNAL_JOBS_PER_ROUND) {
        if (!hasBuildJob(job.kind, job.payload)) {
          enqueueBuildJob(job.userId, job.kind, job.payload, job.origin);
        }
        consecutiveExternalSkips += 1;
        if (consecutiveExternalSkips >= 5) {
          log.info(
            `已连续遇到 ${consecutiveExternalSkips} 个外网任务（配额已满或冷却中），本地可回填任务已排空，收工`
          );
          break;
        }
        continue;
      }
    }

    try {
      const { resolvedLocally } = await processJob(job);
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
      const msg = (err as Error)?.message ?? String(err);
      const transient =
        qqCooldown.active() || /2001|限流|风控|timeout|aborted|ECONN|fetch failed|network/i.test(msg);
      log.warn(
        `建库任务失败 kind=${job.kind} payload=${job.payload}: ${msg}` +
          (transient ? ' → 判定暂时性失败，任务重新入队（本轮收工）' : ' → 判定永久失败，丢弃')
      );
      if (transient) {
        if (!hasBuildJob(job.kind, job.payload)) {
          enqueueBuildJob(job.userId, job.kind, job.payload, job.origin);
        }
        break;
      }
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

    // 检查本地歌单池是否有该歌手现成曲目，就地回填
    if (!artistHasTracks(mid)) {
      const localTracks = findLocalTracksForArtist(mid);
      if (localTracks.length > 0) {
        saveLibraryTracks(mid, localTracks);
        markArtistFetched(mid);
        log.info(
          `[本地回填] 歌手「${cleanName}」(${mid}) 命中本地歌单，就地入库 ${localTracks.length} 首曲目（零网络请求）`
        );
      } else if (!hasBuildJob('artist_songs', mid)) {
        enqueueBuildJob(job.userId, 'artist_songs', mid, job.origin);
      }
    } else {
      markArtistFetched(mid);
    }
    return { resolvedLocally: true };
  }

  // ② 本地未命中，走外网特遣搜索
  if (qqCooldown.active()) {
    throw new Error('QQ 冷却中，暂停外部歌手搜索');
  }

  const res = await fetchSearchSlice('singer', name, 0, 5);
  const { list } = res;

  if (res.code === 2001) {
    throw new Error(`QQ 2001 限流（歌手搜索 ${name}）`);
  }

  const targetNorm = norm(name);
  // 1. 同名精确匹配
  let hit =
    list.find((a: any) => norm(a?.singerName ?? a?.name) === targetNorm) ?? null;

  // 2. 别名与包含容错：如 "陈奕迅 (Eason Chan)" 包含 "陈奕迅"，或 "Beyond"
  if (!hit && list.length > 0) {
    hit = list.find((a: any) => {
      const aNorm = norm(a?.singerName ?? a?.name);
      return aNorm && (aNorm.includes(targetNorm) || targetNorm.includes(aNorm));
    }) ?? null;
  }

  // 3. 高置信度首选兜底：搜特定人名且首条结果前缀匹配
  if (!hit && list.length > 0) {
    const firstNorm = norm(list[0]?.singerName ?? list[0]?.name);
    if (firstNorm && (firstNorm.startsWith(targetNorm.slice(0, 2)) || targetNorm.startsWith(firstNorm.slice(0, 2)))) {
      hit = list[0];
    }
  }

  const mid = String(hit?.singerMID ?? hit?.mid ?? '') || null;
  if (!mid) {
    log.debug(`相似歌手换 mid 失败（搜不到同名）：${name}`);
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

  // 1. 已有曲目
  if (artistHasTracks(mid)) {
    markArtistFetched(mid);
    linkUserArtist(job.userId, mid, job.origin);
    return { resolvedLocally: true };
  }

  // 2. 本地歌单池回填
  const localTracks = findLocalTracksForArtist(mid);
  if (localTracks.length > 0) {
    const cleanName = localTracks[0]?.ar?.find(a => a.mid === mid)?.name ?? name;
    upsertLibraryArtist(mid, cleanName);
    saveLibraryTracks(mid, localTracks);
    markArtistFetched(mid);
    linkUserArtist(job.userId, mid, job.origin);
    log.info(
      `[本地回填] 歌手曲目「${name}」(${mid}) 命中本地歌单，回填 ${localTracks.length} 首（零网络请求）`
    );
    return { resolvedLocally: true };
  }

  // 3. 本地无曲目，外网拉取（冷门歌手）
  if (qqCooldown.active()) {
    throw new Error('QQ 冷却中，暂停外部歌曲搜索');
  }

  const { songs, degradedCode } = await getArtistSongs(mid, name || mid, 30, 1);
  if (degradedCode === 2001) {
    throw new Error(`QQ 2001 限流（歌曲搜索 ${name}）`);
  }

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
