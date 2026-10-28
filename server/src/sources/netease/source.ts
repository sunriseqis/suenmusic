/**
 * 网易云音源解析。
 *
 * 在播放链里排在 B 站**之前**（用户拍板）：网易云曲库匹配更准、
 * 有账号时能拿到 lossless/hires；匹配不上就走 B 站兜底。
 *
 * ## 严格匹配（用户拍板：宁走 B 站，不放错歌）
 *
 * 网易云搜索的**排序不可信**——匿名搜「周杰伦 晴天」前 3 名全是翻唱
 * （实测）。所以不能拿搜索第一条，必须自己过三道闸：
 *
 *   1. 歌名规范化后**全等**（去括号后缀 / 繁简 / 全半角 / 大小写）
 *   2. 结果的歌手列表必须命中目标歌手之一
 *   3. 时长差 ≤ 5 秒
 *
 * 任一不满足就继续找下一个；全部不满足 → 返回失败，交给 B 站。
 *
 * ## 音质档位
 *
 * 有黑胶 VIP（vipType ≥ 10）时请求 lossless，拿到试听（freeTrialInfo）
 * 就逐级降到 exhigh / standard——**任何一级出现试听都视为该级失败**，
 * 试听只有 30 秒，播出来比不播更糟。全部失败 → 交 B 站。
 */

import { createLogger } from '../../logger.ts';
import type { ResolveInput, ResolveResult } from '../bilibili/stream.ts';
import { netease, neteaseRequest } from './vendor.ts';
import type { NeteaseEnvelope } from './vendor.ts';
import {
  currentNeteaseCookie,
  getNeteaseStatus,
} from '../../services/netease-account.ts';

const log = createLogger('netease:source');

/** 时长差容忍（秒）。母带/重制版与原曲常有 1-3 秒出入，5 秒以内都算同一首 */
const DURATION_TOLERANCE_SEC = 5;

/**
 * 统一的 vendor 调用入口。凭证失效（上游 301）时直接按原响应放行 ——
 * 降级路径（B 站兜底 / 匿名搜索）不受影响；重新登录只能扫码，去设置页操作。
 */
async function neteaseCall(
  fn: (cookie: string) => Promise<NeteaseEnvelope>
): Promise<NeteaseEnvelope> {
  return fn(currentNeteaseCookie());
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 歌名/歌手名规范化：去括号后缀、全角转半角、去空白、统一小写 */
function normalizeName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    // 去掉所有括号段（中英文）——「晴天 (Live)」「晴天（伴奏）」按「晴天」比
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[（(]/g, '')
    .replace(/[）)]/g, '')
    // 全角英数/符号 → 半角
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .trim();
}

interface NeteaseSong {
  id: number;
  name: string;
  duration?: number;
  artists?: Array<{ id?: number; name?: string }>;
}

interface SongUrlEntry {
  /** data[0].code：404 = 无版权/无该音质（实测伴随 url:null 出现） */
  code?: number;
  url?: string | null;
  freeTrialInfo?: unknown;
  level?: string;
  type?: string;
  br?: number;
  size?: number;
}

/** 成功获取的音频直链与音质规格 */
interface PlayableUrlResult {
  url: string;
  level: string;
  bitrate?: number;
  /**
   * **本次这首曲子真实可取**的档位（S-23）。
   *
   * 以前这里是账号级能力（VIP 就报 4 档），与单曲实际版权无关：
   * 一首没有 FLAC 版权的歌也会把「原声」点亮，用户点下去被静默降级到 exhigh。
   * 现在由本次实际拿到的档位推导 —— 声明即真能取，取不到的档不声明（宁可少报）。
   */
  availableQualities: string[];
}

/** 网易 level → 本项目通用音质档位名（认不出返回 null） */
function levelToQuality(level: string | undefined): string | null {
  const l = String(level ?? '').trim().toLowerCase();
  if (l === 'lossless' || l === 'hires' || l === 'jymaster') return 'lossless';
  if (l === 'exhigh') return 'exhigh';
  // 网易的 higher 就是 192k 的「高」，不是 320k 的 exhigh
  if (l === 'higher') return 'high';
  if (l === 'standard') return 'standard';
  return null;
}

