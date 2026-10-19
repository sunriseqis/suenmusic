/**
 * Web 会话 cookie。
 *
 * Web 与后端同源，不再使用 Bearer + refresh 那套——cookie 由浏览器自动携带，
 * 后端用「刷新令牌」当会话凭据（数据库只存摘要，泄露也换不出访问权）。
 *
 * 安全基线：
 *   HttpOnly            脚本读不到
 *   SameSite=Lax        跨站 POST 不携带
 *   Secure              仅 HTTPS（反代终止 TLS 时看 X-Forwarded-Proto）
 *   Path=/              全站有效
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden } from './errors.ts';

export const SESSION_COOKIE = 'suen_session';
/** 所有写请求必须带的头：cookie 会话的 CSRF 闸门 */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'suenmusic';

export function readSessionToken(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function isHttps(req: FastifyRequest): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https') return true;
  return req.protocol === 'https';
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, expiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (isHttps(req)) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

/** cookie 会话的写请求必须带自定义头，否则视为 CSRF */
export function assertCsrf(req: FastifyRequest): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const v = req.headers[CSRF_HEADER];
  if (typeof v !== 'string' || v !== CSRF_VALUE) {
    throw forbidden('缺少 CSRF 头');
  }
}
