/**
 * 无服务端时的音源解析：QQ 元数据 → B 站搜索 → playurl → 直链。
 *
 * 打分用**逐字搬过来**的服务端 matcher（时长差 40 分 + 负面词熔断 +
 * 歌名/歌手 40 分 + 官方加权 20 分）。不用自己那套"歌名覆盖率"的简化版：
 * 简化版对"翻唱 / 伴奏 / 鬼畜"几乎没有分辨力，用户第一耳就能听出来放错了。
 */

import type { ResolveResult, Track } from '@/api/types.ts';
import { artistNames } from '@/utils/format.ts';
import { biliResolveAudio, biliSearch } from './upstream.ts';
import { scoreCandidate, type MatchTrack } from './matcher.ts';
import { getLocalAnchor } from './anchor.ts';
import { neteaseAvailable, neteaseSearch, neteaseSongUrl } from './netease.ts';

/** 直链缓存时长。B 站签名通常 2 小时有效，但队列里反复重解析没必要，10 分钟够用 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  url: string;
  bvid: string;
  title: string;
  bandwidth: number;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function fail(trackId: string, reason: 'no_match' | 'error', message: string): {
  result: ResolveResult;
  url: null;
} {
  // 直连解析失败必须留痕：它的失败会表现成"播放不了"，而没有日志时
  // 无法区分"搜不到 / 上游风控 / 取流失败"——只能在真机上靠猜
  console.error(`[direct] 解析失败 ${trackId} ${reason}: ${message}`);
  return {
    result: {
      trackId,
      ok: false,
      reason,
      message,
      score: 0,
      bvid: null,
      matchedTitle: null,
      matchedAuthor: null,
      durationDiff: null,
      fallbackStream: false,
      bandwidth: 0,
      streamUrl: null,
      streamTokenExpiresInSec: 0,
      expiresInSec: 0,
      hitLevel: 'direct',
      source: 'bilibili',
      costMs: 0,
      topCandidates: [],
      coverUrl: null,
      track: null,
    },
    url: null,
  };
}

/**
 * 解析一首曲目的可播放直链。
 *
 * 返回结构与服务端的 `/api/resolve/:id` 保持一致 —— 这样播放器不用为两条路
 * 各写一套分支。`streamUrl` 这里放的是**绝对地址**（不是服务端的相对路径）。
 */