/** 声明档位的顺序（低 → 高），客户端按它决定置灰/可点 */
const QUALITY_ORDER = ['standard', 'high', 'exhigh', 'lossless'];

/**
 * 根据用户期望音质与 VIP 能力决定尝试档位列表，非 VIP 绝不请求 lossless。
 *
 * preferMp3（要 mp3 容器，iOS）：网易的无损是 FLAC，AVPlayer 流播不了，
 * 所以必须从候选里**真剔除** lossless/hires/jymaster，而不只是不声明。
 */
function computeNeteaseLevels(vip: boolean, quality?: string, preferMp3 = false): string[] {
  const q = String(quality ?? '').trim().toLowerCase();
  let levels: string[];
  if (q === 'standard') {
    levels = ['standard'];
  } else if (q === 'high') {
    // 网易 192k 的 level 名是 higher；以前第一档给 standard，「高」永远只拿到 128k
    levels = ['higher', 'standard'];
  } else if (q === 'exhigh') {
    levels = ['exhigh', 'higher', 'standard'];
  } else if (q === 'lossless') {
    levels = vip ? ['lossless', 'exhigh', 'higher', 'standard'] : ['exhigh', 'higher', 'standard'];
  } else {
    levels = vip ? ['lossless', 'exhigh', 'higher', 'standard'] : ['exhigh', 'higher', 'standard'];
  }
  if (!preferMp3) return levels;
  return levels.filter(l => l !== 'lossless' && l !== 'hires' && l !== 'jymaster');
}

/**
 * 由**实际拿到的档位**推导本次可声明的档位（S-23）。
 *
 * 依据：网易同一首歌「高码率可取 ⇒ 低码率必可取」（freeTrialInfo 只会出现在
 * 高于账号/曲目权限的那几档），所以拿到 L 档时 L 及以下各档都是真的能播的；
 * 高于 L 的一律不声明 —— 那正是以前谎报的来源。
 *
 * 注意 QUALITY_ORDER 是「低 → 高」，因此取前缀 = 取 ≤ L 的全部档位。
 * preferMp3（iOS 流播不了 FLAC）已经在上游的候选序列里剔掉 lossless，
 * 所以这里不会因为前缀而把 lossless 又说回来。
 */
function availableUpTo(quality: string): string[] {
  const idx = QUALITY_ORDER.indexOf(quality);
  if (idx < 0) return ['standard'];
  return QUALITY_ORDER.slice(0, idx + 1);
}

/** 映射网易 level 到本项目通用音质档位：认不出就退回本次请求的档，再不行 standard（绝不往上猜） */
function mapNeteaseQuality(rawLevel?: string, reqLevel?: string): string {
  return levelToQuality(rawLevel) ?? levelToQuality(reqLevel) ?? 'standard';
}

/** 失败结果。reason 归入 B 站同款枚举，客户端无需感知来源差异 */
function fail(reason: ResolveResult['reason'], message: string): ResolveResult {
  return {
    ok: false,
    reason,
    bvid: null,
    sourceUrl: null,
    score: 0,
    message: `[网易云] ${message}`,
    source: 'netease',
  };
}

