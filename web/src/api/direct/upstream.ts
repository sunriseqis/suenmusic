/**
 * 无后端直连上游的最小实现（供诊断页使用）。
 *
 * 与 server/src/sources/* 的关系：那边是同一套上游调用，但跑在 Node 里、
 * 不受浏览器限制。这里跑在 WebView 里，所以两件事不同：
 *   1. 跨域 —— 普通 fetch 会被 CORS 拦（上游不回 Access-Control-* 头）。
 *      解决：开 CapacitorHttp（见 capacitor.config.ts），fetch 走原生。
 *   2. 请求头 —— 上游有反爬。B站要 buvid3，CDN 要 Referer。
 *
 * ⚠️ 这里**不发送任何登录凭据**（无 SESSDATA、无网易云 cookie），
 * 模拟"用户装了 app 但没登录"这一档 —— 也就是要验证的那一档。
 */

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

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
// 游客标识：buvid3/buvid4 是设备标识，**不需要登录**就能拿到。
// B站反爬认这个，而不是认 SESSDATA —— 这是"不登录也能搜/能播"的关键。
// ---------------------------------------------------------------------------
let buvidCache: { b3: string; b4: string } | null = null;

export async function getBuvid(): Promise<{ b3: string; b4: string }> {
  if (buvidCache) return buvidCache;
  const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { 'User-Agent': UA },
  });
  const json = (await res.json()) as { data?: { b_3?: string; b_4?: string } };
  const b3 = json?.data?.b_3 ?? '';
  const b4 = json?.data?.b_4 ?? '';
  if (!b3) throw new Error(`取 buvid 失败：HTTP ${res.status}`);
  buvidCache = { b3, b4 };
  return buvidCache;
}

// ---------------------------------------------------------------------------
// QQ音乐：元数据主力，实测无需任何凭据
// ---------------------------------------------------------------------------
export interface QqSong {
  mid: string;
  name: string;
  artist: string;
  album: string;
}

export async function qqSearch(keyword: string, limit = 5): Promise<QqSong[]> {
  const body = {
    comm: { ct: 19, cv: 1859 },
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { query: keyword, num_per_page: limit, page_num: 1, search_type: 0 },
    },
  };
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://y.qq.com/',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);

  interface QqEnvelope {
    req?: {
      code?: number;
      data?: { body?: { song?: { list?: Array<Record<string, unknown>> } } };
    };
  }
  const json = JSON.parse(text) as QqEnvelope;
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
    };
  });
}

