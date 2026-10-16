/**
 * 认证相关接口。
 *
 * 登录/注册走 `publicRequest`（还没有令牌），其余走带鉴权的 `http`。
 * 刷新与登出不走这里 —— 刷新在 `client.ts` 内部完成（它是请求层的职责），
 * 登出需要清空本地令牌，也由 session store 统一处理。
 */

import { getRefreshToken, http, publicRequest } from './client.ts';
import type { AuthConfig, AuthSession, PublicUser, SessionInfo } from './types.ts';

export function fetchAuthConfig(): Promise<AuthConfig> {
  return publicRequest<AuthConfig>('/api/auth/config');
}

export function login(username: string, password: string): Promise<AuthSession> {
  return publicRequest<AuthSession>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
}

export function register(
  username: string,
  password: string,
  displayName?: string
): Promise<AuthSession> {
  return publicRequest<AuthSession>('/api/auth/register', {
    method: 'POST',
    body: { username, password, displayName },
  });
}

/** 退出当前设备。未带刷新令牌时服务端也返回成功（幂等） */
export function logout(refreshToken: string | null): Promise<{ ok: boolean; revoked: boolean }> {
  return http.post('/api/auth/logout', { refreshToken: refreshToken ?? undefined });
}

export function logoutAll(): Promise<{ ok: boolean; revoked: number }> {
  return http.post('/api/auth/logout-all');
}

/**
 * 修改口令。返回**一对新令牌** —— 服务端会吊销该账号的全部会话
 * （含当前设备），同时把当前设备自动续上。调用方必须覆盖保存。
 */
export function changePassword(oldPassword: string, newPassword: string): Promise<AuthSession> {
  return http.patch<AuthSession>('/api/auth/password', { oldPassword, newPassword });
}

export function fetchMe(): Promise<{ user: PublicUser }> {
  return http.get<{ user: PublicUser }>('/api/auth/me');
}

export function fetchSessions(): Promise<{ sessions: SessionInfo[] }> {
  const currentToken = getRefreshToken();
  return http.get<{ sessions: SessionInfo[] }>('/api/auth/sessions', {
    query: currentToken ? { current_token: currentToken } : undefined,
  });
}

export function revokeSession(sessionId: string): Promise<{ ok: boolean; revoked: boolean }> {
  return http.post('/api/auth/revoke', { sessionId });
}
