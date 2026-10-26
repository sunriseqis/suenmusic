/**
 * 音源解析服务。
 *
 * 把「一首 QQ 曲 → 一个可播的 B 站音频 URL」封装成一个带缓存与降级的操作。
 * 这是整个服务端最核心的一段逻辑，所有客户端（网页 / 安卓）都复用它，
 * 因此**匹配结果只需要在服务端算一次**。
 *
 * 三层处理顺序（越靠前越便宜）：
 *   1. 内存 LRU      命中微秒级，但进程重启即失效
 *   2. SQLite        冷启动后的第一道防线，直接消除重启后的第一批上游请求
 *   3. 上游解析      真正打 B 站搜索 + 打分 + 取流
 *
 * 额外两道保护：
 *   - **并发去重**：同一首曲同时在飞的请求共享同一个 Promise。
 *     客户端 click 与 dblclick 会各触发一次，不去重就会把搜索打到风控。
 *   - **冷却快速失败**：B 站 -412 命中后窗口内直接返回失败，不再打上游。
 */

import { createLogger } from '../logger.ts';
import {
  NEGATIVE_TTL_MS,
  computeExpiry,
  deleteSource,
  getSource,
  pruneSources,
  rowToResult,
  saveSource,
} from '../db/repo/sources.ts';
import { deleteAnchor, getAnchor, saveAnchor } from '../db/repo/anchors.ts';
import { biliCooldown, resolveTrackSource } from '../sources/bilibili/stream.ts';
import { resolveKugouSource } from '../sources/kugou/stream.ts';
import { getPin } from '../db/repo/pins.ts';
import { resolveNeteaseSource } from '../sources/netease/source.ts';
import type { ResolveInput, ResolveResult } from '../sources/bilibili/stream.ts';

const log = createLogger('resolver');

/** 内存缓存条目上限。超出后按插入顺序淘汰最旧的（Map 保序即 LRU）。 */
export const MEMORY_LIMIT = 500;

export type ResolveHitLevel = 'memory' | 'db' | 'upstream' | 'cooldown' | 'anchor';

export interface ResolveOutcome extends ResolveResult {
  /** 缓存键，也是客户端后续清缓存的凭据 */
  trackId: string;
  hitLevel: ResolveHitLevel;
  costMs: number;
}

export interface ResolverStats {
  memoryHits: number;
  dbHits: number;
  upstreamCalls: number;
  cooldownRejections: number;
  errors: number;
  memorySize: number;
  inflight: number;
}

interface MemoryEntry {
  result: ResolveResult;
  expiresAt: number;
}

const memory = new Map<string, MemoryEntry>();
const inflight = new Map<string, Promise<ResolveOutcome>>();

const stats = {
  memoryHits: 0,
  dbHits: 0,
  upstreamCalls: 0,
  cooldownRejections: 0,
  errors: 0,
};

/**
 * 缓存键。优先用曲目 id（形如 `qq_<mid>`，全局唯一且稳定）；
 * 没有 id 时退到 bvid 或「歌名+歌手」—— 后者会误命中同名翻唱，
 * 仅作为降级路径，正常调用方都应该带 id。
 */
export function cacheKey(input: ResolveInput): string {
  if (input.id) return String(input.id);
  if (input.bvid) return `bvid:${input.bvid}`;
  const name = (input.name || '').trim();
  if (!name) return '';
  return `name:${name}|${(input.artists || []).join(',')}`;
}

// ---------- 内存 LRU ----------

function memoryGet(key: string): ResolveResult | null {
  const entry = memory.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }

  // LRU：命中后挪到队尾
  memory.delete(key);
  memory.set(key, entry);
  return entry.result;
}

function memorySet(key: string, result: ResolveResult, expiresAt: number): void {
  if (memory.has(key)) {
    memory.delete(key);
  } else if (memory.size >= MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { result, expiresAt });
}

function memoryDelete(key: string): void {
  memory.delete(key);
}

// ---------- 对外接口 ----------

