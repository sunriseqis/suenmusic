/**
 * 用户歌单路由。
 *
 * 所有写操作先过 `ownsPlaylist(userId, id)` —— 歌单 id 是 uuid，
 * 猜不到但也不该依赖"猜不到"来兜住越权。
 */

import type { FastifyInstance } from 'fastify';
import { requireUser } from '../http/require-auth.ts';
import { badRequest, notFound } from '../http/errors.ts';
import { intParam } from '../http/params.ts';
import { getTracks, upsertTracks } from '../db/repo/tracks.ts';
import { PlaylistInputError } from '../db/repo/playlists.ts';
import * as repo from '../db/repo/playlists.ts';

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/** 把仓储层的校验异常翻译成 400，避免每个路由都 try/catch */
function wrapPlaylistError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof PlaylistInputError) {
      throw badRequest(err.message, 'invalid_playlist');
    }
    throw err;
  }
}

function readTrackIds(raw: unknown, field = 'trackIds'): string[] {
  if (!Array.isArray(raw)) throw badRequest(`缺少 ${field}`, 'missing_param');
  const ids = raw.filter((x): x is string => typeof x === 'string' && x !== '');
  if (ids.length === 0) throw badRequest(`${field} 不能为空`, 'missing_param');
  if (ids.length > 500) throw badRequest(`${field} 最多 500 个`, 'too_many_ids');
  return ids;
}

