/**
 * 音频流代理（P5）。
 *
 * 这是整个后端存在的核心理由之一。四件必须做对的事：
 *
 * 1. **代理字节流，不能 302 跳转**
 *    B 站 CDN 校验 Referer，浏览器和安卓端都发不出正确的头部。
 *    302 过去看起来"更省服务器带宽"，实际结果是客户端必然 403。
 *
 * 2. **透传 Range 并原样回传 Content-Range**
 *    播放器拖进度条靠 Range。不透传就只能从头下完才能跳；
 *    不回传 Content-Range，客户端算不出总时长、进度条就废了。
 *    因此 `Accept-Ranges: bytes` 必须始终存在，哪怕这次不是 206。
 *
 * 3. **403 时重解析一次**
 *    B 站音频地址带签名时效，缓存里的地址可能已过期。
 *    过期不是客户端的错，不能把 403 透传出去让用户看到"播放失败"。
 *
 * 4. **由 handler 返回 payload，不在这里调用 `reply.send(stream)`**
 *    Fastify 5 的 `reply.sent` 取的是 `res.writableEnded`，而 stream 只是
 *    开始 pipe、尚未 end。async handler 一旦 resolve，框架兜底逻辑
 *    （`wrap-thenable.js`）会认为"还没发出去"，于是再补一次空 `reply.send()`，
 *    把响应覆盖成 `content-length: 0` —— 现象是 **206 + 正确的 Content-Range，
 *    但一个字节都没有**，极难从日志看出来。
 *    把 payload 交给框架发送则走 `payload !== undefined` 分支，不会二次发送。
 *
 * 认证：`<audio src>` 发不出 Authorization，因此接受两种凭据 ——
 * 查询参数里的短期令牌（由 `/api/resolve` 签发），或 Bearer 访问令牌（程序化调用）。
 */

import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { createThrottle } from '../utils/throttle-stream.ts';
import { createLogger } from '../logger.ts';
import { badRequest, notFound, unauthorized } from '../http/errors.ts';
import { parseId } from '../http/ids.ts';
import { strParam } from '../http/params.ts';
import { extractBearer } from '../utils/jwt.ts';
import { verifyAccessToken } from '../services/auth.ts';
import { requireUser } from '../http/require-auth.ts';
import {
  SESSION_STREAM_TOKEN_TTL_MS,
  signSessionStreamToken,
  verifyStreamToken,
} from '../utils/stream-token.ts';
import { getSource } from '../db/repo/sources.ts';
import { getAnchor } from '../db/repo/anchors.ts';
import { getTrack, upsertTracks } from '../db/repo/tracks.ts';
import { getSongDetail } from '../sources/qq/home.ts';
import { fetchAudioStream, resolveTrackSource } from '../sources/bilibili/stream.ts';
import { invalidateTrack, resolveTrack } from '../services/resolver.ts';

const log = createLogger('routes:stream');

/** 上游静默多久算"卡死"（音频流空闲守护，见 forward 内注释） */
/**
 * 中途空闲守护：上游超过这个时间没吐任何字节就放弃本条流。
 *
 * 用户拍板 8 秒：容忍一两秒抖动（那一刻不该打扰用户 —— 实测也确实很少遇到），
 * 但也不能像以前那样静默等 30 秒（用户盯着进度条不动、毫无提示）。
 * 掐断后 ExoPlayer 会报错，客户端据此走"播到一半失败"的处置链。
 */
const STREAM_IDLE_MS = 8_000;

/**
 * 从上游响应复制到客户端的头。其余（如 CDN 的内部头）不带出去。
 *
 * ⚠️ **`content-length` 必须透传**（2026-09-11 实测教训）：
 * Chromium 对没有 `Content-Length` 的媒体资源会把 `seekable` 算成**空区间**
 * —— `<audio>` 整条流被判定为不可 seek，拖动进度条被静默弹回缓冲区
 * （表现为"seeked 事件都触发了，但 currentTime 没动"），且换流重试也救不了。
 * 206 响应里的 `Content-Length` 就是本次区间的字节数，语义精确、与实际发送
 * 的字节一致；200 全量时是文件总长，同样正确。此前"交给框架按 chunked
 * 处理更安全"的担心只适用于无 payload 的 HEAD 路径（那边框架会覆盖，
 * 见下），GET 路径必须带上。
 */

