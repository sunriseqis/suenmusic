/**
 * 用户仓储。
 */

import { getDatabase, now, toNumber } from '../index.ts';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  isValidPasswordLength,
  verifyPassword,
} from '../../utils/password.ts';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  created_at: number;
  updated_at: number;
  /** 令牌纪元，每次改口令 +1。用于让改密前签发的访问令牌立即失效 */
  token_epoch: number;
  /** 'admin' | 'member'。第一个账号是管理员 */
  role: string;
}

/** 对外暴露的用户信息，绝不含口令字段 */
export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  createdAt: number;
  role: 'admin' | 'member';
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: toNumber(row.id),
    username: row.username,
    displayName: row.display_name || row.username,
    createdAt: toNumber(row.created_at),
    role: row.role === 'admin' ? 'admin' : 'member',
  };
}

export interface CreateUserInput {
  username: string;
  password: string;
  displayName?: string;
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`用户名已被占用：${username}`);
    this.name = 'UsernameTakenError';
  }
}

export class InvalidUsernameError extends Error {
  constructor(username: string) {
    super(`用户名不合法：${username}（需 3-32 位字母、数字、下划线或连字符）`);
    this.name = 'InvalidUsernameError';
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super(`口令长度需在 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位之间`);
    this.name = 'WeakPasswordError';
  }
}

/** 用户名规则：3-32 位，字母数字下划线连字符，避免出现不可见字符导致登录不了 */
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export function createUser(input: CreateUserInput): PublicUser {
  const db = getDatabase();
  const ts = now();

  // 仓储层自己守这道门，不指望调用方一定先校验 —— 否则空白字符会被原样存进库，
  // 之后用户再也登录不回来（登录时输入的是 trim 过的版本）
  if (!isValidUsername(input.username)) {
    throw new InvalidUsernameError(input.username);
  }

  // 口令策略同样必须在仓储层守住。HTTP 入口有一条等价校验，但 CLI
  // （`npm run user:add`）走的是另一条路 —— 校验只写在服务层就会被它绕过去。
  // 与用户名的道理完全一样。
  if (!isValidPasswordLength(input.password)) {
    throw new WeakPasswordError();
  }

  const exists = db
    .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .get(input.username);
  if (exists) throw new UsernameTakenError(input.username);

  try {
    // 第一个账号自动成为管理员：没有别的入口能创建它
    const role = countUsers() === 0 ? 'admin' : 'member';
    const res = db
      .prepare(
        `INSERT INTO users (username, password_hash, display_name, created_at, updated_at, role)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.username,
        hashPassword(input.password),
        input.displayName ?? input.username,
        ts,
        ts,
        role
      );

    const id = toNumber(res.lastInsertRowid);
    return {
      id,
      username: input.username,
      displayName: input.displayName ?? input.username,
      createdAt: ts,
      role,
    };
  } catch (err) {
    // 并发注册时唯一索引会先于上面的 SELECT 命中
    if (String((err as Error)?.message ?? '').includes('UNIQUE')) {
      throw new UsernameTakenError(input.username);
    }
    throw err;
  }
}

export function findUserByUsername(username: string): UserRow | null {
  const row = getDatabase()
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username) as UserRow | undefined;
  return row ?? null;
}

export function findUserById(id: number): UserRow | null {
  const row = getDatabase()
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(id) as UserRow | undefined;
  return row ?? null;
}

export function countUsers(): number {
  const row = getDatabase().prepare('SELECT COUNT(*) AS n FROM users').get() as
    | { n: number }
    | undefined;
  return toNumber(row?.n);
}

/**
 * 校验凭据。用户名不存在与口令错误返回同一种失败，避免用户枚举。
 */
export function authenticate(username: string, password: string): PublicUser | null {
  const row = findUserByUsername(username);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return toPublicUser(row);
}

/**
 * 校验某个用户的口令。
 *
 * 与 `authenticate` 的区别：调用方已经知道是谁（来自访问令牌），
 * 这里只做"确认是本人"的二次验证 —— 改密码前的必经一步。
 */
export function verifyUserPassword(userId: number, password: string): boolean {
  const row = findUserById(userId);
  if (!row) return false;
  return verifyPassword(password, row.password_hash);
}

/**
 * 覆写口令。哈希在仓储层生成，调用方拿不到也传不进哈希以外的形式。
 * 返回 false 表示用户不存在（正常情况下不该发生）。
 *
 * 同时把 `token_epoch` 加一 —— 认证层靠它让**改密前签发的访问令牌**立即失效。
 * 这两件事必须一起做，"改密码"才真正等于"所有设备下线"。
 */
export function updatePassword(userId: number, newPassword: string): boolean {
  if (!isValidPasswordLength(newPassword)) {
    throw new WeakPasswordError();
  }

  const res = getDatabase()
    .prepare(
      `UPDATE users
          SET password_hash = ?,
              token_epoch   = token_epoch + 1,
              updated_at    = ?
        WHERE id = ?`
    )
    .run(hashPassword(newPassword), now(), userId);
  return toNumber(res.changes) > 0;
}

/**
 * 读取当前令牌纪元。签发访问令牌时写进 `epo`。
 * 用户不存在返回 0 —— 此时签出的令牌必然被任何纪元拒绝，是安全的失败方向。
 */
export function getTokenEpoch(userId: number): number {
  const row = getDatabase()
    .prepare('SELECT token_epoch FROM users WHERE id = ?')
    .get(userId) as { token_epoch: number } | undefined;
  return toNumber(row?.token_epoch);
}

/**
 * 列出全部用户。
 *
 * 只供 CLI 与运维使用，**不经任何 HTTP 端点暴露** ——
 * 本项目刻意不做管理员体系，所以没有任何"查所有用户"的接口。
 */
/** 删除账号；关联的令牌/收藏/历史由外键级联清理 */
export function deleteUser(userId: number): boolean {
  const res = getDatabase().prepare('DELETE FROM users WHERE id = ?').run(userId);
  return toNumber(res.changes) > 0;
}

/** 设置角色（只允许 admin / member） */
export function setUserRole(userId: number, role: 'admin' | 'member'): boolean {
  const res = getDatabase()
    .prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
    .run(role, now(), userId);
  return toNumber(res.changes) > 0;
}

export function listUsers(): PublicUser[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM users ORDER BY created_at ASC')
    .all() as unknown as UserRow[];
  return rows.map(toPublicUser);
}