/** 向网易云要某首歌的可播地址。拿到试听（freeTrialInfo）视为失败 */
async function fetchPlayableUrl(
  songId: number,
  vip: boolean,
  options?: { preferMp3?: boolean; quality?: string },
): Promise<PlayableUrlResult | null> {
  const levels = computeNeteaseLevels(vip, options?.quality, Boolean(options?.preferMp3));

  for (const level of levels) {
    try {
      const res = await neteaseCall(
        cookie => netease.songUrlV1({ id: songId, level, cookie }, neteaseRequest)
      );
      const entries = (res?.body?.data as unknown as SongUrlEntry[] | undefined) ?? [];
      const entry = entries[0];
      // data[0].code 404 = 「无版权/无该音质」，当档没有完整 URL，直接试下一档
      if (!entry || entry.code === 404) continue;
      // freeTrialInfo 非空 = 该档位只有试听，往下一档试
      if (entry.freeTrialInfo) continue;
      if (!entry.url) continue;
      /**
       * preferMp3（iOS）：万一上游仍回执无损（请求档与回执档不符的异常情形），
       * 那个 URL 就是 FLAC —— AVPlayer 流播不了，按"这一档失败"处理继续往下试，
       * 否则会把一个播不动的档当成结果返回，还会被声明成可取。
       */
      if (options?.preferMp3 && levelToQuality(entry.level) === 'lossless') continue;
      // 以**上游回执里的真实档位**为准（可能是比请求更低的档），声明只到它为止
      const got = mapNeteaseQuality(entry.level, level);
      return {
        url: String(entry.url),
        level: got,
        bitrate: typeof entry.br === 'number' ? entry.br : undefined,
        /** 本次这首真的能取到的档位（S-23，见 availableUpTo 注释） */
        availableQualities: availableUpTo(got),
      };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      // 301 = cookie 失效，继续逐级打也是同样的拒绝
      if (status === 301) {
        log.warn(`网易云凭证失效（301），跳过剩余音质档 songId=${songId}`);
        break;
      }
      log.warn(`取流失败 songId=${songId} level=${level}: ${(err as Error)?.message ?? err}`);
    }
  }
  return null;
}

/**
 * 尝试用网易云解析一首 QQ 曲目。
 *
 * 匹配不上/取不到完整地址时返回 ok:false（reason 说明原因），
 * 调用方（resolver）据此继续走 B 站。任何异常都被吞成失败——
 * 网易云不可用不能影响 B 站兜底链路。
 */
