/**
 * 无服务端时的音源解析：QQ 元数据 → B 站搜索 → playurl → 直链。
 *
 * 这是诊断页验证过的那条链路的产品化版本。与服务端 `sources/bilibili/matcher.ts`
 * 的差别：那里有完整的打分（时长差、UP 主、播放量等），这里只做**够用的**筛选 ——
 * 歌名覆盖率 + 歌手命中 + 明显错版本降权。
 *
 * ⚠️ 为什么先用简单打分而不是把 matcher 搬过来：
 * 先把"能播"跑通，把评分做复杂是第二步。评分错了的表现是"放的是翻唱"，
 * 而解析不出来的表现是"播不了" —— 后者严重得多。
 */

import type { ResolveResult, Track } from '@/api/types.ts';
import { artistNames } from '@/utils/format.ts';
import { biliResolveAudio, biliSearch, type BiliCandidate } from './upstream.ts';

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

/** 明显的非原版标签 —— 命中就大幅降权（放错版本比放不出来更让人恼火） */
const BAD_VERSION = /(翻唱|cover|伴奏|remix|dj|鬼畜|纯音乐|钢琴|吉他|教学|教程|reaction|直播|切片)/i;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\-_·,，.。!！?？'"“”()（）[\]【】]/g, '');
}

/** 给一个候选打 0~100 分。只要"歌名对得上、歌手能命中"就够排序用 */
function scoreCandidate(c: BiliCandidate, name: string, artist: string): number {
  const title = normalize(c.title);
  const n = normalize(name);
  if (!n) return 0;

  let score = 0;
  if (title.includes(n)) {
    score += 60;
  } else {
    // 没整体命中时按字符覆盖率给分（标题常带前后缀）
    let hit = 0;
    for (const ch of n) if (title.includes(ch)) hit += 1;
    score += Math.round((hit / n.length) * 40);
  }

  for (const a of artist.split('/').map(x => normalize(x.trim())).filter(Boolean)) {
    if (title.includes(a)) {
      score += 30;
      break;
    }
  }

  if (BAD_VERSION.test(c.title)) score -= 25;
  return score;
}

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

  const artist = artistNames(track.ar);
  const keyword = artist && artist !== '未知歌手' ? `${name} ${artist}` : name;

  let candidates: BiliCandidate[] = [];
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

  const ranked = candidates
    .map(c => ({ c, score: scoreCandidate(c, name, artist) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 20) {
    return fail(track.id, 'no_match', '搜到的结果与原曲差异太大');
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
        score: best.score,
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
          author: '',
          score: x.score,
        })),
        coverUrl: null,
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
