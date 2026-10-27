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
  url?: string | null;
  freeTrialInfo?: unknown;
  level?: string;
  type?: string;
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
  options?: { preferMp3?: boolean },
): Promise<string | null> {
  const levels = options?.preferMp3
    ? ['exhigh', 'standard']
    : (vip ? ['lossless', 'exhigh', 'standard'] : ['standard', 'exhigh']);
  const cookie = currentNeteaseCookie();

  for (const level of levels) {
    try {
      const res = await neteaseCall(
        cookie => netease.songUrlV1({ id: songId, level, cookie }, neteaseRequest)
      );
      const entries = (res?.body?.data as unknown as SongUrlEntry[] | undefined) ?? [];
      const entry = entries[0];
      if (!entry) continue;
      // freeTrialInfo 非空 = 该档位只有试听，往下一档试
      if (entry.freeTrialInfo) continue;
      if (!entry.url) continue;
      return String(entry.url);
    } catch (err) {
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
  options?: { preferMp3?: boolean },
): Promise<ResolveResult> {
  const vip = (getNeteaseStatus().account?.vipType ?? 0) >= 10;
  const rawId = String(track.id ?? '').trim();

  // ---- 直取快径：`ne_<songId>` 自带网易云 songId，直接调 songUrlV1（0 次搜索） ----
  if (rawId.startsWith('ne_')) {
    const directId = Number(rawId.slice(3));
    if (Number.isFinite(directId) && directId > 0) {
      const directUrl = await fetchPlayableUrl(directId, vip, options);
      if (directUrl) {
        log.info(`网易云直取命中 ${directId} 「${track.name ?? ''}」 vip=${vip ? '是' : '否'}`);
        return {
          ok: true,
          reason: undefined,
          bvid: null,
          sourceUrl: directUrl,
          score: 100,
          matchedTitle: String(track.name ?? ''),
          matchedAuthor: (track.artists ?? []).join('/'),
          durationDiff: 0,
          bandwidth: undefined,
          source: 'netease',
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
  const url = await fetchPlayableUrl(best.id, vip, options);
  if (!url) {
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
    sourceUrl: url,
    score: 100,
    matchedTitle: best.name,
    matchedAuthor: (best.artists ?? []).map(a => a?.name ?? '').join('/'),
    durationDiff: Number.isFinite(bestDurationDiff) ? Math.round(bestDurationDiff * 100) / 100 : undefined,
    bandwidth: undefined,
    source: 'netease',
    coverUrl,
  };

  log.info(
    `网易云命中 ${best.id} 「${best.name}」 ${result.matchedAuthor}` +
      ` 时长差=${result.durationDiff ?? 0}s vip=${vip ? '是' : '否'}`
  );
  return result;
}

export { BROWSER_UA };
