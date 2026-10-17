/**
 * 无后端直连上游的最小实现（供诊断页使用）。
 *
 * 与 server/src/sources/* 的关系：那边是同一套上游调用，但跑在 Node 里、
 * 不受浏览器限制。这里跑在 WebView 里，所以两件事不同：
 *   1. 跨域 —— 上游不回 Access-Control-* 头，普通 fetch 会被 CORS 拦。
 *   2. 请求头 —— `Origin` / `Referer` / `Cookie` 是 **fetch 规范的禁止头**，
 *      `fetch()` 会**静默丢弃**它们（不报错！）。这正是第一版诊断里
 *      "五种请求头组合全是 412、且返回体完全相同"的原因：那三种头一个都没发出去。
 *
 * 所以这里**不走 fetch**，原生环境直接调 CapacitorHttp 插件 API。
 * 它把 headers 当参数交给原生层，绕开 fetch 的禁止头限制。
 *
 * ⚠️ 全程不发登录凭据（无 SESSDATA、无网易云 cookie），
 * 模拟"装了 app 但没登录"这一档 —— 也就是要验证的那一档。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * ⚠️ 必须是**桌面浏览器 UA**，不能用移动端 UA。
 *
 * 实测（同一节点 upos-sz-mirrorhw、同一链接）：
 *   移动 UA → 403 ；桌面 UA → 206
 * 用移动 UA 会让一部分 CDN 节点整首歌都拉不到，且现象很像"节点故障"
 * 或"直链失效"，极难定位 —— 我在这上面栽过一次。
 * 服务端 `utils/constants.ts` 的 BROWSER_UA 也是桌面 UA，保持一致。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BILI_ORIGIN = 'https://www.bilibili.com';

export interface ProbeStep {
  name: string;
  ok: boolean;
  detail: string;
}

/** 单次 HTTP 探测的结果，用于逐项对照 */
export interface HttpProbe {
  label: string;
  status: number;
  note: string;
}

// ---------------------------------------------------------------------------
// 传输层：原生优先，浏览器回退
// ---------------------------------------------------------------------------
export const transportName: string = Capacitor.isNativePlatform()
  ? 'CapacitorHttp（原生，可发禁止头）'
  : 'fetch（浏览器，禁止头会被丢弃）';

export interface HttpResult {
  status: number;
  /** 已解析的 JSON；解析失败则为 null */
  json: unknown;
  /** 原始文本（用于看非 JSON 的错误页） */
  text: string;
  viaNative: boolean;
}

