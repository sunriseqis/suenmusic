/**
 * 查询参数归一化。
 *
 * 集中一处的原因是：所有入参都来自 URL，类型是 `string | string[] | undefined`。
 * 每个路由各写一遍 Number()/数组处理，早晚会出现 `limit=1e9` 打爆上游这种事。
 */

import { badRequest } from './errors.ts';

export function strParam(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
  return '';
}

/**
 * 整数参数，带上下界钳制。
 *
 * 越界**不报错而是钳制**：客户端传 `limit=100000` 时截到上限比抛 400 更友好，
 * 而上限存在的意义是保护上游（QQ 与大 B 站都不喜欢超大 num_per_page）。
 */
export function intParam(
  raw: unknown,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const text = strParam(raw);
  if (!text) return fallback;

  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;

  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(n)));
}

/** 必填字符串参数 */
export function requiredParam(raw: unknown, name: string): string {
  const value = strParam(raw);
  if (!value) throw badRequest(`缺少参数 ${name}`, 'missing_param');
  return value;
}

