/**
 * 运维日志（ops_logs）：server / cookie / ai 三维度的旁路观测记录。
 *
 * 铁律：record() **绝不抛异常**、绝不阻塞业务 —— 埋点在任何业务路径上，
 * record 内部自己吞掉一切失败（只 warn 一句），调用方无需 try/catch。
 *
 * 隐私约束：**禁止写入 cookie / 口令 / token 明文** —— 调用方只传摘要
 * （登录态布尔、VIP 布尔、失效原因文案），本模块也不做任何凭证字段展开。
 */

import { getDatabase, toNumber } from '../db/index.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('ops-log');

export type OpsDimension = 'server' | 'cookie' | 'ai';
export type OpsLevel = 'info' | 'warn' | 'error';

export interface OpsLogEntry {
  dimension: OpsDimension;
  level?: OpsLevel;
  action: string;
  summary: string;
  /** JSON 文本（已序列化）或 null；调用方负责只放摘要类信息 */
  detail?: string | null;
  user?: string | null;
  platform?: string | null;
  latencyMs?: number | null;
  ok?: 0 | 1 | null;
  ts?: number;
}

export interface OpsLogItem {
  id: number;
  ts: number;
  dimension: OpsDimension;
  level: OpsLevel;
  action: string;
  summary: string;
  detail: string | null;
  user: string | null;
  platform: string | null;
  latencyMs: number | null;
  ok: 0 | 1 | null;
}

export interface OpsQuery {
  dimension?: string | null;
  level?: string | null;
  from?: number | null;
  to?: number | null;
  q?: string | null;
  limit?: number;
  offset?: number;
}

const DIMENSIONS: readonly OpsDimension[] = ['server', 'cookie', 'ai'];
const LEVELS: readonly OpsLevel[] = ['info', 'warn', 'error'];

function asDimension(v: unknown): OpsDimension | null {
  return DIMENSIONS.includes(v as OpsDimension) ? (v as OpsDimension) : null;
}

function asLevel(v: unknown): OpsLevel | null {
  return LEVELS.includes(v as OpsLevel) ? (v as OpsLevel) : null;
}

interface OpsLogDbRow {
  id: number | bigint;
  ts: number | bigint;
  dimension: string;
  level: string;
  action: string;
  summary: string;
  detail: string | null;
  user: string | null;
  platform: string | null;
  latency_ms: number | bigint | null;
  ok: number | null;
}

function toItem(row: OpsLogDbRow): OpsLogItem {
  const ok = row.ok === null || row.ok === undefined ? null : toNumber(row.ok);
  return {
    id: toNumber(row.id),
    ts: toNumber(row.ts),
    dimension: row.dimension as OpsDimension,
    level: row.level as OpsLevel,
    action: row.action,
    summary: row.summary,
    detail: row.detail ?? null,
    user: row.user ?? null,
    platform: row.platform ?? null,
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : toNumber(row.latency_ms),
    ok: (ok === 0 || ok === 1 ? ok : null) as 0 | 1 | null,
  };
}

/** 写一条运维日志。任何失败只 warn，绝不抛出。 */
export function record(entry: OpsLogEntry): void {
  try {
    const dimension = asDimension(entry.dimension) ?? 'server';
    const level = asLevel(entry.level) ?? 'info';
    getDatabase()
      .prepare(
        `INSERT INTO ops_logs
           (ts, dimension, level, action, summary, detail, user, platform, latency_ms, ok)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.ts ?? Date.now(),
        dimension,
        level,
        String(entry.action ?? '').slice(0, 64),
        String(entry.summary ?? '').slice(0, 500),
        entry.detail ?? null,
        entry.user ?? null,
        entry.platform ?? null,
        entry.latencyMs === null || entry.latencyMs === undefined
          ? null
          : Math.max(0, Math.round(Number(entry.latencyMs) || 0)),
        entry.ok === 0 || entry.ok === 1 ? entry.ok : null,
      );
  } catch (err) {
    log.warn(`ops_logs 写入失败（已忽略）：${(err as Error)?.message ?? String(err)}`);
  }
}

/** 查询（过滤 + 分页）。q 对 summary 做 LIKE（包含匹配）。 */
export function query(params: OpsQuery): { total: number; items: OpsLogItem[] } {
  const where: string[] = [];
  const args: unknown[] = [];

  const dimension = asDimension(params.dimension);
  if (dimension) {
    where.push('dimension = ?');
    args.push(dimension);
  }
  const level = asLevel(params.level);
  if (level) {
    where.push('level = ?');
    args.push(level);
  }
  if (typeof params.from === 'number' && Number.isFinite(params.from)) {
    where.push('ts >= ?');
    args.push(Math.round(params.from));
  }
  if (typeof params.to === 'number' && Number.isFinite(params.to)) {
    where.push('ts <= ?');
    args.push(Math.round(params.to));
  }
  const q = String(params.q ?? '').trim();
  if (q) {
    where.push('summary LIKE ?');
    args.push(`%${q.replace(/[%_]/g, ch => '\\' + ch)}%` as unknown);
  }

  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const db = getDatabase();
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM ops_logs${whereSql}`)
    .get(...(args as never[])) as { c: number | bigint };
  const total = toNumber(totalRow.c);

  const limit = Math.min(200, Math.max(1, Math.round(Number(params.limit) || 50)));
  const offset = Math.max(0, Math.round(Number(params.offset) || 0));

  const rows = db
    .prepare(
      `SELECT * FROM ops_logs${whereSql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...(args as never[]), limit, offset) as unknown as OpsLogDbRow[];

  return { total, items: rows.map(toItem) };
}

/** 三个维度的计数（不过滤，给 facets 接口）。 */
export function facets(): { server: number; cookie: number; ai: number } {
  const rows = getDatabase()
    .prepare('SELECT dimension, COUNT(*) AS c FROM ops_logs GROUP BY dimension')
    .all() as unknown as Array<{ dimension: string; c: number | bigint }>;
  const counts = { server: 0, cookie: 0, ai: 0 };
  for (const row of rows) {
    const dim = asDimension(row.dimension);
    if (dim) counts[dim] = toNumber(row.c);
  }
  return counts;
}

/** 删除早于 cutoffMs 之前（按 ts 比较）的记录，返回删除行数。 */
export function purgeOlderThan(cutoffTs: number): number {
  try {
    const res = getDatabase()
      .prepare('DELETE FROM ops_logs WHERE ts < ?')
      .run(cutoffTs);
    return toNumber(res.changes);
  } catch (err) {
    log.warn(`ops_logs 清理失败（已忽略）：${(err as Error)?.message ?? String(err)}`);
    return 0;
  }
}

/** 便捷封装：清理 7 天前的记录。 */
export function purgeOlderThanDays(days: number): number {
  return purgeOlderThan(Date.now() - days * 24 * 60 * 60 * 1000);
}