/**
 * 计算本条流的节流速率（字节/秒）。
 *
 * 依据：响应里的字节数 ÷ 曲目时长 × 1.3（留 30% 余量掩盖网络抖动），
 * 下限 32KB/s（避免极短/未知时长时把速率算得过低导致卡顿）。
 * 算不出（无时长/无字节数）→ 返回 undefined = 不节流（宁可不节，不能卡）。
 */
function streamRate(upstream: Response, durationMs: number, hasRange: boolean): number | undefined {
  if (process.env.NODE_ENV === 'test') return undefined;
  // 无 Range（全量拉取 / 测试 / 离线下载）不节流：
  // 1. 全量文件慢速拉取会被上游 CDN 连接保护强行切断（Slowloris 防护报 terminated）
  // 2. 只有带 Range 的流式播放才需要防止预缓冲突发打满上行
  if (!hasRange) return undefined;
  if (!durationMs || durationMs <= 0) return undefined;

  let bytes = Number(upstream.headers.get('content-length'));
  const range = upstream.headers.get('content-range');
  if (range) {
    const total = Number(range.split('/') [1]);
    if (Number.isFinite(total) && total > 0) bytes = total;   // 206 时 content-length 是区间大小，总数才是全曲
  }
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;

  const sec = durationMs / 1000;
  const rate = bytes / sec;                                    // 字节/秒 = 全曲字节 ÷ 时长秒数
  return Math.max(Math.round(rate * 1.3), 40_000);
}

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

/**
 * 从文件头字节认容器（与 iOS 侧 `AudioCacheStore.sniffContentType` 同口径）。
 *
 * 为什么需要：上游（B 站）常把音频声明成 `application/octet-stream`，
 * 浏览器/鸿蒙播放器会自己嗅探，**iOS 的 AVPlayer 不会** —— 它会因为 MIME 不认识而
 * 永远不进入 readyToPlay（表现为「点了不出声」）。服务端这里补一次嗅探，对所有客户端都对。
 */
