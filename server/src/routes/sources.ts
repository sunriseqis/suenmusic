/**
 * 音源凭据下发。
 *
 * 只给已登录账号；客户端拿到后自己持久化，在直连模式下带上。
 * cookie 目前是全局一份（app_settings），所以所有人拿到的是同一份。
 */
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../http/require-auth.ts';
import { config } from '../config.ts';

export function registerSourceRoutes(app: FastifyInstance): void {
  app.get('/api/sources/credentials', async req => {
    requireUser(req);
    return {
      bilibili: config.bilibiliCookie || '',
      netease: config.neteaseCookie || '',
      // 客户端用它判断缓存新旧；服务端没有单独记录 cookie 更新时间
      updatedAt: Date.now(),
    };
  });
}