// ---------------------------------------------------------------------------
// B站搜索：逐个尝试请求头组合。
// 为什么要把组合都打一遍：上游反爬判定不稳定（同一请求不同时刻结论可能不同），
// 一次运行拿到全部对照，比来回猜快得多。
// ---------------------------------------------------------------------------
export async function biliSearchProbe(keyword: string): Promise<HttpProbe[]> {
  const { b3, b4 } = await getBuvid();
  const cookie = `buvid3=${b3}; buvid4=${b4}`;
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' +
    encodeURIComponent(keyword);

  const variants: Array<{ label: string; headers: Record<string, string> }> = [
    { label: '仅 UA', headers: { 'User-Agent': UA } },
    { label: 'UA + Referer', headers: { 'User-Agent': UA, Referer: `${BILI_ORIGIN}/` } },
    { label: 'UA + Cookie(buvid)', headers: { 'User-Agent': UA, Cookie: cookie } },
    {
      label: 'UA + Referer + Cookie',
      headers: { 'User-Agent': UA, Referer: `${BILI_ORIGIN}/`, Cookie: cookie },
    },
    {
      label: 'UA + Referer + Cookie + Origin',
      headers: {
        'User-Agent': UA,
        Referer: `${BILI_ORIGIN}/`,
        Cookie: cookie,
        Origin: BILI_ORIGIN,
      },
    },
  ];

  const out: HttpProbe[] = [];
  for (const v of variants) {
    try {
      const res = await fetch(url, { headers: v.headers });
      let note = '';
      if (res.status === 200) {
        const j = (await res.json()) as { code?: number; data?: { result?: unknown[] } };
        const n = j?.data?.result?.length ?? 0;
        note = `code=${j?.code} 候选=${n}`;
      } else {
        note = (await res.text()).slice(0, 40);
      }
      out.push({ label: v.label, status: res.status, note });
    } catch (e) {
      out.push({ label: v.label, status: -1, note: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export interface BiliCandidate {
  bvid: string;
  title: string;
}

export async function biliSearch(keyword: string): Promise<BiliCandidate[]> {
  const { b3, b4 } = await getBuvid();
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' +
    encodeURIComponent(keyword);
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${BILI_ORIGIN}/`,
      Origin: BILI_ORIGIN,
      Cookie: `buvid3=${b3}; buvid4=${b4}`,
    },
  });
  if (!res.ok) throw new Error(`B站搜索 HTTP ${res.status}`);
  interface BiliSearch {
    code?: number;
    data?: { result?: Array<Record<string, unknown>> };
  }
  const json = (await res.json()) as BiliSearch;
  if (json?.code !== 0) throw new Error(`B站搜索 code=${json?.code}`);
  const list = json?.data?.result ?? [];
  return list.map((r) => ({
    bvid: String(r.bvid ?? ''),
    title: String(r.title ?? '').replace(/<[^>]+>/g, ''),
  }));
}

/** bvid → cid → 音频地址。无 SESSDATA，拿到的就是"未登录档"的音轨。 */
export async function biliResolveAudio(
  bvid: string
): Promise<{ url: string; bandwidth: number; codecs: string }> {
  const { b3, b4 } = await getBuvid();
  const headers = {
    'User-Agent': UA,
    Referer: `${BILI_ORIGIN}/`,
    Origin: BILI_ORIGIN,
    Cookie: `buvid3=${b3}; buvid4=${b4}`,
  };

  const vres = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    { headers }
  );
  const vjson = (await vres.json()) as { code?: number; data?: { cid?: number } };
  const cid = vjson?.data?.cid;
  if (!cid) throw new Error(`取 cid 失败：code=${vjson?.code}`);

  const pres = await fetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
      `&cid=${cid}&fnval=4048&fnver=0&fourk=1`,
    { headers }
  );
  const pjson = (await pres.json()) as {
    code?: number;
    data?: {
      dash?: { audio?: Array<{ baseUrl?: string; base_url?: string; bandwidth?: number; codecs?: string }> };
      audio?: Array<{ url?: string; bandwidth?: number; codecs?: string }>;
    };
  };
  if (pjson?.code !== 0) throw new Error(`playurl code=${pjson?.code}`);

  const dash = pjson?.data?.dash?.audio ?? [];
  const flat = pjson?.data?.audio ?? [];

  // 两种形状（DASH 用 baseUrl/base_url，扁平用 url）先归一，再统一挑码率最高的一档。
  // 别只取第一档：未登录也能拿到多档，第一档往往是最低码率。
  const norm: Array<{ url: string; bandwidth: number; codecs: string }> = [];
  for (const a of dash) {
    norm.push({
      url: a.baseUrl ?? a.base_url ?? '',
      bandwidth: a.bandwidth ?? 0,
      codecs: a.codecs ?? '',
    });
  }
  for (const a of flat) {
    norm.push({ url: a.url ?? '', bandwidth: a.bandwidth ?? 0, codecs: a.codecs ?? '' });
  }
  const pick = norm.filter((a) => a.url.length > 0).sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (!pick) throw new Error('playurl 未返回可用音轨');
  return pick;
}

/** 音频 CDN 是否强制校验 Referer —— 决定"播放必须走原生"还是"web 也能放"。 */
export async function audioCdnProbe(url: string): Promise<HttpProbe> {
  const variants: Array<{ label: string; headers: Record<string, string> }> = [
    { label: '带 Referer', headers: { 'User-Agent': UA, Referer: `${BILI_ORIGIN}/` } },
    { label: '不带 Referer', headers: { 'User-Agent': UA } },
  ];
  const out: HttpProbe[] = [];
  for (const v of variants) {
    try {
      const res = await fetch(url, { headers: { ...v.headers, Range: 'bytes=0-1023' } });
      out.push({ label: v.label, status: res.status, note: `${res.headers.get('content-type') ?? ''}` });
    } catch (e) {
      out.push({ label: v.label, status: -1, note: e instanceof Error ? e.message : String(e) });
    }
  }
  return out[0] ?? { label: '未测', status: -1, note: '' };
}

export async function audioCdnProbeAll(url: string): Promise<HttpProbe[]> {
  const variants: Array<{ label: string; headers: Record<string, string> }> = [
    { label: '带 Referer', headers: { 'User-Agent': UA, Referer: `${BILI_ORIGIN}/` } },
    { label: '不带 Referer', headers: { 'User-Agent': UA } },
    { label: '什么都不带', headers: {} },
  ];
  const out: HttpProbe[] = [];
  for (const v of variants) {
    try {
      const res = await fetch(url, { headers: { ...v.headers, Range: 'bytes=0-1023' } });
      out.push({
        label: v.label,
        status: res.status,
        note: res.headers.get('content-type') ?? '',
      });
    } catch (e) {
      out.push({ label: v.label, status: -1, note: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}