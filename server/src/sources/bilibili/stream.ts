/**
 * B 站音源检索、打分与取流。
 *
 * 相对桌面端 src/utils/bilibili/stream.js 的三处结构性改造：
 *
 * 1. 不再读写 Vuex store。Cookie 由 config 注入，错误通过返回值表达 ——
 *    服务端没有 Toast，也不该有全局状态。
 * 2. 不再返回 `/proxy-audio?url=...` 这类同源代理路径。服务端直接拿到真实
 *    URL，由 routes/stream.ts 带 Referer 转发字节流。安卓端和浏览器端同样
 *    发不出 Referer，所以"代理"这一层从浏览器挪到了服务端，而不是消失。
 * 3. 返回值带上匹配详情（命中标题 / UP 主 / 候选榜），客户端可据此显示来源，
 *    这对"怀疑匹配错了"的排查场景是必需的。
 *
 * **本模块不含任何缓存**。缓存策略（内存 LRU + SQLite 持久 + 并发去重 + 命中层级
 * 上报）统一归 `src/services/resolver.ts`。理由：两个模块各持一份缓存时，
 * 失效逻辑必然分叉，而"取流 403 后要重解析"这类操作需要能一次清掉所有层级。
 */

import { config } from '../../config.ts';
import { createLogger } from '../../logger.ts';
import { Cooldown } from '../../utils/backoff.ts';
import { request, requestJson } from '../../utils/http.ts';
import { parseDuration, scoreCandidate } from './matcher.ts';
import type { MatchCandidate, MatchTrack } from './matcher.ts';

const log = createLogger('bilibili');

const BILI_API = 'https://api.bilibili.com';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SEARCH_TIMEOUT_MS = 8_000;
const VIEW_TIMEOUT_MS = 8_000;
const PLAYURL_TIMEOUT_MS = 10_000;
/**
 * 音频上游的**首包**超时（不是总超时）。
 *
 * 音频流要读几分钟，总超时会把长流拦腰截断（见 utils/http.ts 的 stream 选项）；
 * 真正的"卡住"由 routes/stream.ts 的空闲守护兜底。
 */
/**
 * 音频流的**首包**超时（等到响应头就算成功）。
 *
 * 用户拍板：5 秒拿不到任何数据就认定"解析挂了"，立刻回报客户端
 * （客户端据此走"音源不可用 → 网络连接失败 → 跳下一首"那条链）。
 * 正常 CDN 首包 <1 秒；曾写 20 秒，用户要盯着静默等 20 秒 ✗。
 */
const AUDIO_TIMEOUT_MS = 5_000;

/**
 * B 站风控冷却。命中 -412 后进入窗口，窗口内解析直接快速失败，
 * 不再继续打上游 —— 越打窗口越长。
 */
export const biliCooldown = new Cooldown('bilibili', {
  baseMs: 60_000,
  maxMs: 15 * 60_000,
});

// ---------- 上游调用计数 ----------
//
// 用于验收"同曲并发只打一次上游"这类断言，也供将来的 /health 端点暴露上游压力。
// 计数的是**真实网络请求**，不受缓存层级影响。

const upstreamStats = { search: 0, view: 0, playurl: 0, audio: 0, rejected: 0 };

export function getUpstreamStats(): Readonly<typeof upstreamStats> {
  return { ...upstreamStats };
}

export function resetUpstreamStats(): void {
  upstreamStats.search = 0;
  upstreamStats.view = 0;
  upstreamStats.playurl = 0;
  upstreamStats.audio = 0;
  upstreamStats.rejected = 0;
}

export type ResolveFailureReason =
  | 'rejected'
  | 'no_candidates'
  | 'below_threshold'
  | 'no_stream'
  | 'error';

export interface CandidateBrief {
  bvid: string;
  title: string;
  author: string;
  score: number;
  durationSec: number;
}

export interface ResolveResult {
  ok: boolean;
  reason?: ResolveFailureReason;
  bvid: string | null;
  /** 真实音频地址。播放时必须带 Referer，因此客户端不能直接用，要走服务端转发 */
  sourceUrl: string | null;
  score: number;
  matchedTitle?: string;
  matchedAuthor?: string;
  matchedDurationSec?: number;
  durationDiff?: number;
  bandwidth?: number;
  /** true 表示 DASH 不可用、回落到了音视频混合流 */
  fallbackStream?: boolean;
  /** B 站视频封面（https）。曲目没有 Q 音专辑封面时的显示层兜底 */
  coverUrl?: string;
  /** 置信度排名前列的候选，用于排查误匹配 */
  topCandidates?: CandidateBrief[];
  message?: string;
  /** 音源来源。代理层据此决定出网请求头（B 站要 Referer，网易云不要）。缺省视为 bilibili */
  source?: 'bilibili' | 'netease' | 'kugou';
}

