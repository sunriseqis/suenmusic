/**
 * 安装包下载令牌。
 *
 * 为什么需要它：iOS 的"本地更新"只能把 IPA 地址交给**应用外部**去拉 ——
 * 重签工具（AltStore / SideStore）走 `altstore://install?url=`、兜底是 Safari，
 * 这两条路都**发不出 Authorization 头**，而 `/api/update/download` 原本只认 Bearer。
 * 于是由已认证的 `/api/update/check` 顺带签一个短期令牌，客户端把它拼进下载地址。
 *
 * 格式沿用 stream-token：`<过期毫秒时间戳>.<hmacSha256前32位hex>`，
 * 签名覆盖平台，因此安卓的令牌拿不去下 iOS 的包（反之亦然）。
 *
 * 泄露风险有界：令牌只能换到一个安装包，而安装包本身是公开制品；
 * 不像流令牌那样能换到音乐库。所以有效期给到 30 分钟，够走完一次更新流程。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';

/** 令牌有效期：30 分钟 */
export const UPDATE_TOKEN_TTL_MS = 30 * 60 * 1000;

function sign(platform: string, expiresAt: number): string {
  return createHmac('sha256', config.jwtSecret)
    .update(`update:${platform}:${expiresAt}`)
    .digest('hex')
    .slice(0, 32);
}

export function signUpdateToken(
  platform: string,
  ttlMs: number = UPDATE_TOKEN_TTL_MS
): string {
  const expiresAt = Date.now() + ttlMs;
  return `${expiresAt}.${sign(platform, expiresAt)}`;
}

export function verifyUpdateToken(platform: string, token: string | undefined): boolean {
  if (!token) return false;

  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const expiresAt = Number(token.slice(0, dot));
  const provided = token.slice(dot + 1);

  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt <= Date.now()) return false;

  const expected = sign(platform, expiresAt);

  try {
    const providedBuf = Buffer.from(provided);
    if (expected.length !== providedBuf.length) return false;
    return timingSafeEqual(Buffer.from(expected), providedBuf);
  } catch {
    return false;
  }
}
