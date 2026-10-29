/**
 * 进程入口。
 *
 * 启动顺序有讲究：
 *   1. 先设日志级别，否则最早的启动日志会被默认级别过滤掉
 *   2. 建库并迁移 —— 迁移失败必须直接退出，带着半个 schema 提供服务更糟
 *   3. 清理过期缓存（重启是这个服务唯一的"垃圾回收时机"）
 *   4. 最后才 listen
 */

import { config } from './config.ts';
import { relaxOutboundTimeout } from './utils/http-agent.ts';
import { logger, setLogLevel } from './logger.ts';
import { buildApp, SERVER_VERSION } from './app.ts';
import { closeDatabase, migrate, openDatabase } from './db/index.ts';
import { pruneExpired } from './services/resolver.ts';
import { pruneLoginThrottle } from './services/auth.ts';
import { applyPersistedJwtSecret } from './services/jwt-secret.ts';
import { loadBilibiliCookieFromDb } from './services/bilibili-account.ts';
import { loadNeteaseCookieFromDb, initNeteaseVendor } from './services/netease-account.ts';
import { pruneTokens } from './db/repo/tokens.ts';
import { listPrunableTracks, pruneTracks } from './db/repo/tracks.ts';
import { pruneUpstreamCache } from './services/upstream-cache.ts';
import { getDatabase } from './db/index.ts';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensurePoolHealth, getActiveUserIds } from './services/library-topup.ts';
import { autoTagUntagged } from './services/ai-tags.ts';
import { pruneAllStaleParts, refreshAll as refreshUpdateArtifacts } from './services/github-update.ts';
import { runDailyMaintenance } from './services/daily-recommend.ts';
import { ensureKugouCheckin, runKugouCheckin } from './services/kugou-checkin.ts';
import { runScheduledBackup } from './services/backup.ts';
import { msUntilNextLocal } from './utils/dates.ts';

/** 曲目缓存保留 30 天。QQ 侧元数据变动很少，30 天足够且能显著减少上游请求 */
const TRACK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 上游缓存表保留 8 天。
 *
 * 取的是**所有 kind 里最长的 TTL**（歌手/歌词 7 天）再加 1 天余量：
 * 过期行本来就已不被 cacheGet 返回，这里只负责别让表无限长，
 * 所以宁可多留一天也不要误删一个还在 TTL 内的行。
 */
const UPSTREAM_CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000;
/** 周期性清理间隔 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 兜底：未处理的 Promise 拒绝只记日志，**不终止进程**。
 *
 * 这个服务是单进程 + 单 SQLite：任何一个后台任务漏 catch 都会让整个家庭音乐
 * 服务下线（每日推荐、打标、建库都是 fire-and-forget）。已知的具体触发点（R-2）
 * 是数据库恢复期间的 DatabaseRestoringError —— 那里已逐个补 catch，这里再加一道网，
 * 防止以后新增的后台任务重犯。
 *
 * 刻意**不**接管 uncaughtException：同步异常往往意味着状态已损坏，让它按 Node
 * 默认行为退出、由外部守护（fnOS 的 __supervise / docker restart）拉起更安全。
 */
process.on('unhandledRejection', reason => {
  logger.error(
    `未处理的 Promise 拒绝（已兜住，服务继续运行）：${
      (reason as Error)?.stack ?? String(reason)
    }`
  );
});

/**
 * 删除陈旧曲目前的保险：**先快照、再留清单**。
 *
 * 为什么必须做：`tracks` 既是缓存又是元数据唯一真相源，删除不可逆；而 QQ 一旦限流，
 * 被删曲目即使还挂在收藏/历史里也补不回歌名与封面。快照给出「能回滚」，清单给出
 * 「删了哪些」，两者都落盘在数据目录下的 prune/ 里，保留最近 KEEP 份。
 */
const PRUNE_ARTIFACT_KEEP = 20;

