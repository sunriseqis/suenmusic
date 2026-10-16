/**
 * 每日推荐。
 *
 * 首访是懒生成（服务端现算，要打十几次上游），可能要等几秒；
 * 之后全天命中缓存即时返回。调用方只需给足超时时间。
 */

import { http } from './client.ts';
import type { Track } from './types.ts';

export interface DailyRecommend {
  status: 'ready' | 'generating' | 'shortfall' | 'error';
  date: string;
  tracks: Track[];
  welcomePhrase?: string;
  greeting?: string;
  message?: string;
  /** true = 这次是现算的（当天首访） */
  generated?: boolean;
}

/**
 * 取当天每日专属推荐。
 */
export function fetchDailyRecommend(
  opts: { force?: boolean; signal?: AbortSignal } = {}
): Promise<DailyRecommend> {
  return http.get<DailyRecommend>(opts.force ? '/api/recommend/daily?force=1' : '/api/recommend/daily', {
    signal: opts.signal,
    timeoutMs: 15_000,
  });
}

// ---------------------------------------------------------------------------
// 推荐黑名单（不喜欢）
// ---------------------------------------------------------------------------

export type DislikeType = 'track' | 'artist';

export interface DislikeItem {
  type: DislikeType;
  targetId: string;
  name: string;
  createdAt: number;
}

/** 加入黑名单。type=artist 时服务端会连带解除该歌手的曲库归属 */
export function addDislike(type: DislikeType, id: string, name = ''): Promise<{ ok: boolean }> {
  return http.post('/api/recommend/dislike', { type, id, name });
}

/** 撤销不喜欢（设置页黑名单管理） */
export function removeDislike(type: DislikeType, id: string): Promise<{ ok: boolean }> {
  return http.delete(
    `/api/recommend/dislike/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
  );
}

/** 黑名单列表（设置页） */
export function fetchDislikes(): Promise<{ dislikes: DislikeItem[] }> {
  return http.get('/api/recommend/dislikes');
}
