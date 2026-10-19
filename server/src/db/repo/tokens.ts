/**
 * 刷新令牌仓储。
 *
 * 只存 sha256 摘要，不存明文 —— 数据库被读走也无法直接换取访问权限。
 * 支持逐个吊销，因此"退出所有设备"和"某台设备丢失"都能处理。
 */

import { randomUUID } from 'node:crypto';
import { getDatabase, now, toNumber } from '../index.ts';
import { randomToken, sha256 } from '../../utils/password.ts';

export interface TokenRow {
  id: string;
  userId: number;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
  lastUsedAt: number;
  userAgent: string;
}

export interface IssuedToken {
  /** 明文令牌，只在签发这一刻存在，之后无从还原 */
  token: string;
  id: string;
  expiresAt: number;
}

interface TokenDbRow {
  id: string;
  user_id: number;
  token_hash: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
  last_used_at: number;
  user_agent: string;
}

function toToken(r: TokenDbRow): TokenRow {
  return {
    id: r.id,
    userId: toNumber(r.user_id),
    expiresAt: toNumber(r.expires_at),
    revokedAt: r.revoked_at === null ? null : toNumber(r.revoked_at),
    createdAt: toNumber(r.created_at),
    lastUsedAt: toNumber(r.last_used_at),
    userAgent: r.user_agent,
  };
}

export function issueRefreshToken(
  userId: number,
  ttlMs: number,
  userAgent = ''
): IssuedToken {
  const token = randomToken(32);
  const id = randomUUID();
  const ts = now();
  const expiresAt = ts + ttlMs;

  getDatabase()
    .prepare(
      `INSERT INTO tokens (id, user_id, token_hash, expires_at, created_at, last_used_at, user_agent)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .run(id, userId, sha256(token), expiresAt, ts, userAgent.slice(0, 200));

  return { token, id, expiresAt };
}

/** 按明文令牌查有效行。已吊销或已过期返回 null。 */
export function findValidRefreshToken(token: string): TokenRow | null {
  if (!token) return null;

  const row = getDatabase()
    .prepare('SELECT * FROM tokens WHERE token_hash = ?')
    .get(sha256(token)) as TokenDbRow | undefined;

  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (toNumber(row.expires_at) <= now()) return null;

  return toToken(row);
}

export function touchRefreshToken(id: string): void {
  getDatabase()
    .prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?')
    .run(now(), id);
}

export function revokeRefreshToken(id: string): boolean {
  const res = getDatabase()
    .prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now(), id);
  return toNumber(res.changes) > 0;
}

/** 退出所有设备 */
export function revokeAllForUser(userId: number): number {
  const res = getDatabase()
    .prepare('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(now(), userId);
  return toNumber(res.changes);
}

export function listActiveTokens(userId: number): TokenRow[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM tokens
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`
    )
    .all(userId, now()) as unknown as TokenDbRow[];
  return rows.map(toToken);
}

/** 清理已吊销或已过期的令牌行 */
export function pruneTokens(): number {
  const res = getDatabase()
    .prepare('DELETE FROM tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL')
    .run(now());
  return toNumber(res.changes);
}
