/**
 * 运维日志查询（管理员）。
 *
 * 与 /api/admin/backup/* 同口径：requireWebAdmin（Web 面板同源 cookie 会话）。
 * 只读接口，不提供任何写入口。
 */

import type { FastifyInstance } from 'fastify';
import { requireWebAdmin } from '../http/require-auth.ts';
import { facets, query } from '../services/ops-log.ts';

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function registerOpsLogRoutes(app: FastifyInstance): void {
  /** GET /api/admin/ops/logs?dimension=&level=&from=&to=&q=&limit=&offset= */
  app.get('/api/admin/ops/logs', async req => {
    requireWebAdmin(req);
    const q = (req.query ?? {}) as Record<string, unknown>;
    return query({
      dimension: typeof q.dimension === 'string' ? q.dimension : null,
      level: typeof q.level === 'string' ? q.level : null,
      from: num(q.from),
      to: num(q.to),
      q: typeof q.q === 'string' ? q.q : null,
      limit: num(q.limit) ?? 50,
      offset: num(q.offset) ?? 0,
    });
  });

  /** GET /api/admin/ops/logs/facets —— 三维度计数 */
  app.get('/api/admin/ops/logs/facets', async req => {
    requireWebAdmin(req);
    return { counts: facets() };
  });
}
