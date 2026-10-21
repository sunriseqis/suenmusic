/**
 * 播放相关接口：音源解析、流失效重解析、播放上报、续播进度。
 *
 * 这里有两条**必须遵守**的规则（PLAN.md 5.2）：
 *
 *   1. `streamUrl` 带签名时效，**绝不能缓存**。每次要播放都重新解析，
 *      或者至少在收到 403 时用 `force=1` 重新解析。
 *   2. 它是**相对路径**，必须用 `resolveUrl()` 拼上基地址再喂给 `<audio>`。
 */

import { http, resolveUrl } from './client.ts';
import type { ResolveResult, TrackProgress } from './types.ts';

/**
 * 解析某个曲目的可播放地址。
 *
 * `force = true` 会清掉服务端全部缓存层重新匹配 —— 客户端遇到播放失败时用。
 * 它比普通解析贵得多（会真的去搜 B 站），不要无脑用。
 *
 * `retry = true` 只无视「服务端缓存的失败结果」，成功缓存照常命中 ——
 * **用户手点重试/重播时必须带上它**：否则一条失败结果会在负缓存周期内
 * 让这首歌怎么重试都播不出来（表现为"这一首死活播不出，换一首切回来又好了"）。
 */
export function resolveTrack(
  trackId: string,
  force = false,
  retry = false
): Promise<ResolveResult> {
  const query: Record<string, number> = {};
  if (force) query.force = 1;
  if (retry) query.retry = 1;
  return http.get<ResolveResult>(`/api/resolve/${encodeURIComponent(trackId)}`, {
    query: Object.keys(query).length > 0 ? query : undefined,
    // 要等 B 站搜索，给足时间
    timeoutMs: 30_000,
  });
}

/**
 * 取可直接喂给 `<audio>` 的绝对地址。
 * 解析成功但拿不到地址时返回 null —— 调用方要处理这种情况，不要直接抛。
 */
export async function resolveStreamUrl(
  trackId: string,
  force = false,
  retry = false
): Promise<{ result: ResolveResult; url: string | null }> {
  const result = await resolveTrack(trackId, force, retry);
  return {
    result,
    url: result.ok && result.streamUrl ? resolveUrl(result.streamUrl) : null,
  };
}

// ---------------------------------------------------------------------------
// 手动锚定（低置信曲目的人工兜底）
// ---------------------------------------------------------------------------

/** B 站候选视频（锚定弹窗用）。score 是按本曲元数据算出的置信分 */
export interface BiliCandidate {
  bvid: string;
  title: string;
  author: string;
  durationSec: number;
  score: number;
  durationDiff: number;
  /** 封面缩略图（B 站 CDN，https）。可能为空串 */
  pic: string;
  /** 试听流地址（相对路径，带短期令牌，需 resolveUrl 拼基地址） */
  previewUrl: string;
}

/** 曲目自身的 Q 音元数据（锚定弹窗的「原版参照」） */
export interface AnchorTrackMeta {
  id: string;
  name: string;
  artists: string[];
  durationMs: number;
  albumName: string;
  albumPic: string;
}

/** 搜 B 站候选。keyword 缺省时服务端用「歌名 + 主歌手」自动构造 */
export function fetchBiliCandidates(
  trackId: string,
  keyword = ''
): Promise<{
  keyword: string;
  rejected: boolean;
  message?: string;
  track: AnchorTrackMeta;
  candidates: BiliCandidate[];
}> {
  return http.get(`/api/tracks/${encodeURIComponent(trackId)}/bili-candidates`, {
    query: keyword ? { keyword } : undefined,
    timeoutMs: 20_000,
  });
}

/** 锚定：把「这首曲 = 这个 B 站视频」永久入库，之后播放直接按锚点取流 */
export function anchorTrack(
  trackId: string,
  data: { bvid: string; title?: string; author?: string; durationSec?: number }
): Promise<{ ok: boolean }> {
  return http.post(`/api/tracks/${encodeURIComponent(trackId)}/anchor`, data);
}

// ---------------------------------------------------------------------------
// 播放历史与续播
// ---------------------------------------------------------------------------

/**
 * 上报一次播放。
 *
 * ⚠️ 注意端点是 `/api/history`，**不是** `/api/history/progress` ——
 * 后者是**批量读**进度。PLAN.md 5.2 原文此处写错了，以此注释为准。
 *
 * `playedAt` 可以传旧时间：离线期间攒下的记录联网后补报，
 * 服务端按记录 id 做增量游标，不会因为时间旧而漏掉。
 */
export function reportPlay(input: {
  trackId: string;
  playedMs?: number;
  durationMs?: number;
  completed?: boolean;
  playedAt?: number;
  tracks?: unknown[];
}): Promise<{ ok: boolean; recorded: number; skipped: number; ids: number[] }> {
  return http.post('/api/history', input);
}

/**
 * 取某首歌的续播位置。从未播过时服务端返回 **404** ——
 * 这不是错误，调用方应当捕获后按 0 处理。
 */
export function fetchProgress(trackId: string): Promise<TrackProgress> {
  return http.get<TrackProgress>(`/api/history/progress/${encodeURIComponent(trackId)}`);
}

// ---------------------------------------------------------------------------
// 锚定查询与解除
// ---------------------------------------------------------------------------

export interface TrackAnchorInfo {
  bvid: string;
  title: string;
  author: string;
  durationSec: number;
  pinned: boolean;
}

/** 查询曲目当前锚点（锚定弹窗回显用）。未锚定时 anchor 为 null */
export function fetchTrackAnchor(trackId: string): Promise<{
  anchor: TrackAnchorInfo | null;
}> {
  return http.get("/api/tracks/" + encodeURIComponent(trackId) + "/anchor");
}

/** 解除锚定，该曲目回到自动匹配 */
export function unanchorTrack(trackId: string): Promise<{ ok: boolean }> {
  return http.delete("/api/tracks/" + encodeURIComponent(trackId) + "/anchor");
}