async function httpJson(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; params?: Record<string, string>; data?: unknown } = {}
): Promise<HttpResult> {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.request({
      url,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      ...(opts.params ? { params: opts.params } : {}),
      ...(opts.data !== undefined ? { data: opts.data } : {}),
      connectTimeout: 15000,
      readTimeout: 20000,
    });
    // 原生侧已经解析过 JSON；字符串形式就再解一次，非 JSON 保留原文
    const raw = res.data;
    if (raw !== null && typeof raw === 'object') {
      return { status: res.status, json: raw, text: JSON.stringify(raw), viaNative: true };
    }
    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    return { status: res.status, json: safeParse(text), text, viaNative: true };
  }

  const qs = opts.params ? '?' + new URLSearchParams(opts.params).toString() : '';
  const res = await fetch(url + qs, {
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
    ...(opts.data !== undefined ? { body: JSON.stringify(opts.data) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: safeParse(text), text, viaNative: false };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 游客标识：buvid3/buvid4 是设备标识，**不需要登录**就能拿到。
// B站反爬认这个，而不是认 SESSDATA —— 这是"不登录也能搜/能播"的关键。
// ---------------------------------------------------------------------------
let buvidCache: { b3: string; b4: string } | null = null;

export async function getBuvid(): Promise<{ b3: string; b4: string }> {
  if (buvidCache) return buvidCache;
  const r = await httpJson('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { 'User-Agent': UA },
  });
  const data = (r.json as { data?: { b_3?: string; b_4?: string } } | null)?.data;
  const b3 = data?.b_3 ?? '';
  const b4 = data?.b_4 ?? '';
  if (!b3) throw new Error(`取 buvid 失败：HTTP ${r.status}`);
  buvidCache = { b3, b4 };
  return buvidCache;
}

// ---------------------------------------------------------------------------
// QQ音乐：元数据主力，实测无需任何凭据（已通过首轮真机验证）
// ---------------------------------------------------------------------------
export interface QqSong {
  mid: string;
  name: string;
  artist: string;
  album: string;
  /** 专辑 mid —— 用它拼封面地址（`T002R300x300M000<albumMid>.jpg`） */
  albumMid?: string;
  /** 时长（秒）。QQ 返回的是 `interval` */
  durationSec?: number;
}

export async function qqSearch(keyword: string, limit = 5, page = 1): Promise<QqSong[]> {
  const body = {
    comm: { ct: 19, cv: 1859 },
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { query: keyword, num_per_page: limit, page_num: page, search_type: 0 },
    },
  };
  const r = await httpJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://y.qq.com/',
      'Content-Type': 'application/json',
    },
    data: body,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 120)}`);

  interface QqEnvelope {
    req?: {
      code?: number;
      data?: { body?: { song?: { list?: Array<Record<string, unknown>> } } };
    };
  }
  const json = r.json as QqEnvelope | null;
  const code = json?.req?.code;
  if (code !== 0) throw new Error(`QQ 返回 code=${code}（2001 表示风控冷却）`);

  const list = json?.req?.data?.body?.song?.list ?? [];
  return list.map((s) => {
    const singers = (s.singer as Array<{ name?: string }> | undefined) ?? [];
    return {
      mid: String(s.mid ?? ''),
      name: String(s.name ?? s.title ?? '未知曲目'),
      artist: singers.map((x) => x.name ?? '').filter(Boolean).join('/') || '未知歌手',
      album: String((s.albumname as string) ?? ''),
      albumMid: String((s.albummid as string) ?? ''),
      durationSec: Number(s.interval ?? 0) || 0,
    };
  });
}

// ---------------------------------------------------------------------------
// B站搜索
//
// ⚠️ 端点必须是 `search/all/v2`，**不是** `search/type`。
// 后者在真机上五组请求头全 412（首轮诊断），而服务端一直用的是前者。
// 响应是**分段**结构：data.result[] 里每段有 result_type，视频在 'video' 那段。
// ---------------------------------------------------------------------------
interface BiliSearchSection {
  result_type?: string;
  data?: Array<Record<string, unknown>>;
}

function extractVideos(json: unknown): Array<Record<string, unknown>> {
  const sections = (json as { data?: { result?: BiliSearchSection[] } } | null)?.data?.result ?? [];
  for (const sec of sections) {
    if (sec?.result_type === 'video') return sec.data ?? [];
  }
  return [];
}

export async function biliSearchProbe(keyword: string): Promise<HttpProbe[]> {
  const { b3, b4 } = await getBuvid();
  const cookie = `buvid3=${b3}; buvid4=${b4}`;
  const url = 'https://api.bilibili.com/x/web-interface/search/all/v2';

  const variants: Array<{ label: string; headers: Record<string, string> }> = [
    { label: '仅 UA', headers: { 'User-Agent': UA } },
    { label: 'UA + Cookie(buvid)', headers: { 'User-Agent': UA, Cookie: cookie } },
    {
      label: 'UA + Referer + Cookie',
      headers: { 'User-Agent': UA, Referer: `${BILI_ORIGIN}/`, Cookie: cookie },
    },
  ];

  const out: HttpProbe[] = [];
  for (const v of variants) {
    try {
      const r = await httpJson(url, { headers: v.headers, params: { keyword } });
      let note = '';
      if (r.status === 200) {
        const vids = extractVideos(r.json);
        note = `code=${(r.json as { code?: number } | null)?.code} 视频候选=${vids.length}`;
      } else {
        note = r.text.slice(0, 40).replace(/\s+/g, ' ');
      }
      out.push({ label: v.label, status: r.status, note });
    } catch (e) {
      out.push({ label: v.label, status: -1, note: e instanceof Error ? e.message : String(e) });
    }
    // B站搜索敏感：逐个之间留间隔，别把自己打成风控
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

export interface BiliCandidate {
  bvid: string;
  title: string;
}

export async function biliSearch(keyword: string): Promise<BiliCandidate[]> {
  const { b3, b4 } = await getBuvid();
  const r = await httpJson('https://api.bilibili.com/x/web-interface/search/all/v2', {
    headers: {
      'User-Agent': UA,
      Referer: `${BILI_ORIGIN}/`,
      Cookie: `buvid3=${b3}; buvid4=${b4}`,
    },
    params: { keyword },
  });
  if (r.status !== 200) throw new Error(`B站搜索 HTTP ${r.status}`);
  const code = (r.json as { code?: number } | null)?.code;
  if (code !== 0) throw new Error(`B站搜索 code=${code}`);
  return extractVideos(r.json)
    .slice(0, 10)
    .map((v) => ({
      bvid: String(v.bvid ?? ''),
      title: String(v.title ?? '').replace(/<[^>]+>/g, ''),
    }))
    .filter((c) => c.bvid.length > 0);
}

/** bvid → cid → 音频地址。无 SESSDATA，拿到的就是"未登录档"的音轨。 */
export async function biliResolveAudio(
  bvid: string
): Promise<{ url: string; bandwidth: number; codecs: string }> {
  const { b3, b4 } = await getBuvid();
  const headers = {
    'User-Agent': UA,
    Referer: `${BILI_ORIGIN}/`,
    Cookie: `buvid3=${b3}; buvid4=${b4}`,
  };

  const vres = await httpJson('https://api.bilibili.com/x/web-interface/view', {
    headers,
    params: { bvid },
  });
  const cid = (vres.json as { data?: { cid?: number } } | null)?.data?.cid;
  if (!cid) {
    throw new Error(`取 cid 失败：code=${(vres.json as { code?: number } | null)?.code}`);
  }

  const pres = await httpJson('https://api.bilibili.com/x/player/playurl', {
    headers,
    params: { bvid, cid: String(cid), fnval: '4048', fnver: '0', fourk: '1' },
  });
  const pj = pres.json as {
    code?: number;
    data?: {
      dash?: { audio?: Array<{ baseUrl?: string; base_url?: string; bandwidth?: number; codecs?: string }> };
      audio?: Array<{ url?: string; bandwidth?: number; codecs?: string }>;
    };
  } | null;
  if (pj?.code !== 0) throw new Error(`playurl code=${pj?.code}`);

  // 两种形状先归一，再挑码率最高的一档 —— 未登录也能拿到多档，别只取第一档
  const norm: Array<{ url: string; bandwidth: number; codecs: string }> = [];
  for (const a of pj?.data?.dash?.audio ?? []) {
    norm.push({ url: a.baseUrl ?? a.base_url ?? '', bandwidth: a.bandwidth ?? 0, codecs: a.codecs ?? '' });
  }
  for (const a of pj?.data?.audio ?? []) {
    norm.push({ url: a.url ?? '', bandwidth: a.bandwidth ?? 0, codecs: a.codecs ?? '' });
  }
  const pick = norm.filter((a) => a.url.length > 0).sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (!pick) throw new Error('playurl 未返回可用音轨');
  return pick;
}

/** 音频 CDN 是否强制校验 Referer —— 决定"播放必须走原生"还是"web 也能放"。 */
export async function audioCdnProbeAll(url: string): Promise<HttpProbe[]> {
  const variants: Array<{ label: string; headers: Record<string, string> }> = [
    { label: '带 Referer', headers: { 'User-Agent': UA, Referer: `${BILI_ORIGIN}/` } },
    { label: '不带 Referer', headers: { 'User-Agent': UA } },
    { label: '什么都不带', headers: {} },
  ];
  const out: HttpProbe[] = [];
  for (const v of variants) {
    try {
      const r = await httpJson(url, { headers: { ...v.headers, Range: 'bytes=0-1023' } });
      // 只看状态码：响应体是音频二进制，拿来当文本没有意义
      out.push({
        label: v.label,
        status: r.status,
        note: r.status === 206 ? '206 = 可播放' : r.status === 403 ? '403 = 被拒' : '',
      });
    } catch (e) {
      out.push({ label: v.label, status: -1, note: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
/**
 * 探测一个音频直链是否可播（只发 `Range: bytes=0-0`，不下载内容）。
 *
 * 为什么不复用 `probeStream`：那个用普通 `fetch`，在 WebView 里跨域会被 CORS 拦，
 * 结果是"链接明明是好的，却被判成失败"。原生环境必须走 CapacitorHttp。
 *
 * 必须带 Referer —— 实测部分 CDN 节点（`upos-*`、`cn-sccd-ct`）不带就是 403，
 * 而宽松节点带了也无害。所以一律带。
 */
export async function probeAudio(url: string): Promise<{ ok: boolean; status: number }> {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await CapacitorHttp.request({
        url,
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Referer: `${BILI_ORIGIN}/`,
          Range: 'bytes=0-0',
        },
        responseType: 'text',
      });
      return { ok: res.status === 200 || res.status === 206, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      credentials: 'omit',
      cache: 'no-store',
    });
    void res.body?.cancel();
    return { ok: res.ok || res.status === 206, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * QQ 音乐歌词。
 *
 * 响应是 JSONP（`MusicJsonCallback({...})`），要剥壳。歌词里是 HTML 实体
 * （`&apos;`、`&#10;` 这类），不解码会原样显示成乱码。
 *
 * 无凭据可用 —— 和服务端的歌词兜底走的是同一个上游。
 */
export async function qqLyric(songmid: string): Promise<{ lyric: string; trans: string }> {
  const r = await httpJson('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
    headers: {
      'User-Agent': UA,
      Referer: 'https://y.qq.com/portal/player.html',
    },
    params: {
      songmid,
      format: 'json',
      nobase64: '1',
      g_tk: '5381',
      loginUin: '0',
      hostUin: '0',
      platform: 'yqq',
      needNewCode: '0',
    },
  });
  if (r.status !== 200) throw new Error(`歌词 HTTP ${r.status}`);

  const raw = r.text.trim();
  const start = raw.indexOf('(');
  const end = raw.lastIndexOf(')');
  const body = start >= 0 && end > start ? raw.slice(start + 1, end) : raw;

  const json = JSON.parse(body) as { lyric?: string; trans?: string; retcode?: number };
  if (json.retcode !== undefined && json.retcode !== 0) {
    throw new Error(`歌词 retcode=${json.retcode}`);
  }
  return {
    lyric: decodeEntities(json.lyric ?? ''),
    trans: decodeEntities(json.trans ?? ''),
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