export interface ResolveOptions {
  /** 忽略所有缓存，强制重新解析（取流 403 时用） */
  force?: boolean;
  /**
   * 用户显式重试：**只把「缓存的失败」当空气**，成功缓存照常命中。
   *
   * 与 force 的区别很重要：force 会连成功缓存一起清掉（多打一次上游），
   * 而"用户点了重试"需要的只是"别拿那条失败搪塞我"。没有这个参数时，
   * 一次失败结果会让这首歌在负缓存周期内怎么重试都播不出来。
   */
  retry?: boolean;
}

/**
 * 解析一首曲目的可播音源。
 *
 * 本函数在**第一个 await 之前**完成所有缓存判定与 inflight 登记，
 * 这保证并发调用（同一 tick 内连续发起）能命中去重分支。
 */
export function resolveTrack(
  input: ResolveInput,
  options: ResolveOptions = {}
): Promise<ResolveOutcome> {
  const started = performance.now();
  const key = cacheKey(input);

  if (!key) {
    return Promise.resolve({
      ...failResult('error', '曲目缺少可用于缓存的标识（id / bvid / 歌名均为空）'),
      trackId: '',
      hitLevel: 'cooldown',
      costMs: 0,
    });
  }

  if (options.force) {
    memoryDelete(key);
    deleteSource(key);
    // 强制重解析时必须同时清掉持久层，否则下一轮又读到旧的过期地址。
    // 锚定映射**不在清理范围**：force 的语义是"重新拿一个新鲜地址"，
    // 不是"重新匹配视频"——锚点直连取流恰好就是最快的新鲜地址来源。
  } else {
    /**
     * 用户显式重试：先把「缓存的失败」清掉，成功缓存保留。
     *
     * 不清的话，一次失败会在负缓存周期内把这首歌彻底锁死 ——
     * 用户看到的就是"这一首怎么点都播不出来，换一首再切回来又好了"。
     */
    if (options.retry) {
      const failed = memoryGet(key);
      if (failed && !failed.ok) memoryDelete(key);
      const failedRow = getSource(key);
      if (failedRow && !failedRow.ok) deleteSource(key);
    }

    // 优先检查用户手动锚定：手动固定的锚点具有最高权威
    const anchor = getAnchor(key);
    if (anchor?.pinned) {
      const cached = memoryGet(key);
      if (cached && cached.bvid === anchor.bvid && cached.ok) {
        stats.memoryHits++;
        return Promise.resolve(decorate(cached, key, 'memory', started));
      }
      if (cached) memoryDelete(key);

      const pending = inflight.get(key);
      if (pending) return pending;

      const persisted = getSource(key);
      if (persisted && persisted.bvid === anchor.bvid && persisted.ok) {
        const result = rowToResult(persisted);
        memorySet(key, result, persisted.expiresAt);
        stats.dbHits++;
        return Promise.resolve(decorate(result, key, 'db', started));
      }
      if (persisted) deleteSource(key);

      return resolveFromAnchor(key, anchor, input, started);
    }

    const cached = memoryGet(key);
    if (cached) {
      stats.memoryHits++;
      log.debug(`内存命中 ${key} ok=${cached.ok} score=${cached.score}`);
      return Promise.resolve(decorate(cached, key, 'memory', started));
    }

    const pending = inflight.get(key);
    if (pending) {
      // 不重复打上游。等待者拿到的是同一个解析结果，hitLevel 记 upstream：
      // 对它而言这次调用确实"走了一趟上游"，只是与别人共用了网络请求。
      log.debug(`并发去重 ${key}`);
      return pending;
    }

    const persisted = getSource(key);
    if (persisted) {
      const result = rowToResult(persisted);
      memorySet(key, result, persisted.expiresAt);
      stats.dbHits++;
      log.debug(`持久缓存命中 ${key} ok=${result.ok} score=${result.score}`);
      return Promise.resolve(decorate(result, key, 'db', started));
    }
  }

  // ---- 锚定映射（自动沉淀，永不过期）----
  const anchor = getAnchor(key);
  if (anchor) {
    return resolveFromAnchor(key, anchor, input, started);
  }

  // 冷却窗口内不再打上游：越打窗口越长
  if (biliCooldown.active()) {
    stats.cooldownRejections++;
    const snap = biliCooldown.snapshot();
    log.warn(
      `B 站处于冷却窗口（剩余 ${Math.round(snap.remainingMs / 1000)}s，原因：${snap.reason}），` +
        `跳过解析 ${key}`
    );
    return Promise.resolve({
      ...failResult(
        'rejected',
        `B 站搜索被风控限流，请在 ${Math.ceil(snap.remainingMs / 1000)} 秒后重试`
      ),
      bvid: null,
      score: 0,
      trackId: key,
      hitLevel: 'cooldown',
      costMs: Math.round(performance.now() - started),
    });
  }

  stats.upstreamCalls++;
  const ts = Date.now();

  // 用户源钉（锚定页「只用某源」）：**优先于默认链**。钉 kugou/netease 时只走该源；
  // 钉外的源（含 B 站兜底）全部跳过。pin 无效（该源失败）时按失败处理，
  // 不自动落回别的源 —— 用户的指令就是「只用它」，落回等于悄悄违背。
  const pin = getPin(key);
  const baseChain: Promise<ResolveResult> = pin
    ? (async (): Promise<ResolveResult> => {
        log.info(`源钉 ${key} → 只走 ${pin.source}`);
        return pin.source === 'kugou' ? resolveKugouSource(input) : resolveNeteaseSource(input);
      })()
    : resolveNeteaseSource(input)
      .then(async (neteaseResult): Promise<ResolveResult> => {
        if (neteaseResult.ok) {
          log.info(
            `音源链 qq → 网易云命中 ${key} 「${neteaseResult.matchedTitle}」` +
              ` 时长差=${neteaseResult.durationDiff ?? 0}s`
          );
          return neteaseResult;
        }
        log.debug(`网易云未命中 ${key}：${neteaseResult.message ?? ''}，转酷狗`);
        const kugouResult = await resolveKugouSource(input);
        if (kugouResult.ok) {
          log.info(
            `音源链 qq → 酷狗命中 ${key} 「${kugouResult.matchedTitle}」` +
              ` 时长差=${kugouResult.durationDiff ?? 0}s`
          );
          return kugouResult;
        }
        log.debug(`酷狗未命中 ${key}：${kugouResult.message ?? ''}，转 B 站`);
        return resolveTrackSource(input);
      });

  const promise = baseChain
    .then((result): ResolveOutcome => {
      // 成功与失败都落库。负缓存同样重要：否则重启后会把"注定匹配不到"的
      // 曲子重新打一遍上游，而这正是风控的主要来源。
      saveSource(key, result);
      const expiresAt = result.ok
        ? computeExpiry(result.sourceUrl ?? '', ts)
        : ts + NEGATIVE_TTL_MS;

      memorySet(key, result, expiresAt);

      // 自动沉淀映射：匹配成功的 B 站曲目的 bvid 永久入库。
      // 之后播放只取流、不搜索（见上方锚点分支）；repo 层保证不会覆盖手动锚定。
      //
      // 用 `=== 'bilibili'` 而不是 `?? 'bilibili' === ...`：两条上游路径现在都会
      // 显式带 source（网易云 :217、B 站搜索路径与锚点路径各一处），
      // 兜底已经多余 —— 而正是那处兜底把「字段漏了」掩盖成了「测试才红」。
      if (result.ok && result.bvid && result.source === 'bilibili') {
        saveAnchor(
          key,
          {
            bvid: result.bvid,
            title: result.matchedTitle ?? '',
            author: result.matchedAuthor ?? '',
            durationSec: result.matchedDurationSec ?? 0,
          },
          false
        );
      }

      log.info(
        `上游解析 ${key} ok=${result.ok}` +
          (result.ok
            ? ` score=${result.score} bvid=${result.bvid} 时长差=${result.durationDiff ?? '?'}s`
            : ` reason=${result.reason} ${result.message ?? ''}`)
      );

      return decorate(result, key, 'upstream', started);
    })
    .catch((err): ResolveOutcome => {
      stats.errors++;
      const result = failResult('error', `解析异常：${(err as Error)?.message ?? err}`);
      memorySet(key, result, Date.now() + NEGATIVE_TTL_MS);
      log.error(`解析异常 ${key}`, (err as Error)?.stack ?? String(err));
      return decorate(result, key, 'upstream', started);
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

// ---------- 锚点取流 ----------

/**
 * 按锚定映射解析：bvid 直连取流，跳过搜索。
 * 独立成 async 函数是因为 resolveTrack 本体在第一个 await 前要完成
 * 全部缓存判定（见其注释），锚点这类异步路径必须另起 Promise。
 */
async function resolveFromAnchor(
  key: string,
  anchor: { bvid: string; title: string; author: string; durationSec: number; pinned: boolean },
  input: ResolveInput,
  started: number
): Promise<ResolveOutcome> {
  const ts = Date.now();
  const result = await resolveTrackSource({
    id: input.id,
    name: input.name,
    artists: input.artists,
    durationMs: input.durationMs,
    bvid: anchor.bvid,
  });

  if (result.ok) {
    const enriched: ResolveResult = {
      ...result,
      source: 'bilibili',
      matchedTitle: anchor.title || result.matchedTitle,
      matchedAuthor: anchor.author || result.matchedAuthor,
      /**
       * ★ 把锚点自己的时长带出去。
       *
       * 锚定可以绕过置信度与时长校验（用户拍板"就这个视频"），所以播放的**真实时长**
       * 只能从这里拿。缺了它，客户端会退回 Q 音元数据时长 —— 用户就会看到
       * 「选了 2 分多的音源，界面还显示 3 分多，播完自动切歌」。
       */
      matchedDurationSec: anchor.durationSec || result.matchedDurationSec,
    };
    saveSource(key, enriched);
    memorySet(key, enriched, computeExpiry(enriched.sourceUrl ?? '', ts));
    log.info(`锚点命中 ${key} → ${anchor.bvid}（${anchor.pinned ? '手动' : '自动'}）`);
    return decorate(enriched, key, 'anchor', started);
  }

  // ⚠️ 绝不删除用户手动固定的锚点（pinned=true）：
  // 偶发网络抖动或风控冷却可能导致取流暂时失败，若删掉锚点，用户的配准成果永久丢失。
  // 仅对系统自动沉淀的锚点（pinned=false）在失效时清除。
  if (!anchor.pinned) {
    deleteAnchor(key);
    log.warn(`自动沉淀锚定视频已失效（${anchor.bvid}），删除锚点并回退正常解析 ${key}`);
    return resolveTrack(input);
  }

  log.warn(`手动锚定视频取流未成功（${anchor.bvid}），保留锚点并返回失败状态 ${key}`);
  return decorate(
    {
      ok: false,
      reason: result.reason || 'no_stream',
      bvid: anchor.bvid,
      sourceUrl: null,
      score: 0,
      message: result.message || '手动锚定视频取流失败，请检查该视频是否可用',
    },
    key,
    'anchor',
    started
  );
}

function decorate(
  result: ResolveResult,
  trackId: string,
  hitLevel: ResolveHitLevel,
  startedAt: number
): ResolveOutcome {
  return {
    ...result,
    trackId,
    hitLevel,
    costMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
  };
}

function failResult(
  reason: ResolveResult['reason'],
  message: string
): ResolveResult {
  return { ok: false, reason, bvid: null, sourceUrl: null, score: 0, message };
}

/**
 * 让某首曲目的全部缓存层级失效。
 *
 * 唯一的实际用途：stream 代理拿到 403 —— 说明地址已过期，
 * 必须重解析而不是把 403 透传给客户端。
 */
export function invalidateTrack(trackId: string): void {
  if (!trackId) return;
  memoryDelete(trackId);
  deleteSource(trackId);
  log.debug(`已失效缓存 ${trackId}`);
}

/** 清空内存层（持久层不动）。配置变更或运维排障时用。 */
export function clearMemoryCache(): void {
  memory.clear();
}

/** 清理持久层的过期条目。建议由定时任务周期性调用。 */
export function pruneExpired(): number {
  const removed = pruneSources();
  if (removed > 0) log.info(`清理过期音源缓存 ${removed} 条`);
  return removed;
}

export function resolverStats(): ResolverStats {
  return {
    ...stats,
    memorySize: memory.size,
    inflight: inflight.size,
  };
}

export function resetResolverStats(): void {
  stats.memoryHits = 0;
  stats.dbHits = 0;
  stats.upstreamCalls = 0;
  stats.cooldownRejections = 0;
  stats.errors = 0;
}
