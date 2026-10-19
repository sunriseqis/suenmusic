/**
 * 从请求取当前用户。
 *
 * 两条通道：
 *   Bearer  —— 移动端（access token）
 *   Cookie  —— Web 同源会话（刷新令牌当会话凭据，见 http/session-cookie.ts）
 *
 * 不做 fastify decorator：显式调用一眼就能看出这个接口是否需要登录。
 */

import type { FastifyRequest } from 'fastify';
import type { PublicUser } from '../db/repo/users.ts';
import { findUserById, toPublicUser } from '../db/repo/users.ts';
import { findValidRefreshToken } from '../db/repo/tokens.ts';
import { verifyAccessToken } from '../services/auth.ts';
import { forbidden, unauthorized } from './errors.ts';
import { extractBearer } from '../utils/jwt.ts';
import { assertCsrf, readSessionToken } from './session-cookie.ts';

function userFromCookie(req: FastifyRequest): PublicUser | null {
  const token = readSessionToken(req);
  if (!token) return null;
  const row = findValidRefreshToken(token);
  if (!row) return null;
  const found = findUserById(row.userId);
  return found ? toPublicUser(found) : null;
}

/** 取当前用户；未登录或令牌失效抛 401 */
export function requireUser(req: FastifyRequest): PublicUser {
  const token = extractBearer(req.headers.authorization);
  if (token) {
    const user = verifyAccessToken(token);
    if (!user) throw unauthorized('访问令牌无效或已过期');
    return user;
  }

  const user = userFromCookie(req);
  if (!user) throw unauthorized('未登录');
  // cookie 通道要防 CSRF：写请求必须带自定义头
  assertCsrf(req);
  return user;
}

/** 取当前用户；未登录时返回 null（用于"可选登录"的接口） */
export function optionalUser(req: FastifyRequest): PublicUser | null {
  const token = extractBearer(req.headers.authorization);
  if (token) return verifyAccessToken(token);
  return userFromCookie(req);
}

/** 管理员专用接口的门 */
export function requireAdmin(req: FastifyRequest): PublicUser {
  const user = requireUser(req);
  if (user.role !== 'admin') throw forbidden('需要管理员权限');
  return user;
}
