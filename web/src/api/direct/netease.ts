/**
 * 网易云音源（直连模式）。
 *
 * ## 策略与旧版一致
 *
 * 网易云优先：搜索 → 打分 → 取流。**任何一级返回试听（freeTrialInfo）都算失败**，
 * 逐级降码率再试；全部失败才交给 B 站。
 *
 * 试听只有 30 秒，播出来比不播更糟 —— 所以不是"网易云只能试听"，而是
 * "网易云拿不到整首时不占用这次解析"。
 *
 * ## 为什么不用加密
 *
 * 服务端用的是 vendored NetEaseCloudMusicApi（weapi/eapi 加密 + 登录）。
 * 但这两个**旧接口目前仍然开放**，实测能直接返回完整地址：
 *
 *   GET /api/search/get/web                 搜索
 *   GET /api/song/enhance/player/url        取流（带 br）
 *
 * 没有登录 cookie 时，免费/部分付费曲目会直接给完整地址（320k），
 * 版权限制的曲目会返回 freeTrialInfo —— 正好由上面的策略处理。
 */
import { Capacitor } from '@capacitor/core';
import { httpJson } from './upstream.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
};

export interface NeSong {
  id: number;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  picUrl: string;
}

interface NeSearchRow {
  id?: number;
  name?: string;
  duration?: number;
  artists?: Array<{ name?: string }>;
  album?: { name?: string; picUrl?: string };
}

/** 搜索。失败抛错，由调用方决定是否回退 */
export async function neteaseSearch(keyword: string, limit = 10): Promise<NeSong[]> {
  const r = await httpJson('https://music.163.com/api/search/get/web', {
    headers: HEADERS,
    params: { s: keyword, type: '1', limit: String(limit), offset: '0' },
  });
  const rows =
    (r.json as { result?: { songs?: NeSearchRow[] } } | null)?.result?.songs ?? [];
  return rows.map(s => ({
    id: Number(s.id ?? 0),
    name: String(s.name ?? ''),
    artists: (s.artists ?? []).map(a => String(a.name ?? '')).filter(Boolean),
    album: String(s.album?.name ?? ''),
    durationMs: Number(s.duration ?? 0) || 0,
    picUrl: String(s.album?.picUrl ?? ''),
  }));
}

export interface NeStream {
  url: string;
  br: number;
  trial: boolean;
}

/**
 * 取流。按 320k → 192k → 128k 逐级降档；**试听视为失败**。
 * 返回 null 表示这首在网易云拿不到整首。
 */
export async function neteaseSongUrl(id: number): Promise<NeStream | null> {
  for (const br of [320000, 192000, 128000]) {
    try {
      const r = await httpJson('https://music.163.com/api/song/enhance/player/url', {
        headers: HEADERS,
        params: { id: String(id), ids: `[${id}]`, br: String(br) },
      });
      const row = (
        r.json as
          | { data?: Array<{ url?: string | null; br?: number; freeTrialInfo?: unknown }> }
          | null
      )?.data?.[0];
      if (!row?.url) continue;
      // ⚠️ 试听一律当失败：30 秒的"能播"比"播不了"更让人恼火
      if (row.freeTrialInfo) continue;
      return { url: row.url, br: Number(row.br ?? br), trial: false };
    } catch {
      /* 换下一档 */
    }
  }
  return null;
}

/** 直连模式下 CapacitorHttp 才可用；浏览器里没有原生层，直接放弃 */
export function neteaseAvailable(): boolean {
  return Capacitor.isNativePlatform();
}
