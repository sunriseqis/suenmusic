/**
 * 应用级设置仓储（键值对，全局唯一）。
 *
 * 用一张通用键值表而不是给 B 站账号单开一张专表：这类"服务端自己持有的配置"
 * 后面还会长出来（匹配阈值、上游超时、代理地址……），每加一项开一次迁移
 * 不划算。键名集中在本文件上方的常量里，避免字面量散落各处拼错。
 */

import { getDatabase, now, toNumber } from '../index.ts';

export interface SettingRow {
  key: string;
  value: string;
  updatedAt: number;
}

interface SettingDbRow {
  key: string;
  value: string;
  updated_at: number;
}

/** 读一个设置项；不存在返回 null（与"空字符串"区分开） */
export function getSetting(key: string): string | null {
  const row = getDatabase()
    .prepare('SELECT key, value, updated_at FROM app_settings WHERE key = ?')
    .get(key) as SettingDbRow | undefined;

  return row ? row.value : null;
}

export function getSettingRow(key: string): SettingRow | null {
  const row = getDatabase()
    .prepare('SELECT key, value, updated_at FROM app_settings WHERE key = ?')
    .get(key) as SettingDbRow | undefined;

  return row ? { key: row.key, value: row.value, updatedAt: toNumber(row.updated_at) } : null;
}

/** 写入（或覆盖）一个设置项 */
export function setSetting(key: string, value: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, now());
}

/** 删除一个设置项。删除不存在的键不算错误 */
export function deleteSetting(key: string): void {
  getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}

export function countSettings(): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM app_settings')
    .get() as { n: number } | undefined;
  return toNumber(row?.n);
}
