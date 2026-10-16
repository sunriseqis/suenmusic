/**
 * 服务器连通性探测。
 *
 * 给安卓/局域网场景用的：手机上装的 App 不知道家里服务器在哪，必须让用户
 * 自己填地址并**当场验证**——填错了当场知道，而不是登录时才冒出一个含糊的
 * “网络错误”。
 *
 * 走 `/api/health`：无需鉴权，服务端 CORS 默认放通（`*`），从 WebView 的
 * `https://localhost` 源直连即可。
 */
import { getBaseUrl } from './client.ts';

export interface ProbeResult {
  ok: boolean;
  /** 失败原因（给用户看的中文，不是异常栈） */
  message: string;
}

function describe(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err ?? '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return '连不上：地址不可达、端口没开，或被证书/明文策略拦下了';
  }
  return msg || '未知错误';
}

/**
 * 探测一个基地址是否是可用的 SuenMusic 服务端。
 *
 * @param base 形如 `http://192.168.89.11:3210` 或 `https://music.example.com:1234`
 */
export async function probeServer(base: string, timeoutMs = 8000): Promise<ProbeResult> {
  const url = base.trim().replace(/\/+$/, '');
  if (!url) return { ok: false, message: '请填写服务器地址' };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, message: '地址要以 http:// 或 https:// 开头' };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: ctl.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, message: `服务器返回了 HTTP ${res.status}` };
    // 轻量解析：只要不是明确的失败体就认为可用（不同版本 health 字段可能不同）
    const text = await res.text();
    if (/"ok"\s*:\s*false/i.test(text)) return { ok: false, message: '服务端报告自身状态异常' };
    return { ok: true, message: '已连接' };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { ok: false, message: '连接超时' };
    return { ok: false, message: describe(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 探测当前已配置的基地址 */
export function probeCurrentServer(): Promise<ProbeResult> {
  return probeServer(getBaseUrl());
}
