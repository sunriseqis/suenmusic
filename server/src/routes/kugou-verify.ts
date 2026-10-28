/**
 * 酷狗验证码接口（对外契约，三端一致）。
 *
 *   GET  /api/kugou/verify/pending                  → 登录态取当前 state（无 t，自动签新票据）
 *   GET  /api/kugou/verify/state?t=<token>          → 当前验证状态（不碰上游）
 *   POST /api/kugou/verify/refresh?t=<token>        → 重新向上游取一次验证信息
 *   POST /api/kugou/verify/send-sms?t=<token>       → body { mobile? }，下发短信验证码（v_type=32）；mobile 空则回落到凭据里的号
 *   POST /api/kugou/verify/submit?t=<token>         → body { code | verifyCode }，提交验证码
 *
 * token 是服务端签发的 30 分钟短期票据（见 services/kugou-verify.ts），
 * 允许**匿名**携带访问：验证要在系统浏览器里点完，那侧没有 Bearer 令牌。
 * 无 token / 票据无效一律 401。
 *
 * pending 是唯一走登录态的入口：App 内弹出验证面板时还没拿到票据，
 * 用它一次性拿全 state + verifyUrl；needed=false 也回结构完整的对象。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createLogger } from '../logger.ts';
import { badRequest, unauthorized } from '../http/errors.ts';
import { requireUser } from '../http/require-auth.ts';
import { strParam } from '../http/params.ts';
import {
  readKugouVerifyState,
  refreshKugouVerifyState,
  sendKugouVerifySms,
  signKugouVerifyToken,
  submitKugouVerifyCode,
  verifyKugouVerifyToken,
} from '../services/kugou-verify.ts';
import { clearMemoryCache } from '../services/resolver.ts';
import { invalidateKugouStatusCache } from '../services/kugou-status.ts';
import { deleteNegativeSources } from '../db/repo/sources.ts';

const log = createLogger('routes:kugou-verify');

function requireVerifyToken(req: FastifyRequest): string {
  const token = strParam((req.query as Record<string, unknown> | undefined)?.t);
  if (!token || !verifyKugouVerifyToken(token)) {
    throw unauthorized('验证票据无效或已过期，请重新解析一次曲目以获取新票据');
  }
  return token;
}

export function registerKugouVerifyRoutes(app: FastifyInstance): void {
  /**
   * 登录态入口：App 里「需要验证」弹窗直接打这个，不用先拿票据。
   * 每次都签一张**新**票据塞进 verifyUrl —— 客户端拿到就能开验证页，
   * 不必再为了票据重新解析一次曲目。
   */
  app.get('/api/kugou/verify/pending', async req => {
    requireUser(req);
    return readKugouVerifyState(signKugouVerifyToken());
  });

  app.get('/api/kugou/verify/state', async req => readKugouVerifyState(requireVerifyToken(req)));

  app.post('/api/kugou/verify/refresh', async req => refreshKugouVerifyState(requireVerifyToken(req)));

  /**
   * 短信验证码下发（v_type=32）。
   * body.mobile 允许为空：前端在 state.smsMobileHint 非空时不收集手机号（web/src/views/KugouVerify.vue），
   * 而 smsMobileHint 与凭据里的号同源，空串交给 service 自行回落即可。
   * 只有**非空且格式非法**才 400 —— 格式错要明确报错，不能静默换成别的号。
   */
  app.post('/api/kugou/verify/send-sms', async req => {
    requireVerifyToken(req);
    const body = (req.body ?? {}) as { mobile?: unknown };
    const mobile = typeof body.mobile === 'string' ? body.mobile.trim() : '';
    if (mobile && !/^1\d{10}$/.test(mobile)) throw badRequest('手机号格式不正确', 'invalid_param');
    return sendKugouVerifySms(mobile);
  });

  app.post('/api/kugou/verify/submit', async req => {
    const token = requireVerifyToken(req);
    const body = (req.body ?? {}) as { code?: unknown; verifyCode?: unknown };
    // 契约 v2 用 code；verifyCode 是旧字段名，保留兼容（同一份值，不能两个都填）
    const raw = typeof body.code === 'string' ? body.code : body.verifyCode;
    const verifyCode = typeof raw === 'string' ? raw.trim() : '';
    if (!verifyCode) throw badRequest('缺少 code', 'missing_param');

    const result = await submitKugouVerifyCode(verifyCode, token);

    if (result.ok) {
      /**
       * 验证通过后必须让下一次解析**重新取流**：
       *   · 内存 LRU 与酷狗失败行（60s 负缓存）里还留着 20028 的失败结论，
       *     不清掉的话客户端验证完再解析仍会命中旧失败、继续弹验证；
       *   · 登录态缓存也一起失效，避免上游刚刷新过的会员/风控判定被旧值顶住。
       */
      try {
        clearMemoryCache();
        invalidateKugouStatusCache();
        const removed = deleteNegativeSources('kugou');
        log.info(`验证通过：已清酷狗失败缓存 ${removed} 行，等待下一次解析重新取流`);
      } catch (err) {
        log.warn(`验证通过后清缓存失败：${(err as Error).message}`);
      }
    }

    return result;
  });
}
