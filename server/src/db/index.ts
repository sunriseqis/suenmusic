/**
 * 数据库连接与迁移。
 *
 * 用 Node 内置的 `node:sqlite`（同步 API）而不是 better-sqlite3 —— 后者是原生模块，
 * 在 Windows 上需要本地编译，这个项目已经在 esbuild 平台二进制上踩过一次坑了。
 * 同步 API 在单机服务端场景完全够用，还省掉了连接池。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('db');

/** 迁移文件目录（本文件位于 src/db/） */
const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

let instance: DatabaseSync | null = null;

/** 打开（或复用）数据库连接。重复调用返回同一实例。 */
export function openDatabase(path: string = config.dbPath): DatabaseSync {
  if (instance) return instance;

  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  // WAL：读写不互相阻塞，HTTP 服务与后台任务并存时是必需的
  db.exec('PRAGMA journal_mode = WAL');
  // 外键默认是关的，必须每个连接显式打开，否则 ON DELETE CASCADE 全是摆设
  db.exec('PRAGMA foreign_keys = ON');
  // 写锁等待 5 秒再报 SQLITE_BUSY，而不是立刻失败
  db.exec('PRAGMA busy_timeout = 5000');
  // WAL 下 NORMAL 是安全且快的档位（掉电最多丢最后一个事务，不会损坏库）
  db.exec('PRAGMA synchronous = NORMAL');

  instance = db;
  return db;
}

export function getDatabase(): DatabaseSync {
  return instance ?? openDatabase();
}

export function closeDatabase(): void {
  if (!instance) return;
  try {
    instance.close();
  } finally {
    instance = null;
  }
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** 从 migrations/ 目录读取全部迁移，按文件名前缀数字升序。 */
export function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  return files.map(file => {
    const match = /^(\d+)[-_](.+?)\.sql$/.exec(file);
    if (!match) {
      throw new Error(`迁移文件名不合法（应形如 001_init.sql）：${file}`);
    }
    return {
      version: Number(match[1]),
      name: match[2],
      sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8'),
    };
  });
}

/**
 * 应用所有未执行的迁移。幂等 —— 已应用的版本会跳过。
 *
 * 每个迁移包在自己的事务里：中途失败则整个迁移回滚，
 * 不会留下"表建了一半"的中间状态。
 *
 * @returns 本次实际应用的迁移数量
 */
export function migrate(db: DatabaseSync = getDatabase()): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map(r => Number(r.version)));

  const pending = loadMigrations().filter(m => !applied.has(m.version));
  if (pending.length === 0) {
    log.debug('schema 已是最新，无需迁移');
    return 0;
  }

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );

  for (const m of pending) {
    log.info(`应用迁移 ${String(m.version).padStart(3, '0')}_${m.name}`);
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      record.run(m.version, m.name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `迁移 ${m.version}_${m.name} 失败：${(err as Error)?.message ?? err}`
      );
    }
  }

  return pending.length;
}

/**
 * 在事务里执行一段同步逻辑。
 *
 * 注意：**不支持嵌套**。node:sqlite 没有保存点封装，嵌套 BEGIN 会直接报错。
 * 需要在事务内复用的逻辑请写成接受 db 参数的普通函数，由外层统一开事务。
 */
export function transaction<T>(fn: () => T, db: DatabaseSync = getDatabase()): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚本身失败时保留原始异常，它更有诊断价值
    }
    throw err;
  }
}

/** 当前时间（毫秒）。集中一处，方便将来换时钟源做测试。 */
export function now(): number {
  return Date.now();
}

/** SQLite 的 lastInsertRowid 在不同版本可能是 bigint，统一转 number。 */
export function toNumber(value: number | bigint | undefined | null): number {
  return value === undefined || value === null ? 0 : Number(value);
}
