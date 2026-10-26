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
import type { KugouQrSession, KugouQrPoll, KugouStatus } from './types.ts';

/**
 * 酷狗登录态（四态：未登录 / 登录已失效 / 会员到期 / 正常）。
 * 文案由服务端下发 —— 会员到期与 token 失效是两种不同故障，两端不要再各自拼。
 */
export function fetchKugouStatus(signal?: AbortSignal): Promise<KugouStatus> {
  return http.get<KugouStatus>('/api/admin/kugou/status', { signal });
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

export function logoutKugou(): Promise<{ ok: boolean }> {
  return http.delete<{ ok: boolean }>('/api/admin/kugou/credentials');
}

export function checkinKugou(): Promise<{ ok: boolean; status: KugouStatus }> {
  return http.post<{ ok: boolean; status: KugouStatus }>('/api/admin/kugou/checkin', undefined, {
    timeoutMs: 15_000,
  });
}
