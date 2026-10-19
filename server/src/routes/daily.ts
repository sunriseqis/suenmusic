/**
 * 每日推荐 + 推荐黑名单（不喜欢）。
 *
 * GET    /api/recommend/daily          生成/返回当日歌单
 * POST   /api/recommend/dislike        加入黑名单（type: track | artist）
 * DELETE /api/recommend/dislike/:type/:id   撤销（设置页黑名单管理）
 * GET    /api/recommend/dislikes       黑名单列表（设置页）
 *
 * 「不喜欢」语义（2026-09-11 用户拍板）：立即移出当日歌单并切歌 + 永久过滤。
 * 不喜欢歌手时连带把该歌手从用户曲库归属里删链 —— 之后建库器不再为该用户
 * 拉它的热门歌（全局实体保留，别的用户不受影响）。
 */

import type { FastifyInstance } from 'fastify';
import { requireUser } from '../http/require-auth.ts';
import { badRequest } from '../http/errors.ts';
import { getDailyRecommend } from '../services/daily-recommend.ts';
import { triggerFavoritesSummaryUpdate } from '../services/ai-memory.ts';
import {
  addDislike,
  listDislikes,
  removeDislike,
  unlinkUserArtist,
  type DislikeType,
} from '../db/repo/library.ts';

function parseType(raw: unknown): DislikeType {
  const t = String(raw ?? '');
  if (t !== 'track' && t !== 'artist') {
    throw badRequest(`类型不合法：${t}（应为 track 或 artist）`, 'invalid_param');
  }
  return t;
}

export function registerDailyRoutes(app: FastifyInstance): void {
  app.get('/api/recommend/daily', async req => {
    const user = requireUser(req);
    // 只读：歌单由每天 00:30 的定时维护产出。
    // 原 `?force=1`（「换一批」/「重试」按钮）会清缓存重建 —— 按用户要求已关闭。
    return getDailyRecommend(user.id);
  });

  app.post('/api/recommend/dislike', async req => {
    const user = requireUser(req);
    const body = (req.body ?? {}) as { type?: unknown; id?: unknown; name?: unknown };
    const type = parseType(body.type);
    const id = String(body.id ?? '').trim();
    if (!id) throw badRequest('缺少目标 id', 'invalid_param');

    addDislike(user.id, type, id, String(body.name ?? '').slice(0, 200));
    // 歌手不喜欢 = 从该用户的曲库归属里删链，建库器不再为他拉这位歌手
    if (type === 'artist') unlinkUserArtist(user.id, id);
    // 点不喜欢也算「还在操作」：重置画像刷新的 1 小时空闲倒计时（见 ai-memory.ts）
    triggerFavoritesSummaryUpdate(user.id);

    return { ok: true, type, id };
  });

  app.delete('/api/recommend/dislike/:type/:id', async req => {
    const user = requireUser(req);
    const type = parseType((req.params as any).type);
    const id = String((req.params as any).id ?? '').trim();
    if (!id) throw badRequest('缺少目标 id', 'invalid_param');

    removeDislike(user.id, type, id);
    return { ok: true };
  });

  app.get('/api/recommend/dislikes', async req => {
    const user = requireUser(req);
    return { dislikes: listDislikes(user.id) };
  });
}
