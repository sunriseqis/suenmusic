/**
 * 极简 JWT（HS256）。
 *
 * 不引 jsonwebtoken：这里只需要一种算法、一种密钥、一个校验路径，
 * 引依赖反而增加供应链面。手写实现约 60 行，且没有"算法混淆"（alg=none）攻击面
 * —— 算法是硬编码的，不接受令牌头部声明的 alg。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  /** 用户 id */
  sub: number;
  /** 令牌类型：access */
  typ: string;
  /**
   * 令牌唯一标识。
   *
   * `iat` / `exp` 只精确到秒，同一秒内为同一用户签发的两个令牌会**逐字节相同**。
   * 这会让"换发新令牌"的语义失效，也让将来基于 jti 的单令牌吊销无从下手。
   */
  jti: string;
  /** 签发时间（秒） */
  iat: number;
  /** 过期时间（秒） */
  exp: number;
  /**
   * 签发时的令牌纪元，对应 `users.token_epoch`。
   *
   * 校验时与库里的当前值比较，`epo` 小于它即视为已作废 ——
   * 这是"改密码后旧访问令牌立即失效"的实现方式。
   * 不用 `iat` 比较：它只精确到秒，同一秒内签发的旧令牌会躲过检查。
   */
  epo: number;
}

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * 签发访问令牌。
 *
 * @param ttlMs 有效期（毫秒）
 */
export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'>,
  secret: string,
  ttlMs: number
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const full: JwtPayload = {
    ...payload,
    jti: randomBytes(8).toString('hex'),
    iat: nowSec,
    exp: nowSec + Math.floor(ttlMs / 1000),
  };

  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify(full));
  const signingInput = `${header}.${body}`;

  return `${signingInput}.${sign(signingInput, secret)}`;
}

/**
 * 校验并解析访问令牌。任何异常（格式、签名、过期）一律返回 null ——
 * 调用方只关心"这个令牌能不能用"。
 */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const signingInput = `${header}.${body}`;

    const expected = Buffer.from(sign(signingInput, secret));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as JwtPayload;

    if (typeof payload.sub !== 'number' || typeof payload.exp !== 'number') return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/** 从 `Authorization: Bearer xxx` 中取出令牌原文 */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
