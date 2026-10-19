/**
 * 播放历史路由 —— 「多端实时同步」的落点。
 *
 * 同步协议（客户端实现只需照做）：
 *   1. 播放发生时 `POST /api/history`（可批量），无需等待响应
 *   2. 周期性 `GET /api/history?since=<cursor>` 拉增量
 *   3. **把返回的 `nextCursor` 存下来**，下次带上；返回 `hasMore: false` 表示已追平
 *   4. 首次同步不传 `since`，从头拉（大历史建议配合 `limit` 多轮拉完）
 *
 * 游标是**记录 id**，不是时间也不是 offset。
 *   - 用 offset：一端在你翻页之间又写了几条，第二页的"第 20 条之后"指的就不是
 *     同一批记录了，必然漏数据。
 *   - 用时间：离线补报的记录时间可能很旧，会被时间游标永久跳过。
 *
 * 记录 id 是插入顺序、严格递增，与业务时间无关，因此对乱序上报天然安全。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser } from '../http/require-auth.ts';
import { badRequest, notFound } from '../http/errors.ts';
import { intParam, strParam } from '../http/params.ts';
import { getTracks, upsertTracks } from '../db/repo/tracks.ts';
import * as repo from '../db/repo/history.ts';

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/** 上报来源：优先用客户端显式声明，否则退回 User-Agent 粗判 */
function detectSource(req: FastifyRequest, explicit: unknown): string {
  if (typeof explicit === 'string' && explicit) return explicit.slice(0, 32);

  const ua = String(req.headers['user-agent'] ?? '').toLowerCase();
  if (ua.includes('okhttp') || ua.includes('dalvik') || ua.includes('android')) return 'android';
  if (ua.includes('mozilla')) return 'web';
  return 'unknown';
}

function deviceId(req: FastifyRequest, explicit: unknown): string {
  if (typeof explicit === 'string' && explicit) return explicit.slice(0, 64);
  const header = req.headers['x-device-id'];
  return typeof header === 'string' ? header.slice(0, 64) : '';
}

/** 单条记录归一化。坏数据（缺 trackId、时间离谱）直接丢弃而不是写脏库。 */
function normalizePlay(
  raw: unknown,
  fallback: { source: string; deviceId: string }
): repo.RecordPlayInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const trackId = typeof r.trackId === 'string' ? r.trackId : '';
  if (!trackId) return null;

  const playedAtRaw = Number(r.playedAt);
  // 拒绝明显不合理的未来时间；过去的时间不限（历史导入需要）
  const playedAt =
    Number.isFinite(playedAtRaw) && playedAtRaw > 0 && playedAtRaw <= Date.now() + 60_000
      ? Math.floor(playedAtRaw)
      : Date.now();

  return {
    userId: 0, // 调用处覆盖
    trackId,
    playedAt,
    playedMs: Number(r.playedMs) || 0,
    durationMs: Number(r.durationMs) || 0,
    completed: r.completed === true,
    source: typeof r.source === 'string' ? r.source.slice(0, 32) : fallback.source,
    deviceId: typeof r.deviceId === 'string' ? r.deviceId.slice(0, 64) : fallback.deviceId,
  };
}

