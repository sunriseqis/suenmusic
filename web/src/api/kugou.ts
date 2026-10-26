/**
 * 酷狗音源账号：扫码登录、状态查询、退出。
 *
 * 与 bilibili.ts / netease.ts 完全同构：
 *   · start → 生成二维码（dataURL，直接 <img>）；
 *   · poll  → 轮询扫码状态（confirmed 时服务端已落凭据）；
 *   · status/logout → 凭据状态与退出。
 *
 * 注意：扫码必须用**酷狗概念版 App**（权益跟平台参数走，普通酷狗扫了也拿不到概念版权益）。
 */

import { http } from './client.ts';
import type { KugouQrSession, KugouQrPoll, KugouStatus, KugouVipStatus } from './types.ts';

export function fetchKugouStatus(signal?: AbortSignal): Promise<KugouStatus> {
  return http.get<KugouStatus>('/api/admin/kugou/credentials', { signal });
}

export function startKugouQr(): Promise<KugouQrSession> {
  return http.post<KugouQrSession>('/api/admin/kugou/login/qr', undefined, {
    timeoutMs: 15_000,
  });
}

export function pollKugouQr(signal?: AbortSignal): Promise<KugouQrPoll> {
  return http.post<KugouQrPoll>('/api/admin/kugou/login/poll', undefined, {
    signal,
    timeoutMs: 15_000,
  });
}

/** 酷狗概念版会员状态（到期时间决定 VIP 曲能否播） */
export function fetchKugouVip(signal?: AbortSignal): Promise<KugouVipStatus> {
  return http.get<KugouVipStatus>('/api/admin/kugou/vip', { signal });
}

export function logoutKugou(): Promise<{ ok: boolean }> {
  return http.delete<{ ok: boolean }>('/api/admin/kugou/credentials');
}
