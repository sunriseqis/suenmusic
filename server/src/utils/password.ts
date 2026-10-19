/**
 * 口令哈希与摘要工具。
 *
 * 用 Node 内置的 `scrypt` 而不是 bcrypt/argon2 —— 后者都需要原生编译。
 * scrypt 是内存硬的，对离线爆破的抵抗力足够，且零依赖。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** 参数写入哈希串，将来升级参数时旧密码仍可校验 */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;
const ALGO = 'scrypt';

/** 生成形如 `scrypt$N$r$p$salt$key` 的自描述哈希串 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(password, salt, KEY_LEN, PARAMS);
  return [
    ALGO,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * 校验口令。任何格式异常都返回 false，不抛错 —— 调用方只关心"能不能登录"。
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== ALGO) return false;

    const [, n, r, p, saltB64, keyB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');

    const actual = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });

    // 长度不等时 timingSafeEqual 会抛错，必须先判长度
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 十六进制 sha256，用于刷新令牌落库（存摘要不存明文） */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 生成 URL 安全的随机令牌 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * 口令长度策略。
 *
 * 放在工具层而不是 `services/auth.ts`，是因为**仓储层也必须守住它**。
 * 否则任何绕过 HTTP 的入口（如 `npm run user:add`）都能建出弱口令账号 ——
 * 这与用户名的正则校验属于同一类不变量：必须落在数据入口，不能指望调用方。
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

export function isValidPasswordLength(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH
  );
}