export function registerPlaylistRoutes(app: FastifyInstance): void {
  /** 我的歌单列表（含曲目数与封面回落） */
  app.get('/api/playlists', async req => {
    const user = requireUser(req);
    return { playlists: repo.listPlaylists(user.id) };
  });

  app.post('/api/playlists', async (req, reply) => {
    const user = requireUser(req);
    const body = asRecord(req.body);
    const playlist = wrapPlaylistError(() =>
      repo.createPlaylist(user.id, {
        name: body.name,
        description: body.description,
        coverUrl: body.coverUrl,
      })
    );
    reply.code(201);
    return { playlist };
  });

  /**
   * 歌单详情 + 曲目。
   *
   * 曲目按 `playlist_items.position` 排序，内容从 tracks 缓存 JOIN 回来。
   * 缓存里缺失的曲目会留在 `missing` 里，客户端可据此决定是否回源补全。
   */
  app.get('/api/playlists/:id', async req => {
    const user = requireUser(req);
    const id = (req.params as any).id as string;

    const playlist = repo.getPlaylist(user.id, id);
    if (!playlist) throw notFound('歌单不存在');

    const items = repo.listPlaylistItems(id);
    const missing = items.filter(i => !i.track).map(i => i.trackId);

    return {
      playlist,
      items: items.map(i => ({
        itemId: i.id,
        trackId: i.trackId,
        addedAt: i.addedAt,
        track: i.track,
      })),
      missing,
    };
  });

  app.patch('/api/playlists/:id', async req => {
    const user = requireUser(req);
    const id = (req.params as any).id as string;
    const body = asRecord(req.body);

    const playlist = wrapPlaylistError(() => repo.updatePlaylist(user.id, id, body));
    if (!playlist) throw notFound('歌单不存在');
    return { playlist };
  });

  app.delete('/api/playlists/:id', async req => {
    const user = requireUser(req);
    const id = (req.params as any).id as string;
    const deleted = repo.deletePlaylist(user.id, id);
    if (!deleted) throw notFound('歌单不存在');
    return { ok: true };
  });

  /**
   * 加曲目。
   *
   * 两种用法：
   *   `{ trackIds: [...] }`        直接给 id（客户端已有曲目）
   *   `{ tracks: [ {…Track} ] }`   连曲目内容一起给（客户端刚从上游拿到）
   * 后者会顺手写进曲目缓存，避免"加了歌但歌单显示不出来"。
   */
  app.post('/api/playlists/:id/tracks', async req => {
    const user = requireUser(req);
    const id = (req.params as any).id as string;
    if (!repo.ownsPlaylist(user.id, id)) throw notFound('歌单不存在');

    const body = asRecord(req.body);

    let trackIds: string[];
    if (Array.isArray(body.tracks) && body.tracks.length > 0) {
      upsertTracks(body.tracks as any[]);
      trackIds = (body.tracks as any[])
        .map(t => (t && typeof t.id === 'string' ? t.id : ''))
        .filter(Boolean);
      if (trackIds.length === 0) throw badRequest('tracks 中的曲目缺少 id', 'invalid_track');
    } else {
      trackIds = readTrackIds(body.trackIds);
    }

    const result = repo.addTracks(user.id, id, trackIds);
    const playlist = repo.getPlaylist(user.id, id)!;
    return { ok: true, ...result, playlist };
  });

  /** 按 itemId 移除单条 */
  app.delete('/api/playlists/:id/tracks/:itemId', async req => {
    const user = requireUser(req);
    const id = (req.params as any).id as string;
    const itemId = Number((req.params as any).itemId);

    if (!repo.ownsPlaylist(user.id, id)) throw notFound('歌单不存在');
    if (!Number.isFinite(itemId)) throw badRequest('itemId 不合法', 'invalid_id');

    const removed = repo.removeItem(user.id, id, itemId);
    if (!removed) throw notFound('曲目不在该歌单中');
    return { ok: true };
  });

  /** 按 trackId 移除（客户端只有曲目 id 时用） */
  app.post('/api/playlists/:id/tracks/remove', async req => {
    const user = requireUser(req);
    const id = (req.params as any).id as string;
    if (!repo.ownsPlaylist(user.id, id)) throw notFound('歌单不存在');

    const body = asRecord(req.body);
    const trackId = typeof body.trackId === 'string' ? body.trackId : '';
    if (!trackId) throw badRequest('缺少 trackId', 'missing_param');

    const removed = repo.removeTrack(user.id, id, trackId);
    if (removed === 0) throw notFound('曲目不在该歌单中');
    return { ok: true, removed };
  });

  /**
   * 重排。
   *
   * 必须提交**全部** itemId 的一个完整排列 —— 客户端拖拽后本来就持有完整顺序，
   * 全量覆盖只有一个写入点，不会出现"交换到一半崩了导致乱序"。
   * 数量或成员不匹配说明客户端状态过期，返回 409 让其重新拉取。
   */
  app.put('/api/playlists/:id/order', async req => {
    const user = requireUser(req);
    const id = (req.params as any).id as string;
    if (!repo.ownsPlaylist(user.id, id)) throw notFound('歌单不存在');

    const body = asRecord(req.body);
    if (!Array.isArray(body.itemIds)) throw badRequest('缺少 itemIds', 'missing_param');

    const itemIds = body.itemIds.map(x => Number(x)).filter(n => Number.isFinite(n));
    const ok = repo.reorder(user.id, id, itemIds);
    if (!ok) {
      throw badRequest(
        'itemIds 必须恰好是当前歌单全部条目的一次排列，请重新拉取歌单',
        'stale_order'
      );
    }

    return { ok: true, playlist: repo.getPlaylist(user.id, id) };
  });

  /** 补齐歌单里缺失的曲目内容（缓存被清理后的修复入口） */
  app.post('/api/playlists/:id/hydrate', async req => {
    const user = requireUser(req);
    const id = (req.params as any).id as string;
    if (!repo.ownsPlaylist(user.id, id)) throw notFound('歌单不存在');

    const items = repo.listPlaylistItems(id);
    const ids = items.map(i => i.trackId);
    const limit = intParam((req.query as any)?.limit, 50, { min: 1, max: 200 });

    // 只补前 limit 个缺失项，避免一次请求把整个歌单打向上游
    const missing = items.filter(i => !i.track).slice(0, limit).map(i => i.trackId);
    const present = getTracks(ids);

    return {
      requested: ids.length,
      present: present.length,
      missing,
      tracks: present,
    };
  });
}
