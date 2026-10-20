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

/**
 * 管理操作的门：**只接受 Web 面板的同源 cookie 会话**。
 *
 * 产品约定（2026-10-18 设置页边界文档 + 10-20 用户确认）：服务器配置类操作
 * （账号管理、AI 模型增删改、音源扫码授权、数据备份）只能从 Web 面板发起；
 * 原生客户端（Capacitor Bearer / 鸿蒙 bridge）即使管理员身份也一律拒绝。
 * cookie 会话天然只有同源浏览器有，不需要猜渠道。
 */
export function requireWebAdmin(req: FastifyRequest): PublicUser {
  const bearer = extractBearer(req.headers.authorization);
  if (bearer) throw forbidden('管理操作仅限 Web 面板执行');
  const user = userFromCookie(req);
  if (!user) throw unauthorized('未登录');
  // 与 requireUser 的 cookie 分支一致：写请求要过 CSRF 闸
  assertCsrf(req);
  if (user.role !== 'admin') throw forbidden('需要管理员权限');
  return user;
}
