/**
 * B 站音源账号：扫码登录、状态查询、退出。
 *
 * 四个接口都需要登录本站（服务端会校验）—— 它们改的是**全站共用**的出网身份。
 *
 * 上游没有推送，扫码结果只能轮询。轮询由调用方（设置页）驱动，
 * 这里只负责单次请求，不做定时器 —— 定时器与页面生命周期绑在一起才不会泄漏。
 */

import { http } from './client.ts';
import type { BilibiliQrPoll, BilibiliQrSession, BilibiliStatus } from './types.ts';

export function fetchBilibiliStatus(signal?: AbortSignal): Promise<BilibiliStatus> {
  return http.get<BilibiliStatus>('/api/bilibili/account', { signal });
}

export function startBilibiliQr(): Promise<BilibiliQrSession> {
  return http.post<BilibiliQrSession>('/api/bilibili/qrcode', undefined, {
    timeoutMs: 15_000,
  });
}

export function pollBilibiliQr(key: string, signal?: AbortSignal): Promise<BilibiliQrPoll> {
  return http.get<BilibiliQrPoll>(`/api/bilibili/qrcode/${encodeURIComponent(key)}`, {
    signal,
    timeoutMs: 15_000,
  });
}

export function logoutBilibili(): Promise<{ revertedToEnv: boolean }> {
  return http.delete<{ revertedToEnv: boolean }>('/api/bilibili/account');
}
