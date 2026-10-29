/**
 * 运维日志 API 封装。契约见 server/src/routes/ops-log.ts。
 */

export type OpsDimension = 'server' | 'cookie' | 'ai';
export type OpsLevel = 'info' | 'warn' | 'error';

export interface OpsLogItem {
  id: number;
  /** 毫秒时间戳 */
  ts: number;
  dimension: OpsDimension;
  level: OpsLevel;
  action: string;
  summary: string;
  /** JSON 文本，可能为 null */
  detail: string | null;
  user: string | null;
  platform: string | null;
  latencyMs: number | null;
  ok: 0 | 1 | null;
}

export interface OpsLogQuery {
  dimension?: OpsDimension | '';
  level?: OpsLevel | '';
  /** 毫秒时间戳 */
  from?: number;
  to?: number;
  /** 对 summary 做 LIKE */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface OpsLogPage {
  total: number;
  items: OpsLogItem[];
}

export interface OpsLogFacets {
  counts: { server: number; cookie: number; ai: number };
}

import { http } from '@/api/client.ts';

export function fetchOpsLogs(query: OpsLogQuery = {}): Promise<OpsLogPage> {
  const p = new URLSearchParams();
  if (query.dimension) p.set('dimension', query.dimension);
  if (query.level) p.set('level', query.level);
  if (query.from !== undefined) p.set('from', String(query.from));
  if (query.to !== undefined) p.set('to', String(query.to));
  if (query.q) p.set('q', query.q);
  if (query.limit !== undefined) p.set('limit', String(query.limit));
  if (query.offset !== undefined) p.set('offset', String(query.offset));
  const qs = p.toString();
  return http.get<OpsLogPage>(`/api/admin/ops/logs${qs ? `?${qs}` : ''}`);
}

/** facets 拿不到就算了：返回 null，调用方只显示 tab 名，不报错 */
export async function fetchOpsLogFacets(): Promise<OpsLogFacets | null> {
  try {
    return await http.get<OpsLogFacets>('/api/admin/ops/logs/facets');
  } catch {
    return null;
  }
}
