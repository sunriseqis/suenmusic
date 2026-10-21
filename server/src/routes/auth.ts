/**
 * 认证路由。
 *
 * 所有入参都在服务层做校验（`normalizeCredentials`），路由层只负责
 * 从请求里取字段、调服务、决定状态码。校验逻辑集中在服务层的好处是：
 * 不管从 HTTP 还是将来的 CLI / 测试进来，规则只有一份。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import * as authService from '../services/auth.ts';
import { countUsers } from '../db/repo/users.ts';
import { findValidRefreshToken, listActiveTokens, revokeRefreshToken } from '../db/repo/tokens.ts';
import { optionalUser, requireUser } from '../http/require-auth.ts';
import {
  assertCsrf,
  clearSessionCookie,
  readSessionToken,
  setSessionCookie,
} from '../http/session-cookie.ts';
import { badRequest, forbidden, unauthorized } from '../http/errors.ts';

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/** 节流标识用客户端 IP。反代后面要开 trustProxy 才能拿到真实 IP */
function clientKey(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

function userAgent(req: FastifyRequest): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : '';
}

export function registerAuthRoutes(app: FastifyInstance): void {
  /**
   * 公开的认证配置。
   *
   * **必须公开**：登录页要在"还没登录"的时候就知道该不该显示注册入口。
   * 这些信息此前只出现在 `/api/health/detail`，而它需要登录 —— 那是个死锁，
   * 客户端永远拿不到。所以单独开一个不含任何敏感信息的公开端点。
   */
  app.get('/api/auth/config', async (_req, reply) => {
    const hasUsers = countUsers() > 0;

    // 不能缓存：开关一改，登录页必须立刻反映出来
    reply.header('Cache-Control', 'no-store');

    return {
      /**
       * 是否接受新注册。首个账号永远可注册 ——
       * 否则关掉注册后就再也建不出第一个号，等于把自己锁在门外。
       * 这与 services/auth.ts 里 register() 的判定必须保持一致。
       */
      setupRequired: !hasUsers,
      registrationOpen: authService.registrationAllowed(),
      allowRegistration: authService.registrationAllowed(),
      hasUsers,
      /** 口令强度下限，供前端做即时预校验，避免提交后才报错 */
      passwordMinLength: authService.passwordMinLength(),
    };
  });

  /**
   * Web 会话登录：同源 cookie。
   *
   * 与 /api/auth/login 的区别只是"凭据放哪"——这里把刷新令牌写进 HttpOnly
   * cookie，响应里不再返回 access/refresh，浏览器脚本拿不到任何令牌。
   */
  app.post('/api/auth/session', async (req, reply) => {
    const body = asRecord(req.body);
    const session = authService.login({
      username: body.username,
      password: body.password,
      userAgent: userAgent(req),
      throttleKey: clientKey(req),
    });
    setSessionCookie(req, reply, session.refreshToken, session.refreshExpiresAt);
    reply.code(200);
    return { user: session.user };
  });

  /** 当前 Web 会话（没登录返回 401） */
  app.get('/api/auth/session', async req => {
    const user = optionalUser(req);
    if (!user) throw unauthorized('未登录');
    return { user };
  });

  /** 退出 Web 会话。写请求必须带 CSRF 头 */
  app.delete('/api/auth/session', async (req, reply) => {
    assertCsrf(req);
    const token = readSessionToken(req);
    if (token) authService.logout(token);
    clearSessionCookie(req, reply);
    return { ok: true };
  });

  /**
   * 注册。首个用户永远可注册；之后由管理员开关决定。
   */
  app.post('/api/auth/register', async (req, reply) => {
    const body = asRecord(req.body);
    const session = authService.register({
      username: body.username,
      password: body.password,
      displayName: body.displayName,
      userAgent: userAgent(req),
    });
    reply.code(201);
    return session;
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = asRecord(req.body);
    const session = authService.login({
      username: body.username,
      password: body.password,
      userAgent: userAgent(req),
      throttleKey: clientKey(req),
    });
    reply.code(200);
    return session;
  });

  /** 刷新会话。刷新令牌会被轮换，客户端必须保存返回的新令牌。 */
  app.post('/api/auth/refresh', async (req, reply) => {
    const body = asRecord(req.body);
    if (typeof body.refreshToken !== 'string' || !body.refreshToken) {
      throw badRequest('缺少 refreshToken');
    }
    reply.code(200);
    return authService.refresh(body.refreshToken, userAgent(req));
  });

  /** 退出当前设备。未携带令牌时也返回成功（幂等，避免客户端卡在退出页）。 */
  app.post('/api/auth/logout', async (req, reply) => {
    const body = asRecord(req.body);
    let revoked = false;
    if (typeof body.refreshToken === 'string' && body.refreshToken) {
      revoked = authService.logout(body.refreshToken);
    }
    reply.code(200);
    return { ok: true, revoked };
  });

  /** 退出所有设备 */
  app.post('/api/auth/logout-all', async req => {
    const user = requireUser(req);
    const count = authService.logoutAll(user.id);
    return { ok: true, revoked: count };
  });

  /**
   * 修改口令。
   *
   * 用 PATCH 而不是 POST：这是对既有账号资源的局部修改。
   * 返回一对**新令牌**（旧会话全部吊销），客户端必须覆盖保存 ——
   * 语义即"改密码后所有设备下线，当前设备自动续上"。
   */
  app.patch('/api/auth/password', async (req, reply) => {
    const user = requireUser(req);
    const body = asRecord(req.body);

    const session = authService.changePassword({
      userId: user.id,
      oldPassword: body.oldPassword,
      newPassword: body.newPassword,
      userAgent: userAgent(req),
    });

    reply.code(200);
    return session;
  });

  app.get('/api/auth/me', async req => {
    const user = requireUser(req);
    return { user };
  });

  /** 当前账号的活跃会话（哪几台设备登录着，并识别出当前访问设备） */
  app.get('/api/auth/sessions', async req => {
    const user = requireUser(req);
    const query = asRecord(req.query);
    const currentToken =
      typeof query.current_token === 'string'
        ? query.current_token
        : typeof req.headers['x-refresh-token'] === 'string'
          ? req.headers['x-refresh-token']
          : undefined;

    let currentSessionId: string | null = null;
    if (currentToken) {
      const curRow = findValidRefreshToken(currentToken);
      if (curRow && curRow.userId === user.id) {
        currentSessionId = curRow.id;
      }
    }

    return {
      sessions: listActiveTokens(user.id).map(t => ({
        id: t.id,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        userAgent: t.userAgent,
        isCurrent: currentSessionId ? t.id === currentSessionId : false,
      })),
    };
  });

  app.post('/api/auth/revoke', async req => {
    const body = asRecord(req.body);
    if (typeof body.sessionId !== 'string' || !body.sessionId) {
      throw badRequest('缺少 sessionId');
    }
    const user = requireUser(req);
    const sessions = listActiveTokens(user.id);
    // 只能吊销自己的会话 —— 否则任意登录用户都能踢掉别人
    if (!sessions.some(s => s.id === body.sessionId)) {
      throw forbidden('该会话不存在或不属于当前账号');
    }
    return { ok: true, revoked: revokeRefreshToken(body.sessionId) };
  });
}