export async function resolveDirect(track: Track): Promise<{
  result: ResolveResult;
  url: string | null;
}> {
  const started = Date.now();
  const name = (track.name || '').trim();
  if (!name) return fail(track.id, 'no_match', '曲目没有歌名，无法搜索音源');

  const cached = cache.get(track.id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return {
      result: {
        trackId: track.id,
        ok: true,
        reason: 'ok',
        message: null,
        score: 100,
        bvid: cached.bvid,
        matchedTitle: cached.title,
        matchedAuthor: null,
        durationDiff: null,
        fallbackStream: false,
        bandwidth: cached.bandwidth,
        streamUrl: cached.url,
        streamTokenExpiresInSec: Math.round(CACHE_TTL_MS / 1000),
        expiresInSec: Math.round(CACHE_TTL_MS / 1000),
        hitLevel: 'memory',
        source: 'bilibili',
        costMs: Date.now() - started,
        topCandidates: [],
        coverUrl: null,
        track: null,
      },
      url: cached.url,
    };
  }

  /**
   * 先看本机锚点：锚定是**最高权威**，命中就直接取流，
   * 不再搜索、不再打分（否则用户手工指定的版本会被算法覆盖）。
   * 锚点失效（视频下架/取流失败）时静默回退到自动匹配。
   */
  const anchored = getLocalAnchor(track.id);
  if (anchored) {
    try {
      const audio = await biliResolveAudio(anchored.bvid);
      console.log(`[direct] 锚点命中 ${track.id} ← ${anchored.bvid}`);
      cache.set(track.id, {
        url: audio.url,
        bvid: anchored.bvid,
        title: anchored.title,
        bandwidth: audio.bandwidth,
        at: Date.now(),
      });
      return {
        result: {
          trackId: track.id,
          ok: true,
          reason: 'ok',
          message: null,
          score: 100,
          bvid: anchored.bvid,
          matchedTitle: anchored.title,
          matchedAuthor: anchored.author,
          durationDiff: null,
          fallbackStream: false,
          bandwidth: audio.bandwidth,
          streamUrl: audio.url,
          streamTokenExpiresInSec: Math.round(CACHE_TTL_MS / 1000),
          expiresInSec: Math.round(CACHE_TTL_MS / 1000),
          hitLevel: 'direct',
          source: 'bilibili',
          costMs: Date.now() - started,
          topCandidates: [],
          coverUrl: null,
          track: null,
        },
        url: audio.url,
      };
    } catch {
      /* 锚点失效：继续走自动匹配 */
    }
  }

  /**
   * 网易云优先。
   *
   * 与旧版策略一致：**拿到试听就当失败**（30 秒的"能播"比"播不了"更糟），
   * 逐级降码率都不行才回退 B 站。所以这里失败是常态，静默继续即可。
   */
  if (neteaseAvailable()) {
    try {
      const artist = artistNames(track.ar);
      const kw = artist && artist !== '未知歌手' ? `${name} ${artist}` : name;
      const songs = await neteaseSearch(kw, 10);
      const mt: MatchTrack = {
        name,
        artists: (track.ar ?? []).map(a => a.name).filter(Boolean),
        durationMs: track.dt || 0,
      };
      const scored = songs
        .map(s => {
          const cand = {
            bvid: String(s.id),
            title: s.name,
            author: s.artists.join('/'),
            durationSec: Math.round(s.durationMs / 1000),
            pic: s.picUrl,
          };
          const sc = scoreCandidate(mt, cand);
          return { s, cand, ...sc };
        })
        .sort((a, b) => b.finalScore - a.finalScore);

      /**
       * 网易云的搜索结果里**翻唱极多**（"晴天(深情版)"这种），
       * 光靠时长+标题能打到 80 分。必须要求歌手命中，否则宁可回退 B 站 ——
       * 放错版本比播不了更糟，用户第一耳就能听出来。
       */
      const wanted = (track.ar ?? []).map(a => a.name.toLowerCase().trim()).filter(Boolean);
      const artistHit = (item: (typeof scored)[number]): boolean => {
        const hay = `${item.s.artists.join('/')} ${item.s.name}`.toLowerCase();
        if (wanted.length > 0) return wanted.some(a => hay.includes(a));
        /**
         * 曲目没有歌手信息时，退化为**标题必须完全相等** ——
         * 网易云里 "晴天(深情版)" 这类翻唱会附加后缀，只要歌名里有"晴天"
         * 就能骗过包含判断。宁可回退 B 站。
         */
        return item.s.name.trim() === name.trim();
      };

      console.log(
        `[direct] 网易云候选 ${songs.length} 条，最高分 ${scored[0]?.finalScore ?? 0}（${scored[0]?.s.name ?? '-'}）wanted=[${wanted.join('/')}]` +
          (scored[0] ? ` cand=[${scored[0].s.artists.join('/')}]` : '')
      );
      for (const item of scored.slice(0, 3)) {
        if (item.finalScore < 50) break;
        if (!artistHit(item)) {
          console.log(`[direct] 网易云跳过（歌手不符）《${item.s.name}》- ${item.s.artists.join('/')}`);
          continue;
        }
        const stream = await neteaseSongUrl(item.s.id);
        console.log(
          `[direct] 网易云取流 ${item.s.id}《${item.s.name}》score=${item.finalScore} → ${stream ? 'ok br=' + stream.br : '无整首'}`
        );
        if (!stream) continue;
        console.log(
          `[direct] 网易云命中 ${track.id} ← ${item.s.id} br=${stream.br} score=${item.finalScore}`
        );
        cache.set(track.id, {
          url: stream.url,
          bvid: String(item.s.id),
          title: item.s.name,
          bandwidth: stream.br,
          at: Date.now(),
        });
        return {
          result: {
            trackId: track.id,
            ok: true,
            reason: 'ok',
            message: null,
            score: item.finalScore,
            bvid: String(item.s.id),
            matchedTitle: item.s.name,
            matchedAuthor: item.s.artists.join('/'),
            durationDiff: item.durationDiff,
            fallbackStream: false,
            bandwidth: stream.br,
            streamUrl: stream.url,
            streamTokenExpiresInSec: Math.round(CACHE_TTL_MS / 1000),
            expiresInSec: Math.round(CACHE_TTL_MS / 1000),
            hitLevel: 'direct',
            source: 'netease' as const,
            costMs: Date.now() - started,
            topCandidates: [],
            coverUrl: item.s.picUrl || null,
            track: null,
          },
          url: stream.url,
        };
      }
    } catch (e) {
      console.warn(
        `[direct] 网易云不可用，回退 B 站：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  const artist = artistNames(track.ar);
  const keyword = artist && artist !== '未知歌手' ? `${name} ${artist}` : name;

  let candidates: Awaited<ReturnType<typeof biliSearch>> = [];
  try {
    candidates = await biliSearch(keyword);
  } catch (e) {
    return fail(
      track.id,
      'error',
      `B站搜索失败（${keyword}）：${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (candidates.length === 0) {
    return fail(track.id, 'no_match', '没有搜到可用的音源');
  }

  const matchTrack: MatchTrack = {
    name,
    artists: (track.ar ?? []).map(a => a.name).filter(Boolean),
    durationMs: track.dt || 0,
  };

  const ranked = candidates
    .map(c => ({ c, ...scoreCandidate(matchTrack, c) }))
    .sort((a, b) => b.finalScore - a.finalScore);

  const best = ranked[0];
  /**
   * 阈值 60 与服务端 `SUENMUSIC_MATCH_THRESHOLD` 的默认值一致。
   * 低于它就拒绝播放 —— 放一首翻唱/伴奏比"暂时播不了"更让人恼火，
   * 而且用户没法从界面上判断"这是原曲还是翻唱"。
   */
  if (!best || best.finalScore < 60) {
    return fail(
      track.id,
      'no_match',
      `最佳候选置信度 ${best ? best.finalScore : 0} 低于 60（${best ? best.c.title : '无候选'}）`
    );
  }

  try {
    const audio = await biliResolveAudio(best.c.bvid);
    console.log(`[direct] 解析成功 ${track.id} ← ${best.c.bvid} bw=${audio.bandwidth}`);
    cache.set(track.id, {
      url: audio.url,
      bvid: best.c.bvid,
      title: best.c.title,
      bandwidth: audio.bandwidth,
      at: Date.now(),
    });

    return {
      result: {
        trackId: track.id,
        ok: true,
        reason: 'ok',
        message: null,
        score: best.finalScore,
        bvid: best.c.bvid,
        matchedTitle: best.c.title,
        matchedAuthor: null,
        durationDiff: null,
        fallbackStream: false,
        bandwidth: audio.bandwidth,
        streamUrl: audio.url,
        streamTokenExpiresInSec: Math.round(CACHE_TTL_MS / 1000),
        expiresInSec: Math.round(CACHE_TTL_MS / 1000),
        hitLevel: 'direct',
        source: 'bilibili',
        costMs: Date.now() - started,
        topCandidates: ranked.slice(0, 5).map(x => ({
          bvid: x.c.bvid,
          title: x.c.title,
          author: x.c.author,
          score: x.finalScore,
          durationMs: x.durationSec * 1000,
        })),
        // 曲目没有专辑封面时用它兜底（播放页/播放条立刻有图）
        coverUrl: best.c.pic || null,
        track: null,
      },
      url: audio.url,
    };
  } catch (e) {
    return fail(track.id, 'error', e instanceof Error ? e.message : '取音频地址失败');
  }
}

/** 清掉直连缓存（锚定/重试时用；目前只有内存一层） */
export function clearDirectCache(trackId?: string): void {
  if (trackId) cache.delete(trackId);
  else cache.clear();
}
