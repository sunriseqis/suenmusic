/**
 * 音频流短期令牌。
 *
 * 为什么需要它：`<audio src="...">` 和原生播放器**发不出 Authorization 头**，
 * 所以 `/api/stream/:trackId` 没法只靠 Bearer 认证。同时又不该完全裸奔
 * （trackId 是可猜测的 `qq_<mid>`，公开就等于公开整个音乐库）。
 *
 * 方案：由已认证的 `/api/resolve` 签发一个短期令牌，直接拼进 streamUrl 返回。
 * 客户端只管用，不需要理解令牌怎么来 —— 因此令牌格式可以随时改。
 *
 * 格式：`<过期毫秒时间戳>.<hmacSha256前16字节hex>`
 * 签名覆盖 trackId，所以一个令牌只对一首曲目有效，无法横向复用。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';

/** 令牌默认有效期：6 小时。够一次连续收听，泄露窗口不至于太大 */
export const STREAM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

function sign(trackId: string, expiresAt: number): string {
  return createHmac('sha256', config.jwtSecret)
    .update(`${trackId}:${expiresAt}`)
    .digest('hex')
    .slice(0, 32);
}

export function signStreamToken(
  trackId: string,
  ttlMs: number = STREAM_TOKEN_TTL_MS
): string {
  const expiresAt = Date.now() + ttlMs;
  return `${expiresAt}.${sign(trackId, expiresAt)}`;
}

export function verifyStreamToken(trackId: string, token: string | undefined): boolean {
  if (!token) return false;

  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const expiresAt = Number(token.slice(0, dot));
  const provided = token.slice(dot + 1);

  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt <= Date.now()) return false;

  // 两种签名都认：逐轨（trackId 绑定）与会话（* 绑定，原生播放器整条队列）
  const candidates = [sign(trackId, expiresAt), sign('*', expiresAt)];

  try {
    const providedBuf = Buffer.from(provided);
    return candidates.some(
      c => c.length === provided.length && timingSafeEqual(Buffer.from(c), providedBuf)
    );
  } catch {
    return false;
  }
}

/**
 * 会话级流令牌：绑定 `*`（全部曲目），一次签发、整条队列可用。
 *
 * 给安卓原生播放器用：队列里的每一轨都是
 * `/api/stream/<trackId>?t=<会话令牌>`，不需要逐轨找 Web 端解析。
 * 24h 有效期 —— 一天的连续收听足够，泄露窗口可控（仅音乐库可听，无数据风险）。
 */
export const SESSION_STREAM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function signSessionStreamToken(
  ttlMs: number = SESSION_STREAM_TOKEN_TTL_MS
): string {
  const expiresAt = Date.now() + ttlMs;
  return `${expiresAt}.${sign('*', expiresAt)}`;
}

/**
 * 生成完整的流地址（含令牌），供 `/api/resolve` 返回给客户端。
 *
 * ★ `quality` 随地址透传（S-16）：代理侧据此读**同一个**缓存键
 * （`cacheKeyFor(trackId, preferMp3, quality)`）。不带的话，iOS 直链失效回退代理时
 * 读的是无档位键 → 必 miss 一次重解析，且重解析结果又写进无档位键，
 * 下次 resolve 读带档位键仍是旧地址（S-2 的尾巴）。
 *
 * 令牌签名只覆盖 trackId，附加查询参数不影响校验（客户端改档位读的是另一行缓存，
 * 内容仍是它自己有权取的那一份，不是越权）。
 */
export function buildStreamUrl(trackId: string, ttlMs?: number, quality?: string): string {
  const url = `/api/stream/${encodeURIComponent(trackId)}?t=${signStreamToken(trackId, ttlMs)}`;
  const q = String(quality ?? '').trim().toLowerCase();
  return q ? `${url}&quality=${encodeURIComponent(q)}` : url;
}
