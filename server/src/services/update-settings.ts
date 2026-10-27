/**
 * 更新通道的**运行时设置**（存 `app_settings`，Web 管理页可改）。
 *
 * 与环境变量的分工：
 *   · 环境变量：部署机密/机器相关 —— GitHub PAT、缓存目录、轮询间隔
 *   · 这里：管理员随时想调的行为 —— 出站代理、关闭更新
 * 两者都存在时，**这里优先**（Web 上改了立即生效，不用重启）。
 */

import { getSetting, setSetting, deleteSetting } from '../db/repo/settings.ts';

/** 出站代理类型。**只支持 HTTP 代理** —— SOCKS5 已按用户要求删除（用到再说）。 */
export type UpdateProxyKind = 'none' | 'http';

export interface UpdateProxySettings {
  /** github | off */
  source: 'github' | 'off';
  /**
   * 出站代理类型。
   *   none   直连
   *   http   HTTP/HTTPS 代理（支持 CONNECT 隧道，访问 https 都会走 CONNECT）
   *   socks5 SOCKS5 代理（undici 的 SocksProxyAgent 需要 socks 依赖，见下）
   */
  proxyKind: UpdateProxyKind;
  /** 代理地址，如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080`（可含用户名密码） */
  proxyUrl: string;
}

const KEY = 'update_proxy';

const DEFAULTS: UpdateProxySettings = { source: 'github', proxyKind: 'none', proxyUrl: '' };

/** 校验代理 URL：scheme 必须匹配类型，且带主机 */
export function validateProxy(kind: UpdateProxyKind, url: string): string | null {
  const u = url.trim();
  if (kind === 'none') return u === '' ? null : '直连模式下代理地址必须为空';
  if (u === '') return '代理地址不能为空';
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return '代理地址不是合法 URL';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return 'HTTP 代理应以 http:// 或 https:// 开头';
  }
  if (!parsed.hostname) return '代理地址缺少主机名';
  return null;
}

function normalize(raw: string | null): UpdateProxySettings {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateProxySettings>;
    const proxyKind: UpdateProxyKind = parsed.proxyKind === 'http' ? 'http' : 'none';
    const proxyUrl = typeof parsed.proxyUrl === 'string' ? parsed.proxyUrl.trim() : '';
    return {
      source: parsed.source === 'off' ? 'off' : 'github',
      proxyKind,
      // 防御：存的值与类型不符时按直连处理（老数据/手改库的情况）
      proxyUrl: proxyKind === 'none' ? '' : proxyUrl,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getUpdateProxySettings(): UpdateProxySettings {
  return normalize(getSetting(KEY));
}

/** 保存并自检。返回值即规范化后的结果；校验失败抛错（路由层转 400） */
export function saveUpdateProxySettings(next: {
  source?: 'github' | 'off';
  proxyKind?: UpdateProxyKind;
  proxyUrl?: string;
}): UpdateProxySettings {
  const rawUrl = (next.proxyUrl ?? '').trim();
  // 智能容错：填了代理地址即为 http，清空代理地址即为 none 直连，避免误判
  let kind: UpdateProxyKind = next.proxyKind === 'http' ? 'http' : 'none';
  if (rawUrl) {
    kind = 'http';
  } else {
    kind = 'none';
  }

  const value: UpdateProxySettings = {
    source: next.source === 'off' ? 'off' : 'github',
    proxyKind: kind,
    proxyUrl: kind === 'none' ? '' : rawUrl,
  };
  const problem = validateProxy(value.proxyKind, value.proxyUrl);
  if (problem) throw new Error(problem);

  // 全默认 = 回到初始态，删键省存储
  if (value.source === 'github' && value.proxyKind === 'none') {
    deleteSetting(KEY);
  } else {
    setSetting(KEY, JSON.stringify(value));
  }
  return value;
}

/** 配置了代理时返回代理 URI（none / 空返回 null）；合法性已在保存时校验 */
export function proxyUriSafe(s: UpdateProxySettings): string | null {
  if (s.proxyKind === 'none' || s.proxyUrl === '') return null;
  return s.proxyUrl;
}
