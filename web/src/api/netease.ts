/**
 * 网易云音源账号：扫码登录、状态查询、退出。
 *
 * 登录方式只有扫码（2026-09-11 用户拍板）：密码/验证码登录被网易云
 * 反作弊与账号风险判定反复拦截，实测走不通，前后端已整体移除。
 *
 * 与 B 站（api/bilibili.ts）同构。接口都需要登录本站 ——
 * 它们改的是全站共用的出网身份。
 */

import { http } from './client.ts';
import type {
  NeteaseQrPoll,
  NeteaseQrSession,
  NeteaseStatus,
} from './types.ts';

export function fetchNeteaseStatus(signal?: AbortSignal): Promise<NeteaseStatus> {
  return http.get<NeteaseStatus>('/api/netease/account', { signal });
}

export function startNeteaseQr(): Promise<NeteaseQrSession> {
  return http.post<NeteaseQrSession>('/api/netease/qrcode', undefined, {
    timeoutMs: 15_000,
  });
}

export function pollNeteaseQr(key: string, signal?: AbortSignal): Promise<NeteaseQrPoll> {
  return http.get<NeteaseQrPoll>(`/api/netease/qrcode/${encodeURIComponent(key)}`, {
    signal,
    timeoutMs: 15_000,
  });
}

export function logoutNetease(): Promise<{ revertedToEnv: boolean }> {
  return http.delete<{ revertedToEnv: boolean }>('/api/netease/account');
}
