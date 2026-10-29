/**
 * B 站账号（服务端持有的凭证）的读写入口。
 *
 * **全部需要登录本站**。这些接口改的是全站共用的出网身份 ——
 * 任何能访问服务端的人都能借此冒用别人的 B 站账号去取流，
 * 所以不能像 /api/health 那样公开。
 *
 * 四个动作对应界面上的一条流程：
 *   POST   /api/bilibili/qrcode        取二维码（含内联 SVG）
 *   GET    /api/bilibili/qrcode/:key   轮询扫码结果
 *   GET    /api/bilibili/account       当前凭证与账号状态
 *   DELETE /api/bilibili/account       退出登录
 */

import type { FastifyInstance } from 'fastify';
import { requireUser, requireWebAdmin } from '../http/require-auth.ts';
import { record } from '../services/ops-log.ts';
import { badGateway, badRequest } from '../http/errors.ts';
import {
  getBilibiliStatus,
  logoutBilibili,
  pollQrLogin,
  startQrLogin,
} from '../services/bilibili-account.ts';

export function registerBilibiliRoutes(app: FastifyInstance): void {
  app.get('/api/bilibili/account', async req => {
    const user = requireUser(req);
    const status = getBilibiliStatus();
    // 旁路埋点：只记登录态摘要，绝不写 cookie 本体
    record({
      dimension: 'cookie',
      action: 'cookie-check',
      ok: status.configured ? 1 : 0,
      user: user.username,
      summary: status.configured
        ? `哔哩哔哩 登录态有效${status.account?.vip ? ' · 大会员' : ''}${status.account?.name ? `（${status.account.name}）` : ''}`
        : '哔哩哔哩 未登录',
      detail: JSON.stringify({ source: status.source, hasSessdata: status.hasSessdata }),
    });
    return status;
  });

  app.post('/api/bilibili/qrcode', async req => {
    requireWebAdmin(req);
    try {
      return await startQrLogin();
    } catch (err) {
      // 上游不通要能被看出是上游的问题，而不是"接口没实现"
      throw badGateway(`获取 B 站二维码失败：${(err as Error)?.message ?? err}`);
    }
  });

  app.get('/api/bilibili/qrcode/:key', async req => {
    requireWebAdmin(req);
    const key = String((req.params as { key?: string })?.key ?? '').trim();
    if (!key) throw badRequest('缺少 qrcode_key');

    try {
      return await pollQrLogin(key);
    } catch (err) {
      throw badGateway(`查询扫码结果失败：${(err as Error)?.message ?? err}`);
    }
  });

  app.delete('/api/bilibili/account', async req => {
    requireWebAdmin(req);
    return logoutBilibili();
  });
}
