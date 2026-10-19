/**
 * 音源凭据：服务端下发，客户端持久化。
 *
 * cookie 是全局一份；客户端只在直连模式下带上它。
 */
import { http } from './client.ts';

export interface SourceCredentials {
  bilibili: string;
  netease: string;
  updatedAt: number;
}

const KEY = 'suen.source.credentials';
const TTL_MS = 6 * 60 * 60 * 1000;

interface Cached extends SourceCredentials {
  fetchedAt: number;
}

export function readCachedCredentials(): Cached | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Cached;
    if (typeof v.bilibili !== 'string' || typeof v.netease !== 'string') return null;
    return v;
  } catch {
    return null;
  }
}

export function clearCachedCredentials(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 隐私模式 */
  }
}

/** 直连请求用：按目标域名取对应的 cookie，没有就返回空串 */
export function sourceCookieForUrl(url: string): string {
  const c = readCachedCredentials();
  if (!c) return '';
  if (/(^|\.)bilibili\.com\//.test(url)) return c.bilibili;
  if (/(^|\.)163\.com\//.test(url) || url.includes('music.163.com')) return c.netease;
  return '';
}

/**
 * 从服务端同步一份。失败静默（离线/未登录都不该打断启动）。
 * @param force 忽略 TTL
 */
export async function syncSourceCredentials(force = false): Promise<void> {
  const cached = readCachedCredentials();
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) return;
  try {
    const res = await http.get<SourceCredentials>('/api/sources/credentials');
    const next: Cached = { ...res, fetchedAt: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 没登录或服务端不可达：保留旧缓存 */
  }
}