function sniffAudioType(head: Buffer | null): string | null {
  if (!head || head.length < 12) return null;
  const at = (offset: number, tag: string): boolean =>
    head.length >= offset + tag.length &&
    head.subarray(offset, offset + tag.length).toString('latin1') === tag;
  if (at(4, 'ftyp')) return 'audio/mp4';       // MP4/CMAF（B 站 m4s 分片同此）
  if (at(0, 'ID3')) return 'audio/mpeg';
  if (at(0, 'fLaC')) return 'audio/flac';
  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  // 裸 MPEG 帧同步
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

/**
 * 取出流的第一个 chunk（用于嗅探容器），**不销毁流**。
 *
 * ⚠️ 不能用 `for await ... return`：从异步迭代器提前 return 会调用 iterator.return()，
 *   把 Node 流 destroy 掉，后续数据全丢（实测响应被截成 ~16KB）。
 *   这里用 `read()` / 'readable' 事件，取完立刻 pause，等下游接上再 resume。
 */
async function peekFirstChunk(stream: Readable): Promise<Buffer | null> {
  const immediate = stream.read() as Buffer | null;
  if (immediate) return immediate;
  return await new Promise<Buffer | null>((resolve) => {
    const done = (value: Buffer | null) => {
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      resolve(value);
    };
    const onReadable = () => {
      const chunk = stream.read() as Buffer | null;
      if (chunk) {
        stream.pause();
        done(chunk);
      }
    };
    const onEnd = () => done(null);
    stream.once('readable', onReadable);
    stream.once('end', onEnd);
  });
}
function authorize(req: any, trackId: string): string {
  const query = req.query as Record<string, unknown>;

  // 1. 查询参数里的短期流令牌（<audio> 只能用这种方式）
  const token = strParam(query.t);
  if (token) {
    if (verifyStreamToken(trackId, token)) return 'stream-token';
    throw unauthorized('播放令牌无效或已过期，请重新解析音源');
  }

  // 2. Bearer 访问令牌（程序化调用、网页端用 fetch 拉音频）
  const bearer = extractBearer(req.headers.authorization);
  if (bearer) {
    if (verifyAccessToken(bearer)) return 'access-token';
    throw unauthorized('访问令牌无效或已过期');
  }

  throw unauthorized('缺少播放凭据：请先调用 /api/resolve/:trackId 获取带令牌的 streamUrl');
}

/**
 * 把上游响应头铺到 reply 上，并把要发送的 payload **返回**给调用方。
 *
 * 返回值语义：
 *   - `Readable`：交给 handler 返回，由框架发送
 *   - `undefined`：HEAD / 空响应，已经调用过 `reply.send()`（无 body，同步结束，安全）
 */
async function forward(
  reply: any,
  upstream: Response,
  headOnly: boolean,
  bytesPerSec?: number,
  durationMs?: number
): Promise<Readable | undefined> {
  reply.code(upstream.status);

  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) reply.header(name, value);
  }

  /**
   * ★ 把**真实时长**用自定义头带给客户端。
   *
   * 为什么必须有这个头：`Content-Range` 斜杠后是**字节总数**，从字节数推不出时长；
   * 而曲目元数据（Q 音）在"锚定到时长不同的视频"时是错的 —— 真机报障原话：
   * 「选了 2 分多的音源，界面还显示 3 分多，播完自动切歌」。
   * 这里给的是**实际匹配到的视频时长**（含手动锚点），是唯一准确的来源。
   */
  if (durationMs && durationMs > 0) {
    reply.header('X-Audio-Duration-Ms', String(Math.round(durationMs)));
  }

  // HEAD 走的是无 payload 路径，框架会覆盖 content-length（见下），
  // 而 bytes=0-0 探针的上游 content-length=1 对客户端也没有意义 —— 去掉
  if (headOnly) {
    reply.removeHeader('content-length');
  }

  // 即便上游没给，也要声明支持 Range —— 否则部分播放器直接放弃拖动
  if (!upstream.headers.get('accept-ranges')) {
    reply.header('Accept-Ranges', 'bytes');
  }

  // 音频地址本身带时效，缓存时间保守取 10 分钟
  reply.header('Cache-Control', 'private, max-age=600');

  if (headOnly || !upstream.body) {
    // HEAD 或空响应：必须把上游 body 取消掉，否则连接泄漏。
    // 这里没有 payload，只能直接 send —— 无 body 的 send 是同步结束的，
    // 不会踩到上面第 4 条描述的"响应未 end"问题。
    //
    // 注意：框架会给无 payload 的响应写 `content-length: 0`，且**显式设置
    // `Content-Length` 也会被覆盖**（实测）。对我们的 HEAD 而言这不致命，
    // 因为总长度由 `content-range` 表达（见 handler 里的 `bytes=0-0` 处理）。
    try {
      await upstream.body?.cancel();
    } catch {
      // 已经结束的流取消会抛错，忽略
    }
    reply.send();
    return undefined;
  }

  const rawStream = Readable.fromWeb(upstream.body as any);
  // content-type 缺失或上游只给 octet-stream 时，嗅探首个 chunk 补成真正的音频类型
  const declaredType = (upstream.headers.get('content-type') ?? '').toLowerCase();
  let bodyStream: Readable = rawStream;
  if (declaredType === '' || declaredType.includes('octet-stream')) {
    const first = await peekFirstChunk(rawStream);
    const sniffed = sniffAudioType(first);
    if (sniffed) {
      reply.header('content-type', sniffed);
      log.info(`stream: 上游 ${declaredType || '(空)'} → 嗅探为 ${sniffed}`);
    }
    if (first) {
      bodyStream = Readable.from(
        (async function* () {
          yield first;
          rawStream.resume();
          for await (const chunk of rawStream) yield chunk;
        })()
      );
    }
  }
  const stream = bodyStream;

  /**
   * 空闲守护：上游超过 STREAM_IDLE_MS 没有任何字节就放弃。
   *
   * 因为音频取流已改成"首包超时、body 不限时"（见 utils/http.ts 的 stream 选项），
   * 需要另一条防线兜住"CDN 中途静默"——否则这条连接会一直挂着，
   * 占用上游 socket 也让客户端永远等下去。
   */
  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.warn(`上游空闲超时（${STREAM_IDLE_MS / 1000}s 无数据），放弃本条流`);
      stream.destroy(new Error('上游空闲超时'));
    }, STREAM_IDLE_MS);
  };
  resetIdle();
  stream.on('close', () => { if (idleTimer) clearTimeout(idleTimer); });

  /**
   * 流错误必须有人接住，否则 = 进程崩溃。
   *
   * 实测崩溃路径：fetchAudioStream 的 AbortController 超时触发时，
   * `upstream.body` 这个 Readable 会 emit 'error'（TimeoutError）——
   * pipe 不会转发 error，而没人监听的 'error' 事件会把整个服务端带走
   * （多用户场景 = 所有人一起掉线）。这里吞掉错误并掐断客户端连接：
   * 客户端的 <audio> 会收到连接中断，走它自己的重试/换源逻辑。
   */
  const abortClient = (err: Error) => {
    log.warn(`音频流中断: ${err.message}`);
    try {
      (reply.raw.socket ?? reply.raw)?.destroy();
    } catch {
      /* 连接可能已断 */
    }
  };
  stream.on('error', abortClient);

  // 客户端断开连接时，必须立即销毁上游流，防止连接与内存泄漏
  reply.raw.on('close', () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!stream.destroyed) stream.destroy();
  });

  // 上行节流：按真实码率的 1.3 倍匀速输出。多用户共享家里上行时，
  // 没有这层节流，预缓冲的突发会把运营商限速的上行瞬间打满（5Mbps 场景）
  if (!bytesPerSec) return stream;
  const throttled = stream.pipe(createThrottle(bytesPerSec, resetIdle));
  throttled.on('error', abortClient);   // 节流器自身异常同样不能冒泡
  throttled.on('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  return throttled;
}