export async function resolveNeteaseSource(
  track: ResolveInput,
  options?: { preferMp3?: boolean; quality?: string },
): Promise<ResolveResult> {
  const vip = (getNeteaseStatus().account?.vipType ?? 0) >= 10;
  const rawId = String(track.id ?? '').trim();

  // ---- 直取快径：`ne_<songId>` 自带网易云 songId，直接调 songUrlV1（0 次搜索） ----
  if (rawId.startsWith('ne_')) {
    const directId = Number(rawId.slice(3));
    if (Number.isFinite(directId) && directId > 0) {
      const direct = await fetchPlayableUrl(directId, vip, options);
      if (direct) {
        log.info(`网易云直取命中 ${directId} 「${track.name ?? ''}」 quality=${direct.level} vip=${vip ? '是' : '否'}`);
        return {
          ok: true,
          reason: undefined,
          bvid: null,
          sourceUrl: direct.url,
          score: 100,
          matchedTitle: String(track.name ?? ''),
          matchedAuthor: (track.artists ?? []).join('/'),
          durationDiff: 0,
          bandwidth: direct.bitrate,
          source: 'netease',
          currentQuality: direct.level,
          // 曲目级声明：只有本次这首歌真能取的档位（S-23）
          availableQualities: direct.availableQualities,
        };
      }
      log.debug(`网易云直取无完整流 songId=${directId}，回退按歌名搜索`);
    }
  }

  const name = String(track.name ?? '').trim();
  if (!name) return fail('no_candidates', '曲目无名，无法搜索');

  const cookie = currentNeteaseCookie();
  // 搜索词带第一个歌手名能显著提高正版命中率（不带时前几名常是翻唱）
  const artist = (track.artists ?? [])[0] ?? '';
  const keywords = artist ? `${name} ${artist}` : name;

  let songs: NeteaseSong[];
  try {
    const res = await neteaseCall(
      cookie => netease.search({ keywords, type: 1, limit: 30, cookie }, neteaseRequest)
    );
    const body = res?.body as { code?: number; result?: { songs?: NeteaseSong[] } };
    // 301 = 凭证失效。继续发搜索只会得到同样的拒绝（2026-10-27 报障：反复打上游拖慢启播），
    // 立即失败交 B 站兜底，等设置页重新扫码。
    if (body?.code === 301) {
      return fail('rejected', '网易云登录已失效（301），请在设置页重新扫码');
    }
    if (body?.code !== 200) {
      return fail('rejected', `搜索被拒（code=${body?.code ?? '?'}）`);
    }
    songs = body.result?.songs ?? [];
  } catch (err) {
    return fail('rejected', `搜索异常：${(err as Error)?.message ?? err}`);
  }

  if (!songs.length) return fail('no_candidates', `搜索无结果（${keywords}）`);

  // ---- 三道闸 ----
  const targetNorm = normalizeName(name);
  const targetArtists = (track.artists ?? []).map(normalizeName).filter(Boolean);
  const targetMs = Number(track.durationMs ?? 0);

  let best: NeteaseSong | null = null;
  let bestDurationDiff = Number.POSITIVE_INFINITY;

  for (const song of songs) {
    // 闸 1：歌名全等
    if (normalizeName(song.name) !== targetNorm) continue;

    // 闸 2：歌手命中（结果的任一歌手规范化后与目标任一歌手相同）
    const songArtists = (song.artists ?? []).map(a => normalizeName(String(a?.name ?? '')));
    const artistHit =
      targetArtists.length === 0 ||
      songArtists.some(sa => sa && targetArtists.includes(sa));
    if (!artistHit) continue;

    // 闸 3：时长 ±5s
    const diff = targetMs > 0 && song.duration ? Math.abs(song.duration - targetMs) / 1000 : 0;
    if (targetMs > 0 && song.duration && diff > DURATION_TOLERANCE_SEC) continue;

    if (diff < bestDurationDiff) {
      best = song;
      bestDurationDiff = diff;
    }
  }

  if (!best) {
    return fail('no_candidates', `30 个候选无一通过严格匹配（${keywords}）`);
  }

  // ---- 取流（试听逐级降档）----
  const playable = await fetchPlayableUrl(best.id, vip, options);
  if (!playable) {
    return fail('no_stream', `匹配到「${best.name}」但拿不到完整音频（VIP 不足或歌曲无版权）`);
  }

  /**
   * 封面兜底：曲目没有 Q 音专辑封面时，取网易云侧的专辑封面。
   * 搜索结果只带 album.id（匿名态无 picUrl），需要一次 album 详情请求；
   * 只在"确实缺封面"时才发（hasAlbumCover 由调用方按曲目元数据传入），
   * 结果随 play_sources 持久化，之后走缓存不再请求。
   */
  let coverUrl: string | undefined;
  if (!track.hasAlbumCover && (best as { album?: { id?: number } }).album?.id) {
    try {
      const albumId = (best as { album?: { id?: number } }).album!.id!;
      const ar = await neteaseCall(cookie => netease.album({ id: albumId, cookie }, neteaseRequest));
      const ab = (ar?.body as { album?: { picUrl?: string } })?.album;
      if (ab?.picUrl) coverUrl = String(ab.picUrl).replace(/^http:/, 'https:');
    } catch (err) {
      log.warn(`网易云专辑封面获取失败 album=${(best as { album?: { id?: number } }).album?.id}: ${(err as Error)?.message ?? err}`);
    }
  }

  const result: ResolveResult = {
    ok: true,
    reason: undefined,
    bvid: null,
    sourceUrl: playable.url,
    score: 100,
    matchedTitle: best.name,
    matchedAuthor: (best.artists ?? []).map(a => a?.name ?? '').join('/'),
    durationDiff: Number.isFinite(bestDurationDiff) ? Math.round(bestDurationDiff * 100) / 100 : undefined,
    bandwidth: playable.bitrate,
    source: 'netease',
    coverUrl,
    currentQuality: playable.level,
    availableQualities: playable.availableQualities,
  };

  log.info(
    `网易云命中 ${best.id} 「${best.name}」 ${result.matchedAuthor}` +
      ` quality=${result.currentQuality} 时长差=${result.durationDiff ?? 0}s vip=${vip ? '是' : '否'}`
  );
  return result;
}

export { BROWSER_UA };