export interface ResolveInput {
  id?: string;
  name: string;
  artists: string[];
  durationMs: number;
  /** 已绑定 BVID 时跳过搜索直接取流 */
  bvid?: string;
  /** 曲目已有 Q 音专辑封面时为 true —— 网易云路径据此跳过封面兜底请求 */
  hasAlbumCover?: boolean;
}

/**
 * 取音频直链时**必须**带的请求头（客户端直连 CDN 时也要照抄这一份）。
 *
 * B 站 CDN 校验 Referer（实测：带 Referer 206 / 不带 403，且不同节点严格程度不同）；
 * 网易云反过来 —— 带了 B 站 Referer 反而可能被拒，只该带干净浏览器 UA。
 */
export function audioHeadersFor(source: 'bilibili' | 'netease' | 'kugou'): Record<string, string> {
  // ⚠️ **绝不能带 Cookie**：`biliHeaders()` 里那份是账号登录凭据（SESSDATA/DedeUserID…），
  //    它只用于服务端调 API。B 站 CDN 只校验 Referer；酷狗/网易 CDN 连 Referer 都不要。
  if (source === 'netease' || source === 'kugou') {
    return { 'User-Agent': BROWSER_UA };
  }
  return { 'User-Agent': BROWSER_UA, Referer: 'https://www.bilibili.com' };
}

function biliHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Referer: 'https://www.bilibili.com',
  };
  if (config.bilibiliCookie) {
    headers.Cookie = config.bilibiliCookie;
  }
  return headers;
}

function fail(
  reason: ResolveFailureReason,
  message: string,
  extra: Partial<ResolveResult> = {}
): ResolveResult {
  return { ok: false, reason, bvid: null, sourceUrl: null, score: 0, message, ...extra };
}

/**
 * 清理歌名中的副标题或括号字符，提高搜索召回质量。
 */
export function buildQuery(track: { name: string; artists: string[] }): string {
  const songName = (track.name || '')
    .replace(/\(.*?\)|（.*?）/g, '')
    .replace(/\[.*?\]|【.*?】/g, '')
    .trim();
  const mainSinger = track.artists?.[0] || '';
  return `${songName} ${mainSinger}`.trim();
}

interface BiliSearchVideo {
  bvid?: string;
  title?: string;
  author?: string;
  duration?: string;
  play?: number;
  /** 封面图。协议相对地址（//i0.hdslb.com/...） */
  pic?: string;
}

interface BiliSearchResponse {
  code?: number;
  data?: {
    result?: Array<{ result_type?: string; data?: BiliSearchVideo[] }>;
  };
}

interface SearchOutcome {
  candidates: MatchCandidate[];
  rejected: boolean;
}

let searchQueue: Promise<unknown> = Promise.resolve();
let lastSearchTime = 0;
const MIN_SEARCH_GAP_MS = 400;

/**
 * 检索候选视频。
 *
 * 通过 searchQueue 串行化并保证每次搜索至少间隔 MIN_SEARCH_GAP_MS（400ms），
 * 避免用户锁屏连续快速切歌时短时间并发突发轰炸 B 站搜索 API 触发 -412 风控。
 */
export function searchCandidates(
  query: string,
  num = 10
): Promise<SearchOutcome> {
  const run = async (): Promise<SearchOutcome> => {
    if (biliCooldown.active()) {
      return { candidates: [], rejected: true };
    }
    const elapsed = Date.now() - lastSearchTime;
    if (elapsed < MIN_SEARCH_GAP_MS) {
      await new Promise(r => setTimeout(r, MIN_SEARCH_GAP_MS - elapsed));
    }
    if (biliCooldown.active()) {
      return { candidates: [], rejected: true };
    }
    lastSearchTime = Date.now();
    return executeSearchCandidates(query, num);
  };

  const next = searchQueue.then(run, run);
  searchQueue = next.then(() => {}, () => {});
  return next;
}

