/**
 * 音源解析路由。
 *
 * 返回的 `streamUrl` **不是** B 站的原始地址，而是服务端自己的
 * `/api/stream/<trackId>` —— 这一点是整个后端存在的核心理由之一：
 * B 站音频强校验 Referer，浏览器和安卓端都发不出，只有服务端能取到字节流。
 * 把裸地址丢给客户端等于让它必然 403。
 */

import type { FastifyInstance } from 'fastify';
import { qqCooldown } from '../sources/qq/search.ts';
import { biliCooldown } from '../sources/bilibili/stream.ts';
import { createLogger } from '../logger.ts';
import { requireUser } from '../http/require-auth.ts';
import { badRequest, notFound } from '../http/errors.ts';
import { parseId } from '../http/ids.ts';
import { strParam } from '../http/params.ts';
import { getSource } from '../db/repo/sources.ts';
import { deleteAnchor, getAnchor, saveAnchor } from '../db/repo/anchors.ts';
import { getTrack, upsertTracks } from '../db/repo/tracks.ts';
import { getSongDetail } from '../sources/qq/home.ts';
import {
  audioHeadersFor,
  buildQuery,
  searchCandidates,
  type ResolveInput,
} from '../sources/bilibili/stream.ts';
import type { ResolveResult } from '../sources/bilibili/stream.ts';
import { scoreCandidate } from '../sources/bilibili/matcher.ts';
import { cacheKeyFor, invalidateTrack, resolveTrack, whitelistQuality } from '../services/resolver.ts';
import { getPin, setPin, deletePin } from '../db/repo/pins.ts';
import { resolveKugouSource } from '../sources/kugou/stream.ts';
import {
  buildKugouVerifyUrl,
  isKugouVerifyPending,
  signKugouVerifyToken,
} from '../services/kugou-verify.ts';
import { resolveNeteaseSource } from '../sources/netease/source.ts';
import type { ResolveOutcome } from '../services/resolver.ts';
import { buildStreamUrl, signStreamToken, STREAM_TOKEN_TTL_MS } from '../utils/stream-token.ts';
import { isIosClient, wantsMp3 } from '../http/platform.ts';

const log = createLogger('routes:resolve');

/**
 * 直链通道开关（默认开）。
 *
 * 设 SUENMUSIC_DIRECT_LINK=off 即回退「纯服务端代理」，无需发版 —— 防盗链策略变化时用这个开关兜命。
 * 注意：代理（streamUrl）永远保留，直链只是**优先通道**。
 */
function directEnabled(): boolean {
  return (process.env.SUENMUSIC_DIRECT_LINK ?? 'on').toLowerCase() !== 'off';
}

/** BVID 形如 BV + 10 位字母数字 */
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;

/**
 * 归一化音质参数（doc2 §四.1）：白名单命中就用它（统一小写），否则按平台缺省 ——
 * iOS 缺省 exhigh（避开 FLAC 的播放器兼容问题），其他端缺省 lossless。
 *
 * 白名单本身由 services/resolver.ts 提供（与缓存键规则同一个家）：
 * 代理侧读键前也要过同一份名单，两处各留一份迟早漂移。
 */
function normalizeQuality(raw: string, ios: boolean): string {
  return whitelistQuality(raw) ?? (ios ? 'exhigh' : 'lossless');
}

type TrackMeta = Awaited<ReturnType<typeof loadTrack>>;