function snapshotBeforePrune(olderThanMs: number): void {
  let candidates: ReturnType<typeof listPrunableTracks>;
  try {
    candidates = listPrunableTracks(olderThanMs);
  } catch (e) {
    logger.warn(`陈旧曲目预检失败，跳过本轮清理：${(e as Error).message}`);
    return;
  }
  if (candidates.length === 0) return;

  const dir = resolve(dirname(config.dbPath), 'prune');
  const stampText = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    mkdirSync(dir, { recursive: true });
    // VACUUM INTO：SQLite 自己生成的**自洽单文件**快照（直接 cp .db 会丢 WAL 里的数据）
    const snap = resolve(dir, `pre-prune-${stampText}.db`);
    getDatabase().exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    const manifest = resolve(dir, `pre-prune-${stampText}.json`);
    writeFileSync(
      manifest,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          olderThanMs,
          count: candidates.length,
          tracks: candidates.map(t => ({ id: t.id, name: t.name })),
        },
        null,
        2
      )
    );
    logger.warn(
      `准备清理陈旧曲目 ${candidates.length} 首；已快照 ${snap}，清单 ${manifest}`
    );
    pruneArtifacts(dir);
  } catch (e) {
    // 快照失败就不删：宁可库变大，也不能在无备份的情况下删元数据
    throw new Error(`快照失败，已中止本轮陈旧曲目清理：${(e as Error).message}`);
  }
}

/** 只保留最近 PRUNE_ARTIFACT_KEEP 组（db + json）备份，避免快照自己把磁盘吃满 */
function pruneArtifacts(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter(f => f.startsWith('pre-prune-'))
      .sort();
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const key = f.replace(/\.(db|json)$/, '');
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    const keys = [...groups.keys()].sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - PRUNE_ARTIFACT_KEEP))) {
      for (const f of groups.get(key) ?? []) rmSync(resolve(dir, f), { force: true });
    }
  } catch {
    // 清理失败不影响主流程
  }
}