async function executeSearchCandidates(
  query: string,
  num = 10
): Promise<SearchOutcome> {
  try {
    upstreamStats.search++;
    const res = await requestJson<BiliSearchResponse>(
      `${BILI_API}/x/web-interface/search/all/v2`,
      {
        query: { keyword: query },
        headers: biliHeaders(),
        timeoutMs: SEARCH_TIMEOUT_MS,
      }
    );

    if (res?.code === -412) {
      upstreamStats.rejected++;
      const coolMs = biliCooldown.trip('搜索风控 -412');
      log.warn(
        `搜索被风控拦截(-412)，进入冷却 ${Math.round(coolMs / 1000)}s。` +
          '请在 .env 中配置 SUENMUSIC_BILIBILI_COOKIE 以降低触发概率'
      );
      return { candidates: [], rejected: true };
    }

    if (res?.code !== undefined && res.code !== 0) {
      log.warn(`搜索返回异常 code=${res.code}，按无候选处理`);
      return { candidates: [], rejected: false };
    }

    const sections = res?.data?.result || [];
    let rawVideos: BiliSearchVideo[] = [];
    for (const sec of sections) {
      if (sec?.result_type === 'video') {
        rawVideos = sec.data || [];
        break;
      }
    }

    // 一次成功即清零冷却：偶发限流不该让服务长时间降级
    biliCooldown.reset();

    return {
      candidates: rawVideos.slice(0, num).map(v => ({
        bvid: v.bvid || '',
        // B 站会在标题里插入 <em class="keyword"> 高亮标签
        title: (v.title || '').replace(/<[^>]+>/g, ''),
        author: v.author || '',
        durationSec: parseDuration(v.duration),
        play: v.play,
        // 协议相对地址补全为 https；锚定弹窗拿它当缩略图
        pic: v.pic ? toHttps(v.pic) : undefined,
      })),
      rejected: false,
    };
  } catch (err) {
    log.warn(`搜索候选失败: ${(err as Error)?.message ?? err}`);
    return { candidates: [], rejected: false };
  }
}

export interface AudioStream {
  url: string;
  bandwidth: number;
  mimeType: string;
  fallback: boolean;
  /** 视频封面（https）。无 Q 音专辑封面的曲目用它做显示层兜底 */
  pic?: string;
}

interface BiliViewResponse {
  code?: number;
  data?: { cid?: number; pic?: string };
}

interface BiliPlayUrlAudio {
  baseUrl?: string;
  base_url?: string;
  bandwidth?: number;
  mimeType?: string;
  mime_type?: string;
}

interface BiliPlayUrlResponse {
  code?: number;
  data?: {
    dash?: { audio?: BiliPlayUrlAudio[] };
    durl?: Array<{ url?: string }>;
  };
}

/**
 * 获取选定视频的音频流地址。
 *
 * fnval=4048 表示同时请求 DASH / HDR / 4K / 杜比 / 8K，未登录时自动退化为普通
 * DASH；DASH 里的 audio 数组按码率降序取最高音质，而不是盲取第一项。
 */
export async function getAudioStream(bvid: string): Promise<AudioStream | null> {
  try {
    upstreamStats.view++;
    const view = await requestJson<BiliViewResponse>(
      `${BILI_API}/x/web-interface/view`,
      {
        query: { bvid },
        headers: biliHeaders(),
        timeoutMs: VIEW_TIMEOUT_MS,
      }
    );

    const cid = view?.data?.cid;
    if (!cid) {
      log.warn(`取 cid 失败: bvid=${bvid}`);
      return null;
    }
    // 封面顺路带回（view 响应自带，零额外请求）
    const pic = toHttps(String(view?.data?.pic ?? ''));

    upstreamStats.playurl++;
    const play = await requestJson<BiliPlayUrlResponse>(
      `${BILI_API}/x/player/playurl`,
      {
        query: { bvid, cid, fnval: 4048, fnver: 0, fourk: 1 },
        headers: biliHeaders(),
        timeoutMs: PLAYURL_TIMEOUT_MS,
      }
    );

    const data = play?.data;
    const audios = data?.dash?.audio || [];

    if (audios.length) {
      const best = [...audios].sort(
        (a, b) => (b.bandwidth || 0) - (a.bandwidth || 0)
      )[0];
      const raw = best?.baseUrl || best?.base_url;
      if (raw) {
        return {
          url: toHttps(raw),
          bandwidth: best.bandwidth || 0,
          mimeType: best.mimeType || best.mime_type || 'audio/mp4',
          fallback: false,
          pic,
        };
      }
    }

    // DASH 不可用时回落到 durl（音视频混合流）
    const durl = data?.durl?.[0]?.url;
    if (durl) {
      return {
        url: toHttps(durl),
        bandwidth: 0,
        mimeType: 'video/mp4',
        fallback: true,
        pic,
      };
    }

    log.warn(`取流失败: bvid=${bvid} cid=${cid}`);
    return null;
  } catch (err) {
    log.warn(`取流异常: bvid=${bvid} ${(err as Error)?.message ?? err}`);
    return null;
  }
}