export function registerHistoryRoutes(app: FastifyInstance): void {
  /**
   * 上报播放。
   *
   * 支持两种形态：单条 `{ trackId, ... }` 或批量 `{ plays: [...] }`。
   * 批量是为了离线场景——客户端断网期间攒下的记录联网后一次性补报。
   */
  app.post('/api/history', async (req, reply) => {
    const user = requireUser(req);
    const body = asRecord(req.body);
    const source = detectSource(req, body.source);
    const device = deviceId(req, body.deviceId);

    // 顺手把曲目内容写进缓存，否则历史列表只有 id 没有歌名
    if (Array.isArray(body.tracks)) {
      upsertTracks(body.tracks as any[]);
    }

    const rawList = Array.isArray(body.plays) ? body.plays : [body];
    const normalized: repo.RecordPlayInput[] = [];
    let skipped = 0;

    for (const raw of rawList) {
      const play = normalizePlay(raw, { source, deviceId: device });
      if (!play) {
        skipped++;
        continue;
      }
      play.userId = user.id;
      play.source = play.source || source;
      play.deviceId = play.deviceId || device;
      normalized.push(play);
    }

    if (normalized.length === 0) {
      throw badRequest('没有可用的播放记录（每条至少需要 trackId）', 'invalid_play');
    }
    if (normalized.length > 500) {
      throw badRequest('单次最多上报 500 条', 'too_many_plays');
    }

    const ids = normalized.map(p => repo.recordPlay(p));
    reply.code(201);

    return {
      ok: true,
      recorded: ids.length,
      skipped,
      ids,
      total: repo.countHistory(user.id),
    };
  });

  /**
   * 增量拉取（按插入顺序升序）。
   *
   * 游标是记录 id 而非时间 —— 离线补报的记录时间可能很旧，
   * 用时间游标会让这些记录永久漏掉。详见 `db/repo/history.ts` 的说明。
   *
   * 已追平时 `nextCursor` 会**回显传入的游标**，客户端可以继续拿它轮询，
   * 不需要自己记住位置。
   */
  app.get('/api/history', async req => {
    const user = requireUser(req);
    const q = req.query as Record<string, unknown>;

    const since = strParam(q.since) || null;
    if (since && !repo.decodeCursor(since)) {
      throw badRequest('since 游标应为记录 id（纯数字）', 'invalid_cursor');
    }

    const limit = intParam(q.limit, 100, { min: 1, max: 500 });
    const page = repo.listHistory(user.id, { since, limit });

    return {
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      total: repo.countHistory(user.id),
    };
  });

  /** 最近播放（倒序，默认按曲目去重） */
  app.get('/api/history/recent', async req => {
    const user = requireUser(req);
    const q = req.query as Record<string, unknown>;

    const limit = intParam(q.limit, 50, { min: 1, max: 200 });
    const dedupe = strParam(q.dedupe) !== 'false';
    const items = repo.recentTracks(user.id, { limit, dedupe });

    return { items, total: repo.countHistory(user.id), dedupe };
  });

  /**
   * 跨端续播：某首歌最近一次的播放进度。
   * 客户端拿到后可以把进度条直接拖到 `playedMs`。
   */
  app.get('/api/history/progress/:trackId', async req => {
    const user = requireUser(req);
    const trackId = (req.params as any).trackId as string;

    const progress = repo.lastProgress(user.id, trackId);
    if (!progress) throw notFound('没有该曲目的播放记录');

    return { trackId, ...progress };
  });

  /** 批量取多首的续播进度（首页"继续听"用） */
  app.post('/api/history/progress', async req => {
    const user = requireUser(req);
    const body = asRecord(req.body);
    if (!Array.isArray(body.ids)) throw badRequest('缺少 ids', 'missing_param');

    const ids = body.ids.filter((x): x is string => typeof x === 'string').slice(0, 200);
    const progress: Record<string, { playedMs: number; playedAt: number }> = {};
    for (const id of ids) {
      const p = repo.lastProgress(user.id, id);
      if (p) progress[id] = p;
    }

    return { progress };
  });

  /** 删除单条 */
  app.delete('/api/history/:id', async req => {
    const user = requireUser(req);
    const id = Number((req.params as any).id);
    if (!Number.isFinite(id)) throw badRequest('id 不合法', 'invalid_id');

    const deleted = repo.deleteHistoryEntry(user.id, id);
    if (!deleted) throw notFound('记录不存在');
    return { ok: true };
  });

  /** 清空全部历史（隐私操作，界面上必须有明确的二次确认） */
  app.delete('/api/history', async req => {
    const user = requireUser(req);
    const removed = repo.clearHistory(user.id);
    return { ok: true, removed };
  });

  /** 历史记录里的曲目内容（一次补齐） */
  app.get('/api/history/tracks', async req => {
    const user = requireUser(req);
    const limit = intParam((req.query as any)?.limit, 200, { min: 1, max: 500 });

    const items = repo.recentTracks(user.id, { limit, dedupe: true });
    return { tracks: getTracks(items.map(i => i.trackId)) };
  });
}