function shape(
  outcome: ResolveOutcome,
  meta: TrackMeta = null,
  preferMp3 = false,
  quality?: string,
): Record<string, unknown> {
  // 读的键必须与 resolver 写的是同一个（cacheKeyFor）：否则带 quality 的请求永远读不到本次
  // 解析写下的那一行，反而取到别的档位/别的音源的历史行（directUrl、directHeaders、source 一起错）。
  const row = outcome.ok ? getSource(cacheKeyFor(outcome.trackId, preferMp3, quality)) : null;
  /**
   * 需要验证的判定**只看本次解析**：outcome.verifyRequired（酷狗 /tracker/v5/url 真撞到
   * 20028 时由 sources/kugou/stream.ts 置位）。
   *
   * 旧写法是「有活跃验证事件（30 分钟）就算」—— 只要之前撞过一次，接下来 B 站失败、
   * 上游超时、网络断开全被标成 need_verification，客户端弹验证页却没有任何可验的东西。
   * 缓存行里残留的 reason=need_verification 仍然算数（负缓存 60s，验证通过后会被清掉）。
   *
   * verifyUrl 同理只在这种情况下下发：移动端拿到它就能直接丢给系统浏览器
   * （token 是服务端签发的短期票据）。没有活跃事件时给空 —— 空票据的验证页没有意义，
   * 客户端要入口请打 GET /api/kugou/verify/pending（登录态，每次签新票据）。
   */
  const verifyRequired =
    !outcome.ok && (outcome.verifyRequired === true || outcome.reason === 'need_verification');
  const verifyUrl = verifyRequired && isKugouVerifyPending() ? buildKugouVerifyUrl(signKugouVerifyToken()) : null;
  // 音质只报实际值：拿不准一律 standard（宁可少报，绝不虚报）
  const effectiveQuality = outcome.currentQuality || row?.currentQuality || 'standard';
  const effectiveAvailable =
    (outcome.availableQualities?.length ? outcome.availableQualities : undefined) ??
    (row?.availableQualities.length ? row.availableQualities : undefined) ??
    ['standard'];

  /**
   * 失败分两类（用户拍板）：
   *   1. 服务端不可达 / 音源不可用 → 瞬间可知，客户端提示"网络连接失败"并跳下一首再试
   *   2. **上游限速/限流/硬控** → 等一会就能恢复，客户端要改成"当前网络繁忙，请等待"，
   *      并且**不能继续狂试**（要留时间给 QQ/B站/网易恢复）
   *
   * 这里把第 2 类显式标出来（各源的冷却对象就是限速信号），客户端据此分流。
   */
  const rateLimited = !outcome.ok && (qqCooldown.active() || biliCooldown.active());
  const retryAfterMs = Math.max(
    qqCooldown.active() ? qqCooldown.snapshot().remainingMs : 0,
    biliCooldown.active() ? biliCooldown.snapshot().remainingMs : 0
  );

  return {
    trackId: outcome.trackId,
    ok: outcome.ok,
    /**
     * 酷狗因为 20028（需要验证码）拿不到流时，reason 单独标成 need_verification ——
     * 客户端据此弹「去完成验证」，而不是按普通网络失败提示。
     */
    reason: verifyRequired ? 'need_verification' : (outcome.reason ?? null),
    rateLimited,
    retryAfterMs,
    message: outcome.message ?? null,
    /** 需要验证时的验证页地址（带短期票据）；不需要时为 null */
    verifyUrl,
    score: outcome.score,
    bvid: outcome.bvid,
    matchedTitle: outcome.matchedTitle ?? null,
    matchedAuthor: outcome.matchedAuthor ?? null,
    durationDiff: outcome.durationDiff ?? null,
    /** true 表示 DASH 不可用、回落到了音视频混合流 */
    fallbackStream: outcome.fallbackStream ?? false,
    bandwidth: outcome.bandwidth ?? 0,
    /**
     * 音源来源（bilibili / netease）。客户端用它显示音源角标；
     * 缓存命中时以库里那份为准，缺省视为 bilibili。
     */
    source: row?.source ?? outcome.source ?? 'bilibili',
    /**
     * 服务端地址（已带短期令牌）。客户端直接拿它喂给播放器 ——
     * 不要自己去取 B 站地址，那条路必然 403。
     */
    // 档位一并透传：代理侧要靠它读同一个缓存键（S-16，见 buildStreamUrl 注释）
    streamUrl: outcome.ok ? buildStreamUrl(outcome.trackId, undefined, quality) : null,
    /**
     * **直链通道**（设备直接向 CDN 取流，不经过服务端）。
     *
     * 为什么要有它：服务端代理意味着每次播放都占服务端上行带宽（历史上还被限速 40KB/s 拖过），
     * 而设备本来就是全程联网的。直链让服务端只做「解析 + 令牌」，容量模型从按带宽变成按 QPS。
     *
     * ⚠️ 客户端**必须**带上 directHeaders 再去取，否则 B 站 CDN 403（这是它防盗链的全部要求）。
     * ⚠️ 链接会过期（B 站约 2 小时）：请在 directExpiresInSec 前 X 分钟重新解析；
     *    播放中遇到 403/失败，**回退到 streamUrl**（代理兜底），不要直接报错。
     * ⚠️ 可用 SUENMUSIC_DIRECT_LINK=off 一键关闭（回退纯代理，无需发版）。
     */
    directUrl: directEnabled() && outcome.ok ? (row?.audioUrl || outcome.sourceUrl || null) : null,
    directHeaders:
      directEnabled() && outcome.ok
        ? audioHeadersFor((row?.source ?? outcome.source ?? 'bilibili') as 'bilibili' | 'netease' | 'kugou')
        : null,
    /** 直链剩余有效期（秒）：与音源缓存同口径，到期必须重新解析 */
    directExpiresInSec:
      directEnabled() && row ? Math.max(0, Math.round((row.expiresAt - Date.now()) / 1000)) : 0,
    /** 令牌有效期（秒），客户端可据此在过期前重新解析 */
    streamTokenExpiresInSec: outcome.ok
      ? Math.round(STREAM_TOKEN_TTL_MS / 1000)
      : 0,
    /** 音源缓存剩余有效秒数 */
    expiresInSec: row ? Math.max(0, Math.round((row.expiresAt - Date.now()) / 1000)) : 0,
    /** 缓存命中层级：memory / db / upstream / cooldown */
    hitLevel: outcome.hitLevel,
    costMs: outcome.costMs,
    topCandidates: outcome.topCandidates ?? [],
    /**
     * B 站视频封面（https）。曲目没有 Q 音专辑封面时的显示层兜底；
     * 客户端发现 track.al 无封面时用这份顶上。
     */
    coverUrl: outcome.coverUrl ?? null,
    /**
     * 完整曲目元数据（含专辑/封面）。队列里的曲目可能来自字段不全的
     * 搜索召回行，客户端用这份把缺的封面/专辑现场补上。
     */
    track: meta?.raw ?? null,
    /** 当前实际生效音质：lossless / exhigh / high / standard */
    currentQuality: effectiveQuality,
    /** 本曲可用音质档位列表（音源层真实产出，未知时只报 standard） */
    availableQualities: effectiveAvailable,
  };
}