function toHttps(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice(7)}` : url;
}

/**
 * 直连 BVID 或「搜索 -> 打分 -> 熔断 -> 取流」的完整流程。
 * 不带缓存，每次调用都会真实访问上游。
 */
export async function resolveTrackSource(
  track: ResolveInput
): Promise<ResolveResult> {
  // 0. 已绑定 BVID 时直接取流，跳过搜索
  const directBvid = track.bvid;
  if (directBvid) {
    const stream = await getAudioStream(directBvid);
    if (!stream) return fail('no_stream', '已绑定 BVID 但取流失败', { bvid: directBvid });
    return {
      ok: true,
      bvid: directBvid,
      sourceUrl: stream.url,
      score: 100,
      bandwidth: stream.bandwidth,
      fallbackStream: stream.fallback,
      coverUrl: stream.pic,
      source: 'bilibili',
    };
  }

  const query = buildQuery(track);
  log.debug(`搜索候选: "${query}" 目标时长 ${Math.round(track.durationMs / 1000)}s`);

  const { candidates, rejected } = await searchCandidates(query, 10);
  if (rejected) {
    return fail('rejected', 'B 站搜索被风控拦截，请配置 Bilibili Cookie');
  }
  if (!candidates.length) {
    return fail('no_candidates', `未找到候选视频（搜索词：${query}）`);
  }

  const matchTrack: MatchTrack = {
    name: track.name,
    artists: track.artists,
    durationMs: track.durationMs,
  };

  const scored = candidates
    .map(cand => {
      const { finalScore, durationDiff, durationSec } = scoreCandidate(
        matchTrack,
        cand
      );
      return { ...cand, score: finalScore, durationDiff, durationSec };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const topCandidates: CandidateBrief[] = scored.slice(0, 5).map(c => ({
    bvid: c.bvid,
    title: c.title,
    author: c.author,
    score: c.score,
    durationSec: c.durationSec,
  }));

  log.debug(
    `最佳候选 [${best.bvid}] ${best.title} | 分 ${best.score} | 时长差 ${best.durationDiff}s`
  );

  // 安全熔断：低于阈值拒绝播放，避免播放错误曲目
  if (best.score < config.matchThreshold) {
    return fail(
      'below_threshold',
      `最佳候选置信度 ${best.score} 低于阈值 ${config.matchThreshold}`,
      { bvid: best.bvid, score: best.score, topCandidates }
    );
  }

  const stream = await getAudioStream(best.bvid);
  if (!stream) {
    return fail('no_stream', '匹配成功但取流失败', {
      bvid: best.bvid,
      score: best.score,
      topCandidates,
    });
  }

  return {
    ok: true,
    bvid: best.bvid,
    sourceUrl: stream.url,
    score: best.score,
    matchedTitle: best.title,
    matchedAuthor: best.author,
    matchedDurationSec: best.durationSec,
    durationDiff: best.durationDiff,
    bandwidth: stream.bandwidth,
    fallbackStream: stream.fallback,
    coverUrl: stream.pic,
    topCandidates,
    /**
     * 必须显式带上：这是**搜索路径**，而锚点路径（见上方 bvid 直取分支）一直都有。
     * 漏了它，`resolveTrack()` 出来的 source 就是 undefined，调用方只能各写一处
     * `?? 'bilibili'` 兜底 —— 2026-10-20 审计的测试红灯正是这条
     * （`resolver-test` 的「多源解析命中有效源」）。
     */
    source: 'bilibili',
  };
}

/**
 * 拉取音频字节流，供 HTTP 层转发。
 *
 * Range 头必须透传：音乐播放器拖动进度条靠它，不透传就只能从头下完。
 * 同样必须带 Referer —— B 站 CDN 会校验，这正是"必须由服务端代理"的原因。
 */
export async function fetchAudioStream(
  url: string,
  range?: string,
  options: { method?: string; source?: 'bilibili' | 'netease' | 'kugou' } = {}
): Promise<Response> {
  upstreamStats.audio++;
  // 网易云 CDN 不需要（也不该带）B 站 Referer —— 带错头反而可能被拒。
  // 所以来源是 netease 时用干净的浏览器 UA，不带 Referer/Origin。
  const headers =
    options.source === 'netease'
      ? { 'User-Agent': BROWSER_UA }
      : options.source === 'kugou'
        ? // 酷狗 CDN 不校验 Referer，干净 UA 即可；**不能带 B 站 Referer 或账号 Cookie**
          { 'User-Agent': BROWSER_UA }
        : biliHeaders();
  if (range) headers.Range = range;

  return request(url, {
    method: options.method ?? 'GET',
    headers,
    timeoutMs: AUDIO_TIMEOUT_MS,
    retries: 0,
    stream: true,   // 长流：超时只到首包
  });
}
