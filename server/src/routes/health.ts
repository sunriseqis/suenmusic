/**
 * 健康与可观测性。
 *
 * 分两级：
 *   `/api/health`        公开，只返回"活着"这个信息，供探针使用
 *   `/api/health/detail` 需要登录，暴露上游压力与缓存命中情况
 *
 * 后者是排查"为什么播放失败"的第一现场：两个上游各自的冷却状态、
 * 缓存命中层级分布、最近一次解析的失败原因，都在这里一次看全。
 */

import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { getUpstreamStats } from '../sources/bilibili/stream.ts';
import { qqCooldown } from '../sources/qq/search.ts';
import { biliCooldown } from '../sources/bilibili/stream.ts';
import { resolverStats } from '../services/resolver.ts';
import { requireUser } from '../http/require-auth.ts';
import { countTracks } from '../db/repo/tracks.ts';
import { countSources } from '../db/repo/sources.ts';
import { countFavorites } from '../db/repo/favorites.ts';
import { countHistory } from '../db/repo/history.ts';
import { countUsers } from '../db/repo/users.ts';

export function registerHealthRoutes(app: FastifyInstance, version: string): void {
  app.get('/api/health', async () => ({
    ok: true,
    version,
    time: Date.now(),
  }));

  app.get('/api/health/detail', async req => {
    const user = requireUser(req);
    const upstream = getUpstreamStats();
    const resolver = resolverStats();
    const sources = countSources();

    return {
      ok: true,
      version,
      uptimeSec: Math.round(process.uptime()),
      config: {
        // 不回显密钥本身，只回显"配没配"，避免日志/截图泄露
        matchThreshold: config.matchThreshold,
        bilibiliCookie: config.bilibiliCookie ? '已配置' : '未配置',
        jwtSecretIsEphemeral: config.jwtSecretIsEphemeral,
        allowRegistration: config.allowRegistration,
      },
      cooldowns: {
        qq: qqCooldown.snapshot(),
        bilibili: biliCooldown.snapshot(),
      },
      upstream,
      resolver,
      database: {
        users: countUsers(),
        tracks: countTracks(),
        sources: sources.total,
        sourcesPositive: sources.positive,
        favorites: countFavorites(user.id),
        history: countHistory(user.id),
      },
    };
  });
}