/**
 * 取曲目元数据。本地缓存 miss 时回源 QQ 一次 ——
 * 这样客户端不必先访问 `/api/tracks/:id` 才能解析音源。
 *
 * 专辑信息（名 / 封面）一并带出：锚定弹窗要拿 Q 音原版封面做参照，
 * 用户对着原版挑 B 站视频才不会认错 live / 翻唱。
 */
async function loadTrack(trackId: string): Promise<{
  id: string;
  name: string;
  artists: string[];
  durationMs: number;
  albumName: string;
  albumPic: string;
  raw: Record<string, unknown>;
} | null> {
  const cached = getTrack(trackId);
  // 缓存命中且元数据完整就直接用。搜索召回的行可能没挂专辑字段
  // （DJ版/单曲/综艺版本在 QQ 侧常无专辑数据），这类残缺行要回源详情
  // 补一次全 —— 只看"缓存存在"会让残缺行永远得不到修复。
  if (cached?.al?.mid) return shapeTrack(cached);

  const parsed = parseId(trackId);
  if (!parsed || parsed.kind !== 'track') {
    return cached ? shapeTrack(cached) : null;
  }

  const fetched = await getSongDetail(parsed.value);
  if (fetched) {
    // 合并而不是整体覆盖：详情接口的歌名可能是截断的主名（"女孩"），
    // 而搜索行带着完整显示名（"女孩 (DJ版)"）—— 保留更长的那个；
    // 专辑/歌手字段则一律以详情为准（搜索行常缺失）。
    const merged =
      cached && (cached.name?.length ?? 0) > (fetched.name?.length ?? 0)
        ? { ...fetched, name: cached.name }
        : fetched;
    upsertTracks([merged]);
    return shapeTrack(merged);
  }

  return cached ? shapeTrack(cached) : null;
}

