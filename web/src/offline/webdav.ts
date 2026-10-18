/**
 * WebDAV 备份（不需要任何服务端）。
 *
 * 只在用户主动点"上传/下载"时发请求；地址与凭据存在本机。
 * 原生端走 CapacitorHttp（不受 CORS 限制），浏览器里退回 fetch。
 */
import { Capacitor } from '@capacitor/core';

const KEY = 'suenmusic.webdav';

export interface WebdavConfig {
  url: string;
  user: string;
  pass: string;
}

export function loadWebdav(): WebdavConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { url: '', user: '', pass: '' };
    const c = JSON.parse(raw) as Partial<WebdavConfig>;
    return { url: c.url ?? '', user: c.user ?? '', pass: c.pass ?? '' };
  } catch {
    return { url: '', user: '', pass: '' };
  }
}

export function saveWebdav(cfg: WebdavConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* 写不进去本次会话仍然可用 */
  }
}

function target(cfg: WebdavConfig): string {
  return `${cfg.url.trim().replace(/\/+$/, '')}/suenmusic.sm`;
}

function authHeader(cfg: WebdavConfig): Record<string, string> {
  if (!cfg.user) return {};
  const token = btoa(`${cfg.user}:${cfg.pass}`);
  return { Authorization: `Basic ${token}` };
}

export async function webdavPut(cfg: WebdavConfig, text: string): Promise<void> {
  if (!cfg.url.trim()) throw new Error('请填写 WebDAV 地址');
  const headers = { ...authHeader(cfg), 'Content-Type': 'application/json' };
  if (Capacitor.isNativePlatform()) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const res = await CapacitorHttp.request({
      url: target(cfg),
      method: 'PUT',
      headers,
      data: text,
    });
    if (res.status >= 400) throw new Error(`上传失败（HTTP ${res.status}）`);
    return;
  }
  const res = await fetch(target(cfg), { method: 'PUT', headers, body: text });
  if (!res.ok) throw new Error(`上传失败（HTTP ${res.status}）`);
}

export async function webdavGet(cfg: WebdavConfig): Promise<string> {
  if (!cfg.url.trim()) throw new Error('请填写 WebDAV 地址');
  const headers = authHeader(cfg);
  if (Capacitor.isNativePlatform()) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const res = await CapacitorHttp.request({
      url: target(cfg),
      method: 'GET',
      headers,
    });
    if (res.status >= 400) throw new Error(`下载失败（HTTP ${res.status}）`);
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  }
  const res = await fetch(target(cfg), { headers });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  return res.text();
}