async function main(): Promise<void> {
  // 第一件事：放开 Node 内置 fetch 的 300 秒隐藏上限（详见 utils/http-agent.ts）
  relaxOutboundTimeout();

  setLogLevel(config.logLevel);

  logger.info(`SuenMusic 服务端 v${SERVER_VERSION} 启动中`);

  openDatabase();
  const applied = migrate();
  if (applied > 0) logger.info(`已应用 ${applied} 个数据库迁移`);

  /**
   * ★ 密钥必须在任何签名/校验发生**之前**就位（S-20）：
   * 未显式配置 `SUENMUSIC_JWT_SECRET` 时，把「每次启动随机」换成
   * 数据库里持久化的那一把（存在就复用，不存在则生成并写库）。
   * 否则重启即让所有登录令牌、流令牌、酷狗验证票据一起失效。
   *
   * 只能放在 migrate 之后：要读 app_settings。失败不阻塞启动（退化为临时密钥 + WARN）。
   */
  applyPersistedJwtSecret();

  // 必须紧跟迁移、且在 listen 之前：数据库里的凭证要覆盖环境变量那份，
  // 否则界面上"已登录 B 站"与实际的出网身份会不一致
  loadBilibiliCookieFromDb();
  loadNeteaseCookieFromDb();
  // vendor bootstrap（xeapi 公钥 + 匿名 token）。失败不阻塞启动，见内注释
  await initNeteaseVendor();

  const expiredSources = pruneExpired();
  const expiredTokens = pruneTokens();
  // 陈旧曲目清理是**不可逆**的（tracks 同时是元数据唯一真相源）：先快照 + 落删除清单再删。
  snapshotBeforePrune(TRACK_CACHE_TTL_MS);
  const staleTracks = pruneTracks(TRACK_CACHE_TTL_MS);
  const staleUpstream = pruneUpstreamCache(UPSTREAM_CACHE_TTL_MS);
  logger.info(
    `启动清理：过期音源 ${expiredSources} 条、失效令牌 ${expiredTokens} 条、陈旧曲目 ${staleTracks} 条、过期上游缓存 ${staleUpstream} 条`
  );

  const app = buildApp();

  /**
   * 池子体检：**条件驱动**，不是常驻打转（用户口径）。
   *
   * 每 10 分钟只看一眼：哪个来源低于健康线就补哪一个，全健康就什么都不做。
   * 带 running 防重入 —— 上一轮没跑完（或在生成中）就跳过，避免抢上游配额。
   */
  let healthRunning = false;
  const checkPoolHealth = (): void => {
    if (healthRunning) return;
    healthRunning = true;
    (async () => {
      const userIds = getActiveUserIds();
      for (const uid of userIds) {
        await ensurePoolHealth(uid).catch(err =>
          logger.warn(`用户 ${uid} 池子体检失败：${(err as Error)?.message ?? String(err)}`)
        );
      }
    })()
      .catch(err => logger.warn(`池子体检总调度失败：${(err as Error)?.message ?? String(err)}`))
      .finally(() => {
        healthRunning = false;
      });
  };

  const timer = setInterval(() => {
    try {
      pruneExpired();
      pruneTokens();
      // 登录节流计数也要清：每失败一次就留一条，不清理就是无界增长
      //（伪造 IP 会把它放大成「每个请求一条」）
      pruneLoginThrottle();
      // 上游缓存表也要周期清理：只挂启动段的话，进程长期不重启，过期行会一直堆着
      pruneUpstreamCache(UPSTREAM_CACHE_TTL_MS);
    } catch (err) {
      logger.error('周期清理失败', (err as Error)?.message ?? String(err));
    }
    checkPoolHealth();
    // ⚠️ 必须 .catch：打标链路第一件事就是 getDatabase()，而数据库恢复期间
    // 它会抛 DatabaseRestoringError —— `void` 不带 catch 就是未处理的 Promise 拒绝，
    // Node 默认直接终止进程。也就是说"恢复数据库"这个最需要稳定的操作，
    // 反而会因为后台任务在最坏的时刻把服务打死（2026-10-21 重审 R-2）。
    void autoTagUntagged(100).catch(err =>
      logger.warn(`后台打标失败：${(err as Error)?.message ?? String(err)}`)
    );
    void ensureKugouCheckin().catch(err =>
      logger.warn(`酷狗周期签到检查失败：${(err as Error)?.message ?? String(err)}`)
    );
  }, PRUNE_INTERVAL_MS);
  // 启动 5 秒后执行未打标曲目自动补打（启发式秒级完成）
  setTimeout(() => {
    void autoTagUntagged(500).catch(err =>
      logger.warn(`启动补打失败：${(err as Error)?.message ?? String(err)}`)
    );
  }, 5_000).unref();
  // 启动 8 秒后执行酷狗概念版每日签到 + SVIP 升级检查
  setTimeout(() => {
    void ensureKugouCheckin().catch(err =>
      logger.warn(`酷狗启动自动签到失败：${(err as Error)?.message ?? String(err)}`)
    );
  }, 8_000).unref();
  // 启动 60 秒后再做第一次体检（避开启动时的一堆初始化请求）
  setTimeout(checkPoolHealth, 60_000).unref();
  // unref 让定时器不阻止进程退出
  timer.unref();

  /**
   * 酷狗概念版每日签到 + 概念 SVIP 升级：**业务本地时间每天 00:05** 跑一次。
   * 概念 SVIP 每次升级有效期 24 小时，每天零点后自动续期可保持全天候 FLAC/320k 取流权益。
   */
  let kugouCheckinTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleKugouDailyCheckin = (): void => {
    kugouCheckinTimer = setTimeout(() => {
      void runKugouCheckin(true)
        .catch(err => logger.warn(`酷狗每日定时签到失败：${(err as Error)?.message ?? String(err)}`))
        .finally(scheduleKugouDailyCheckin);
    }, msUntilNextLocal(0, 5));
    kugouCheckinTimer.unref();
  };
  scheduleKugouDailyCheckin();

  /**
   * 每日推荐维护：**业务本地时间每天 00:30** 跑一次。
   *
   * 用「算到下一个 00:30 → setTimeout → 触发后重算下一次」的自排程，
   * 而不是 setInterval —— 既没有累加漂移，也不怕跨天/跨月。
   * 时区由 utils/dates.ts 处理：容器跑 UTC 时会自动补 +8，否则 00:30 会变成北京时间 08:30。
   */
  let dailyTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleDailyMaintenance = (): void => {
    dailyTimer = setTimeout(() => {
      void runDailyMaintenance()
        .catch(err => logger.warn(`每日推荐维护失败：${(err as Error)?.message ?? String(err)}`))
        .finally(scheduleDailyMaintenance);
    }, msUntilNextLocal(0, 30));
    dailyTimer.unref();
  };
  scheduleDailyMaintenance();

  // 启动补跑：NAS 休眠 / 容器重启很可能错过 00:30，起来后补一次当日检查
  // （延迟 90 秒，避开启动时的一堆初始化请求）
  setTimeout(() => {
    void runDailyMaintenance().catch(err =>
      logger.warn(`每日推荐启动补跑失败：${(err as Error)?.message ?? String(err)}`)
    );
  }, 90_000).unref();

  /**
   * 自动备份：**服务器本地时间每天 00:00** 跑一次（生成 → 上传 WebDAV → 轮转）。
   *
   * 与上面两个定时任务同款「算到下一个整点 → setTimeout → 触发后重算」自排程：
   * 没有 setInterval 的累加漂移，也不怕跨天/跨月。
   * 条件是 WebDAV 已配置 + enabled + 已存口令，任一不满足则跳过并记录原因；
   * 并发保护（上一轮没跑完就不重入）也在 runScheduledBackup 里 ——
   * 路由层的"立即上传"与定时器共用同一份实现。
   */
  let autoBackupTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleAutoBackup = (): void => {
    autoBackupTimer = setTimeout(() => {
      void runScheduledBackup()
        .then(outcome => logger.info(`自动备份：${outcome.result}`))
        .catch(err => logger.warn(`自动备份调度失败：${(err as Error)?.message ?? String(err)}`))
        .finally(scheduleAutoBackup);
    }, msUntilNextLocal(0, 0));
    autoBackupTimer.unref();
  };
  scheduleAutoBackup();

  /**
   * 更新产物轮询（`SUENMUSIC_UPDATE_SOURCE=github` 时才生效）。
   *
   * 为什么由**服务端**去拉 GitHub 而不是让客户端直连：
   *   ① 国内访问 objects.githubusercontent.com 极不稳定；
   *   ② 客户端（鸿蒙走系统浏览器/侧签工具）发不出鉴权头；
   *   ③ 缓存到本地后下载能支持 Range/断点续传。
   *
   * 启动 20 秒后先拉一次（避开启动初始化），之后每 `updatePollMinutes` 分钟一次。
   * 间隔设 0 表示不自动轮询，只在用户手点（`force=1`）时核对。
   */
  // 启动清一次下载残留（*.part）：进程被杀留下的半截包不会自己消失，一个 hap 就上百 MB
  pruneAllStaleParts();

  if (config.updateSource === 'github' && config.updatePollMinutes > 0) {
    const intervalMs = config.updatePollMinutes * 60 * 1000;
    setTimeout(() => {
      void refreshUpdateArtifacts().catch(err =>
        logger.warn(`更新产物首次拉取失败：${(err as Error)?.message ?? String(err)}`)
      );
    }, 20_000).unref();
    setInterval(() => {
      void refreshUpdateArtifacts().catch(err =>
        logger.warn(`更新产物轮询失败：${(err as Error)?.message ?? String(err)}`)
      );
    }, intervalMs).unref();
  }

  await app.listen({ host: config.host, port: config.port });


  logger.info(
    `已监听 http://${config.host}:${config.port}  ` +
      `匹配阈值=${config.matchThreshold}  B 站 Cookie=${config.bilibiliCookie ? '已配置' : '未配置'}  网易云=${config.neteaseCookie ? '已配置' : '未登录'}  ` +
      `注册=${config.allowRegistration ? '开放' : '关闭'}`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭`);

    clearInterval(timer);
    if (kugouCheckinTimer) clearTimeout(kugouCheckinTimer);
    if (dailyTimer) clearTimeout(dailyTimer);
    if (autoBackupTimer) clearTimeout(autoBackupTimer);
    try {
      await app.close();
    } catch (err) {
      logger.error('关闭 HTTP 服务失败', (err as Error)?.message ?? String(err));
    }
    closeDatabase();
    logger.info('已退出');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(err => {
  logger.error(`启动失败：${(err as Error)?.stack ?? err}`);
  closeDatabase();
  process.exit(1);
});