function shapeTrack(t: {
  id: string;
  name: string;
  ar?: Array<{ name?: string | null }>;
  dt?: number;
  al?: { name?: string; picUrl?: string };
}) {
  return {
    id: t.id,
    name: t.name,
    artists: (t.ar || []).map(a => a.name).filter((s): s is string => Boolean(s)),
    durationMs: t.dt || 0,
    albumName: t.al?.name || '',
    albumPic: t.al?.picUrl || '',
    /** 完整 QQ 元数据原样带回（含 al），客户端用来补全残缺的队列曲目 */
    raw: t as unknown as Record<string, unknown>,
  };
}

export function registerResolveRoutes(app: FastifyInstance): void {
  /**
   * 解析单曲音源。
   *
   * `?force=1` 清掉全部缓存层重新解析 —— 客户端遇到播放 403 时用。
   * `?retry=1` 只无视「缓存的失败」，成功缓存照常命中 —— 用户手点重试/重播时用。
   *   否则一条失败结果会在负缓存周期内让这首歌怎么重试都播不出来。
   */
  app.get('/api/resolve/:trackId', async req => {
    requireUser(req);

    const raw = (req.params as any).trackId as string;
    const parsed = parseId(raw);
    if (!parsed) throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    if (parsed.kind !== 'track') {
      throw badRequest(`这不是曲目 id：${raw}`, 'invalid_id');
    }

    const trackId = parsed.raw;
    const force = ['1', 'true', 'yes'].includes(strParam((req.query as any)?.force).toLowerCase());
    const retry = ['1', 'true', 'yes'].includes(strParam((req.query as any)?.retry).toLowerCase());
    // 平台身份与「要 mp3 容器」是两件事：iOS 身份决定缺省音质，mp3 偏好决定容器
    const ios = isIosClient(req);
    const preferMp3 = wantsMp3(req);
    const quality = normalizeQuality(strParam((req.query as any)?.quality), ios);

    const meta = await loadTrack(trackId);
    if (!meta) throw notFound('曲目不存在');

    const outcome = await resolveTrack(
      {
        id: meta.id,
        name: meta.name,
        artists: meta.artists,
        durationMs: meta.durationMs,
        // 无 Q 音专辑封面时网易云路径会去取网易云侧专辑封面（显示层兜底）
        hasAlbumCover: Boolean(meta.albumPic),
      },
      { force, retry, preferMp3, quality }
    );

    log.debug(
      `resolve ${trackId} ok=${outcome.ok} hit=${outcome.hitLevel} ${outcome.costMs}ms`
    );

    return shape(outcome, meta, preferMp3, quality);
  });

  /**
   * 批量解析（播放队列预取）。
   *
   * 串行执行而不是并发：并发 10 首会把 B 站搜索瞬间打到风控，
   * 而预取本来就是后台行为，慢一点无所谓。
   */
  app.post('/api/resolve/batch', async req => {
    requireUser(req);

    const ios = isIosClient(req);
    const preferMp3 = wantsMp3(req);
    const body = (req.body ?? {}) as { trackIds?: unknown; quality?: unknown };
    // 与单曲接口同规则：归一化后再进缓存键与 shape()，否则批量预取会写出一批平行键
    const quality = normalizeQuality(strParam(body.quality), ios);
    const ids = Array.isArray(body.trackIds)
      ? body.trackIds.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : [];
    if (ids.length === 0) throw badRequest('缺少 trackIds', 'missing_param');

    const results: Record<string, unknown>[] = [];
    for (const raw of ids) {
      const parsed = parseId(raw);
      if (!parsed || parsed.kind !== 'track') {
        results.push({ trackId: raw, ok: false, reason: 'error', message: 'id 不合法' });
        continue;
      }

      const meta = await loadTrack(parsed.raw);
      if (!meta) {
        results.push({ trackId: parsed.raw, ok: false, reason: 'error', message: '曲目不存在' });
        continue;
      }

      const outcome = await resolveTrack({
        id: meta.id,
        name: meta.name,
        artists: meta.artists,
        durationMs: meta.durationMs,
      }, { preferMp3, quality });
      results.push(shape(outcome, meta, preferMp3, quality));
    }

    return { results };
  });

  // -----------------------------------------------------------------------
  // 手动锚定（低置信曲目的人工兜底）
  //
  // 低置信（below_threshold）/无候选的曲目在锚定弹窗里走这里：
  // 搜 B 站候选 → 逐条试听 → 锚定入库（track_anchors，永久）。
  // 之后 resolver 直接按锚点取流，永远可播。
  // -----------------------------------------------------------------------

  /**
   * B 站候选搜索。`keyword` 缺省时用「歌名 + 主歌手」自动构造。
   * 每条候选带按曲目元数据算出的置信分、**封面缩略图**与**试听流地址**；
   * 响应同时带上曲目自己的 Q 音专辑信息（封面参照物）。
   */
  app.get('/api/tracks/:id/bili-candidates', async req => {
    requireUser(req);

    const raw = (req.params as any).id as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') {
      throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    }
    const meta = await loadTrack(parsed.raw);
    if (!meta) throw notFound('曲目不存在');

    const keyword = strParam((req.query as any)?.keyword).trim() || buildQuery(meta);
    const { candidates, rejected } = await searchCandidates(keyword, 10);

    if (rejected) {
      return {
        keyword,
        rejected: true,
        message: 'B 站搜索被风控拦截，请稍后重试或配置 Bilibili Cookie',
        candidates: [],
        track: meta,
      };
    }

    const matchTrack = {
      name: meta.name,
      artists: meta.artists,
      durationMs: meta.durationMs,
    };

    return {
      keyword,
      rejected: false,
      /** 曲目自己的 Q 音元数据：弹窗里当「原版参照」展示 */
      track: meta,
      candidates: candidates.map(c => {
        const { finalScore, durationDiff } = scoreCandidate(matchTrack, c);
        const streamKey = `bvid:${c.bvid}`;
        return {
          bvid: c.bvid,
          title: c.title,
          author: c.author,
          durationSec: c.durationSec,
          score: finalScore,
          durationDiff,
          pic: c.pic ?? '',
          /** 试听地址。令牌签给 `bvid:<bvid>` 这个 key，走 /api/stream/bvid/:bvid */
          previewUrl: `/api/stream/bvid/${encodeURIComponent(c.bvid)}?t=${signStreamToken(streamKey)}`,
        };
      }),
    };
  });

  /** 锚定当前锚点（弹窗回显用） */
  app.get('/api/tracks/:id/anchor', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') {
      throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    }
    return { anchor: getAnchor(parsed.raw) };
  });

  /**
   * 锚定：把「这首曲 = 这个 B 站视频」永久入库。
   * 手动锚定为最高优先级，自动匹配沉淀的映射不能覆盖它。
   */
  app.post('/api/tracks/:id/anchor', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') {
      throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    }

    const body = (req.body ?? {}) as {
      bvid?: unknown;
      title?: unknown;
      author?: unknown;
      durationSec?: unknown;
    };
    const bvid = String(body.bvid ?? '').trim();
    if (!BVID_RE.test(bvid)) {
      throw badRequest(`bvid 不合法：${bvid}`, 'invalid_param');
    }

    saveAnchor(
      parsed.raw,
      {
        bvid,
        title: String(body.title ?? '').slice(0, 300),
        author: String(body.author ?? '').slice(0, 120),
        durationSec: Number(body.durationSec) || 0,
      },
      true
    );
    // 手动锚定 B 站 = 用户最新的一次选择 → 清掉之前的源钉，
    // 否则钉会继续压住锚点（resolver 里钉优先），用户会觉得「锚了没反应」。
    deletePin(parsed.raw);
    // 清掉解析缓存，下一次解析立即走锚点（否则短 TTL 的旧失败结果还在）
    invalidateTrack(parsed.raw);
    log.info(`曲目已锚定 ${parsed.raw} → ${bvid}`);

    return { ok: true, trackId: parsed.raw, bvid };
  });

  /**
   * 各音源可用性（锚定页三态展示用）。
   *
   * 返回酷狗 / 网易云 / B 站各自「有无可用音源 + 匹配摘要」，让用户自己决定锚谁。
   * 并发查三源；B 站给 top1 候选摘要（锚定要选具体视频），酷狗/网易云给命中曲目摘要。
   * 结果不落缓存（锚定页是低频手动操作）。
   */
  app.get('/api/resolve/:trackId/availability', async req => {
    requireUser(req);
    const raw = (req.params as any).trackId as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    const meta = await loadTrack(parsed.raw);
    if (!meta) throw notFound('曲目不存在');

    const input: ResolveInput = {
      id: parsed.raw,
      name: meta.name,
      artists: meta.artists,
      durationMs: meta.durationMs,
    };

    const [kugouR, neteaseR, biliCand] = await Promise.all([
      resolveKugouSource(input).catch(err => ({ ok: false, message: (err as Error).message } as ResolveResult)),
      resolveNeteaseSource(input).catch(err => ({ ok: false, message: (err as Error).message } as ResolveResult)),
      (async () => {
        const keyword = buildQuery(meta);
        const { candidates } = await searchCandidates(keyword, 5);
        return candidates;
      })().catch(() => []),
    ]);

    return {
      kugou: {
        ok: kugouR.ok,
        title: kugouR.matchedTitle ?? null,
        author: kugouR.matchedAuthor ?? null,
        message: kugouR.ok ? null : (kugouR.message ?? null),
      },
      netease: {
        ok: neteaseR.ok,
        title: neteaseR.matchedTitle ?? null,
        author: neteaseR.matchedAuthor ?? null,
        message: neteaseR.ok ? null : (neteaseR.message ?? null),
      },
      bilibili: {
        ok: biliCand.length > 0,
        top: biliCand[0] ? { bvid: biliCand[0].bvid, title: biliCand[0].title, author: biliCand[0].author } : null,
        count: biliCand.length,
      },
    };
  });

  /**
   * 源钉（用户指定该曲只用某源）：设置 / 查询 / 清除。
   * resolve 时 pin 优先于默认链；钉外的源全部跳过（不落回，用户指令不许被悄悄违背）。
   */
  app.put('/api/tracks/:id/pin-source', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    const body = (req.body ?? {}) as { source?: string };
    const source = String(body.source ?? '');
    if (source !== 'kugou' && source !== 'netease') {
      throw badRequest('source 只支持 kugou / netease（B 站用锚点，无需钉）', 'invalid_source');
    }
    setPin(parsed.raw, source);
    invalidateTrack(parsed.raw);
    return { ok: true, trackId: parsed.raw, source };
  });

  app.get('/api/tracks/:id/pin-source', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    const pin = getPin(parsed.raw);
    return { ok: true, trackId: parsed.raw, source: pin?.source ?? null };
  });

  app.delete('/api/tracks/:id/pin-source', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    deletePin(parsed.raw);
    invalidateTrack(parsed.raw);
    return { ok: true, trackId: parsed.raw };
  });

  /** 解除锚定。之后该曲目回到正常自动匹配（可能又变成低置信不播） */
  app.delete('/api/tracks/:id/anchor', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') {
      throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    }
    deleteAnchor(parsed.raw);
    invalidateTrack(parsed.raw);
    return { ok: true, trackId: parsed.raw };
  });
}
