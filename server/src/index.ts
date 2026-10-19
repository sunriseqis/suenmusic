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
import { loadBilibiliCookieFromDb } from './services/bilibili-account.ts';
import { loadNeteaseCookieFromDb, initNeteaseVendor } from './services/netease-account.ts';
import { pruneTokens } from './db/repo/tokens.ts';
import { pruneTracks } from './db/repo/tracks.ts';
import { ensurePoolHealth, getActiveUserIds } from './services/library-topup.ts';
import { autoTagUntagged } from './services/ai-tags.ts';
import { runDailyMaintenance } from './services/daily-recommend.ts';
import { msUntilNextLocal } from './utils/dates.ts';

/** 曲目缓存保留 30 天。QQ 侧元数据变动很少，30 天足够且能显著减少上游请求 */
const TRACK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 周期性清理间隔 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  // 第一件事：放开 Node 内置 fetch 的 300 秒隐藏上限（详见 utils/http-agent.ts）
  relaxOutboundTimeout();

  setLogLevel(config.logLevel);

  logger.info(`SuenMusic 服务端 v${SERVER_VERSION} 启动中`);

  if (config.jwtSecretIsEphemeral) {
    logger.warn(
      '未配置 SUENMUSIC_JWT_SECRET，已生成临时密钥：' +
        '重启后所有登录态失效。生产环境请在 .env 中显式配置'
    );
  }

  openDatabase();
  const applied = migrate();
  if (applied > 0) logger.info(`已应用 ${applied} 个数据库迁移`);

  // 必须紧跟迁移、且在 listen 之前：数据库里的凭证要覆盖环境变量那份，
  // 否则界面上"已登录 B 站"与实际的出网身份会不一致
  loadBilibiliCookieFromDb();
  loadNeteaseCookieFromDb();
  // vendor bootstrap（xeapi 公钥 + 匿名 token）。失败不阻塞启动，见内注释
  await initNeteaseVendor();

  const expiredSources = pruneExpired();
  const expiredTokens = pruneTokens();
  const staleTracks = pruneTracks(TRACK_CACHE_TTL_MS);
  logger.info(
    `启动清理：过期音源 ${expiredSources} 条、失效令牌 ${expiredTokens} 条、陈旧曲目 ${staleTracks} 条`
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
    } catch (err) {
      logger.error('周期清理失败', (err as Error)?.message ?? String(err));
    }
    checkPoolHealth();
    void autoTagUntagged(100);
  }, PRUNE_INTERVAL_MS);
  // 启动 5 秒后执行未打标曲目自动补打（启发式秒级完成）
  setTimeout(() => { void autoTagUntagged(500); }, 5_000).unref();
  // 启动 60 秒后再做第一次体检（避开启动时的一堆初始化请求）
  setTimeout(checkPoolHealth, 60_000).unref();
  // unref 让定时器不阻止进程退出
  timer.unref();

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
    if (dailyTimer) clearTimeout(dailyTimer);
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
