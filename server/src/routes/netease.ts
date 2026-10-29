/**
 * 网易云账号（服务端持有的凭证）的读写入口。
 *
 * 与 B 站账号路由完全同构，**全部需要登录本站**——改的是全站共用的出网身份。
 * 登录方式只有扫码（密码/验证码登录被网易云反作弊反复拦截，已移除）。
 *
 *   POST   /api/netease/qrcode        取二维码（含内联 SVG）
 *   GET    /api/netease/qrcode/:key   轮询扫码结果
 *   GET    /api/netease/account       当前凭证与账号状态
 *   DELETE /api/netease/account       退出登录
 */

import type { FastifyInstance } from 'fastify';
import { requireUser, requireWebAdmin } from '../http/require-auth.ts';
import { record } from '../services/ops-log.ts';
import { badGateway, badRequest } from '../http/errors.ts';
import {
  getNeteaseStatus,
  logoutNetease,
  pollNeteaseQrLogin,
  startNeteaseQrLogin,
} from '../services/netease-account.ts';

export function registerNeteaseRoutes(app: FastifyInstance): void {
  app.get('/api/netease/account', async req => {
    const user = requireUser(req);
    const status = getNeteaseStatus();
    const vip = (status.account?.vipType ?? 0) >= 10;
    record({
      dimension: 'cookie',
      action: 'cookie-check',
      ok: status.configured ? 1 : 0,
      user: user.username,
      summary: status.configured
        ? `网易云 登录态有效${vip ? ' · 黑胶VIP' : ''}${status.account?.name ? `（${status.account.name}）` : ''}`
        : '网易云 未登录',
      detail: JSON.stringify({ source: status.source, vipType: status.account?.vipType ?? 0 }),
    });
    return status;
  });

  app.post('/api/netease/qrcode', async req => {
    requireWebAdmin(req);
    try {
      return await startNeteaseQrLogin();
    } catch (err) {
      throw badGateway(`获取网易云二维码失败：${(err as Error)?.message ?? err}`);
    }
  });

  app.get('/api/netease/qrcode/:key', async req => {
    requireWebAdmin(req);
    const key = String((req.params as { key?: string })?.key ?? '').trim();
    if (!key) throw badRequest('缺少 qrcode_key');

    try {
      return await pollNeteaseQrLogin(key);
    } catch (err) {
      throw badGateway(`查询扫码结果失败：${(err as Error)?.message ?? err}`);
    }
  });

  app.delete('/api/netease/account', async req => {
    requireWebAdmin(req);
    return logoutNetease();
  });
}