export function registerStreamRoutes(app: FastifyInstance): void {
  const handler = async (req: any, reply: any): Promise<unknown> => {
    const raw = req.params.trackId as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') {
      throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    }

    const trackId = parsed.raw;
    const authMethod = authorize(req, trackId);
    const headOnly = req.method === 'HEAD';

    // 客户端送来的 Range 原样转给上游
    const range =
      typeof req.headers.range === 'string' ? req.headers.range : undefined;

    /**
     * HEAD 且客户端没给 Range 时，主动向上游要 `bytes=0-0`。
     *
     * 原因是"这文件多大"必须答得出来：
     *   - HEAD 走无 payload 路径，框架会把 `Content-Length` 覆盖成 `0`（实测）
     *   - `Content-Length: 0` 会让客户端以为音频是空的 —— 比不返回更糟
     * 于是改问一个 1 字节区间：上游回 206 + `Content-Range: bytes 0-0/<总数>`，
     * 总长度就通过我们本来就会透传的头带回来了。
     */
    const upstreamRange = range ?? (headOnly ? 'bytes=0-0' : undefined);

    const row = getSource(trackId);
    let upstream: Response | null = null;
    /** 缓存里的地址已被上游拒绝，需要强制重解析 */
    let urlExpired = false;

    if (row?.ok && row.audioUrl) {
      try {
        upstream = await fetchAudioStream(row.audioUrl, upstreamRange, { source: row.source });
      } catch (err) {
        log.warn(`取流异常 ${trackId}: ${(err as Error)?.message ?? err}`);
        urlExpired = true;
      }

      // 401/403/404 都说明地址已失效 —— 重解析一次再试
      if (upstream && [401, 403, 404].includes(upstream.status)) {
        log.info(`音源地址已失效（${upstream.status}），重解析 ${trackId}`);
        try {
          await upstream.body?.cancel();
        } catch {
          // 忽略
        }
        upstream = null;
        urlExpired = true;
      }
    }

    // 缓存 miss 或地址失效：重新解析
    if (!upstream) {
      if (req.raw.destroyed || req.raw.closed) {
        log.debug(`客户端已提前断开，跳过解析 ${trackId}`);
        return;
      }

      let track = getTrack(trackId);
      if (!track && parsed.value) {
        try {
          const detail = await getSongDetail(parsed.value);
          if (detail) {
            upsertTracks([detail]);
            track = detail;
          }
        } catch {
          // 忽略回源详情异常，由下方统一处理
        }
      }

      if (!track) {
        throw notFound('曲目未缓存，请先访问 /api/tracks/:id 或 /api/resolve/:trackId');
      }

      // 地址失效时必须 force：否则解析器会直接把那条失效缓存又返回来，
      // 表现为"重试了但拿到的还是同一个 403 地址"
      const outcome = await resolveTrack(
        {
          id: track.id,
          name: track.name,
          artists: (track.ar || []).map(a => a.name).filter(Boolean),
          durationMs: track.dt || 0,
          // 无 Q 音专辑封面时网易云路径会去取网易云侧专辑封面（显示层兜底）
          hasAlbumCover: Boolean(track.al?.picUrl),
        },
        { force: urlExpired }
      );

      if (!outcome.ok || !outcome.sourceUrl) {
        // 解析不出来要给出明确原因，而不是抛一个"502 上游异常"让人猜
        reply.code(503);
        return {
          error: {
            code: 'source_unavailable',
            message: outcome.message ?? '暂时找不到这首曲目的可播放音源',
            reason: outcome.reason ?? 'error',
            trackId,
          },
        };
      }

      if (req.raw.destroyed || req.raw.closed) {
        log.debug(`客户端连接在取流前已断开，放弃拉流 ${trackId}`);
        return;
      }

      upstream = await fetchAudioStream(outcome.sourceUrl, upstreamRange, { source: outcome.source });
    }

    if (!upstream.ok && upstream.status !== 206) {
      log.warn(`取流失败 ${trackId}: 上游 HTTP ${upstream.status}`);
      try {
        await upstream.body?.cancel();
      } catch {
        // 忽略
      }
      reply.code(502);
      return {
        error: {
          code: 'upstream_stream_failed',
          message: `上游拒绝提供音频（HTTP ${upstream.status}），请稍后重试`,
        },
      };
    }

    log.debug(
      `流转发 ${trackId} ${req.method} ${range ?? '全量'} → ${upstream.status} ` +
        `auth=${authMethod}`
    );

    // 返回 payload 而不是自己 send，理由见文件头第 4 条
    /**
     * ★ 时长取「**实际在播的那个音源**」，元数据只兜底。
     *
     * 手动锚定允许指向时长完全不同的视频（用户拍板"就这个"），此时 Q 音元数据是错的 ——
     * 真机报障原话：「选了 2 分多的音源，界面还显示 3 分多，播完自动切歌」。
     * 锚点表里存着该视频的真实时长（锚定时由候选带上来），优先用它；
     * 自动匹配的曲目时长差在阈值内，元数据足够准，沿用元数据即可。
     *
     * 这个值有两个用途：上行节流的码率推算，以及回给客户端的进度条时长
     * （`X-Audio-Duration-Ms`）。
     */
    const metadataMs = getTrack(trackId)?.dt ?? 0;
    const anchorSec = getAnchor(trackId)?.durationSec ?? 0;
    const sourceMs = anchorSec > 0 ? Math.round(anchorSec * 1000) : metadataMs;
    return forward(reply, upstream, headOnly, streamRate(upstream, sourceMs, Boolean(range)), sourceMs);
  };

  // fastify 的 exposeHeadRoutes 会给 GET 自动挂 HEAD
  app.get('/api/stream/:trackId', handler);

  /**
   * 按 bvid 直连取流（锚定弹窗的试听用）。
   *
   * 没有 play_sources 缓存层：每次都直接「view + playurl + 取流」。
   * 令牌签给 `bvid:<bvid>`（由 /api/tracks/:id/bili-candidates 的 previewUrl 带出）。
   * 注册顺序无需关心：Fastify 里静态段 `bvid` 优先于 `:trackId` 参数。
   */
  app.get('/api/stream/bvid/:bvid', async (req: any, reply: any): Promise<unknown> => {
    const bvid = String(req.params.bvid ?? '');
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
      throw badRequest(`bvid 不合法：${bvid}`, 'invalid_id');
    }
    authorize(req, `bvid:${bvid}`);

    const headOnly = req.method === 'HEAD';
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const upstreamRange = range ?? (headOnly ? 'bytes=0-0' : undefined);

    const result = await resolveTrackSource({
      name: '',
      artists: [],
      durationMs: 0,
      bvid,
    });
    if (!result.ok || !result.sourceUrl) {
      reply.code(503);
      return {
        error: {
          code: 'source_unavailable',
          message: result.message ?? '该视频取不到音频流',
          reason: result.reason ?? 'error',
        },
      };
    }

    const upstream = await fetchAudioStream(result.sourceUrl, upstreamRange, {
      source: 'bilibili',
    });

    if (!upstream.ok && upstream.status !== 206) {
      try {
        await upstream.body?.cancel();
      } catch {
        /* 忽略 */
      }
      reply.code(502);
      return {
        error: {
          code: 'upstream_stream_failed',
          message: `上游拒绝提供音频（HTTP ${upstream.status}），请稍后重试`,
        },
      };
    }

    // 匹配到的视频真实时长：既用于上行节流的码率推算，也回传给客户端做进度条
    const sourceDurationMs = Math.max(0, Math.round((result.matchedDurationSec ?? 0) * 1000));

    return forward(
      reply,
      upstream,
      headOnly,
      streamRate(upstream, sourceDurationMs, Boolean(range)),
      sourceDurationMs
    );
  });

  /**
   * 会话级流令牌：给原生播放器（安卓）整条队列一次签发。
   * 必须已登录（Bearer），令牌绑定 `*`，24h 有效（见 utils/stream-token.ts）。
   */
  app.get('/api/stream/session-token', async req => {
    requireUser(req);
    return { token: signSessionStreamToken(), expiresInMs: SESSION_STREAM_TOKEN_TTL_MS };
  });

  /**
   * 强制失效某首曲目的音源缓存。
   * 客户端在播放持续失败时调用，等价于 `/api/resolve/:trackId?force=1`，
   * 但语义更明确，也不需要重新拿 streamUrl。
   */
  app.post('/api/stream/:trackId/invalidate', async req => {
    const raw = (req.params as any).trackId as string;
    const parsed = parseId(raw);
    if (!parsed || parsed.kind !== 'track') {
      throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    }

    // 以前这里只手认 Bearer，而 Web 面板走的是同源 cookie 会话 ——
    // 网页端调用必 401（重审 F）。改用统一的 requireUser：Bearer 与 cookie 都认，
    // cookie 写请求的 CSRF 头校验也在里面。
    requireUser(req);
    invalidateTrack(parsed.raw);
    return { ok: true, trackId: parsed.raw };
  });
}
