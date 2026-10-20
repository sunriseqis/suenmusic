/**
 * 管理员接口：账号管理与注册开关。
 *
 * 所有路由都过 requireAdmin；成员请求一律 403。
 * 这里只暴露"界面真的会用到"的能力，CLI 里的测试脚本不进 HTTP。
 */
import type { FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { requireWebAdmin } from '../http/require-auth.ts';
import { setSetting } from '../db/repo/settings.ts';
import {
  createUser,
  findUserById,
  listUsers,
  setUserRole,
  updatePassword,
  countUsers,
  deleteUser,
} from '../db/repo/users.ts';
import { passwordMinLength, registrationAllowed } from '../services/auth.ts';
import { invalidateLocalCatalogCache } from '../services/local-catalog.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('admin');
import { closeDatabase, getDatabase, migrate, openDatabase } from '../db/index.ts';
import { config } from '../config.ts';
import {
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, badRequest, notFound } from '../http/errors.ts';

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/users', async req => {
    requireWebAdmin(req);
    return { users: listUsers() };
  });

  app.post('/api/admin/users', async (req, reply) => {
    requireWebAdmin(req);
    const body = asRecord(req.body);
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      throw badRequest('用户名与口令必填');
    }
    const user = createUser({
      username: body.username,
      password: body.password,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    });
    reply.code(201);
    return { user };
  });

  app.patch('/api/admin/users/:id', async req => {
    const admin = requireWebAdmin(req);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('用户 id 不合法');
    const target = findUserById(id);
    if (!target) throw notFound('用户不存在');

    const body = asRecord(req.body);
    let changed = false;

    if (typeof body.password === 'string' && body.password.length > 0) {
      updatePassword(id, body.password);
      changed = true;
    }

    if (body.role === 'admin' || body.role === 'member') {
      // 不能把最后一个管理员降级，否则没人能再进管理面
      if (target.role === 'admin' && body.role === 'member' && countUsers() > 0) {
        const admins = listUsers().filter(u => u.role === 'admin');
        if (admins.length <= 1) throw badRequest('至少保留一个管理员');
      }
      if (target.id === admin.id && body.role === 'member') {
        throw badRequest('不能降级当前登录的管理员');
      }
      setUserRole(id, body.role);
      changed = true;
    }

    return { ok: true, changed };
  });

  app.get('/api/admin/settings', async req => {
    requireWebAdmin(req);
    return { allowRegistration: registrationAllowed(), passwordMinLength: passwordMinLength() };
  });

  app.patch('/api/admin/settings', async req => {
    requireWebAdmin(req);
    const body = asRecord(req.body);

    if (typeof body.allowRegistration === 'boolean') {
      setSetting('allow_registration', body.allowRegistration ? '1' : '0');
    }
    if (typeof body.passwordMinLength === 'number') {
      if (body.passwordMinLength < 8 || body.passwordMinLength > 64) {
        throw badRequest('口令长度需在 8–64 之间');
      }
      setSetting('password_min_length', String(Math.floor(body.passwordMinLength)));
    }

    return {
      ok: true,
      allowRegistration: registrationAllowed(),
      passwordMinLength: passwordMinLength(),
    };
  });

  /** 删除成员。不能删自己，也不能删掉最后一个管理员 */
  app.delete('/api/admin/users/:id', async req => {
    const admin = requireWebAdmin(req);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('用户 id 不合法');
    const target = findUserById(id);
    if (!target) throw notFound('用户不存在');
    if (target.id === admin.id) throw badRequest('不能删除当前登录的账号');
    if (target.role === 'admin') {
      const admins = listUsers().filter(u => u.role === 'admin');
      if (admins.length <= 1) throw badRequest('至少保留一个管理员');
    }
    deleteUser(id);
    return { ok: true };
  });

  /**
   * 运行情况：给管理员面板用。
   * 数据库大小直接从文件取，进程信息来自 process。
   */
  app.get('/api/admin/health', async req => {
    requireWebAdmin(req);
    let dbBytes = 0;
    try {
      dbBytes = statSync(config.dbPath).size;
    } catch {
      dbBytes = 0;
    }
    return {
      ok: true,
      version: process.env.npm_package_version || '0.1.0',
      uptimeSec: Math.round(process.uptime()),
      dbBytes,
      users: countUsers(),
    };
  });

  /**
   * 下载数据库备份。
   *
   * 用 `VACUUM INTO` 生成一致性快照（直接拷 .db 在 WAL 模式下可能缺数据），
   * 读成 Buffer 再删临时文件；家庭实例的库不大，这样最简单。
   */
  app.get('/api/admin/backup', async (req, reply) => {
    requireWebAdmin(req);
    const file = join(tmpdir(), `suenmusic-backup-${Date.now()}.db`);
    try {
      getDatabase().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const buf = readFileSync(file);
      const stamp = new Date().toISOString().slice(0, 10);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="suenmusic-${stamp}.db"`);
      return reply.send(buf);
    } finally {
      try {
        unlinkSync(file);
      } catch {
        /* 临时文件删不掉不影响下载结果 */
      }
    }
  });

  /**
   * 恢复数据库：上传 .db 文件整体替换当前库。
   *
   * 安全链（任何一步失败都回滚到原库）：
   *   1. 文件头必须是 `SQLite format 3\0`，否则不是 SQLite 库
   *   2. 临时连接上跑 PRAGMA integrity_check + 必需表检查（users / schema_migrations）
   *   3. VACUUM INTO 给当前库留一份 `.pre-restore-<ts>.db` 兜底（**不删**，
   *      回滚或手动抢救都用它，路径随响应返回）
   *   4. 关闭连接 → 替换 .db（连同 -wal/-shm）→ 重开 → 补跑迁移
   *      （上传的库可能是旧 schema，迁移把它带到当前版本）
   *   5. 失败则从兜底拷贝回原库、重开、补迁移，返回 500
   *
   * 注意：JWT 是无状态的，恢复后旧令牌仍可用，但只对恢复库里存在的账号有效；
   * 会话失效时前端会走 401 重新登录。
   */
  app.post(
    '/api/admin/db/restore',
    { bodyLimit: 200 * 1024 * 1024 },
    async (req, reply) => {
      requireWebAdmin(req);
      const body = asRecord(req.body);
      const dataBase64 = body.dataBase64;
      if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
        throw badRequest('缺少数据库文件内容');
      }

      const buf = Buffer.from(dataBase64, 'base64');
      if (buf.length < 512) {
        throw badRequest('文件太小，不是有效的数据库');
      }
      if (buf.toString('latin1', 0, 16) !== 'SQLite format 3\0') {
        throw badRequest('不是 SQLite 数据库文件（文件头不符）');
      }

      const dbPath = config.dbPath;
      const uploadPath = `${dbPath}.upload.tmp`;
      writeFileSync(uploadPath, buf);

      // 2) 完整性与表结构校验（临时连接，不动正在服务的库）
      const requiredTables = ['users', 'schema_migrations'];
      let probe: DatabaseSync | null = null;
      try {
        probe = new DatabaseSync(uploadPath);
        const check = probe
          .prepare('PRAGMA integrity_check')
          .get() as { integrity_check: string } | undefined;
        if (!check || check.integrity_check !== 'ok') {
          throw badRequest(
            `数据库完整性检查未通过：${check?.integrity_check ?? '无结果'}`
          );
        }
        const tables = (
          probe
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map(r => r.name);
        for (const t of requiredTables) {
          if (!tables.includes(t)) {
            throw badRequest(`数据库缺少必需表：${t}`);
          }
        }
      } catch (err) {
        try {
          rmSync(uploadPath, { force: true });
        } catch {
          /* 清理失败不影响错误返回 */
        }
        if (err instanceof AppError) throw err;
        throw badRequest(
          `上传文件无法作为数据库打开：${(err as Error)?.message ?? err}`
        );
      } finally {
        try {
          probe?.close();
        } catch {
          /* ignore */
        }
      }

      // 3) 当前库兜底备份（保留，不删）
      const backupPath = `${dbPath}.pre-restore-${Date.now()}.db`;
      try {
        getDatabase().exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      } catch (err) {
        try {
          rmSync(uploadPath, { force: true });
        } catch {
          /* ignore */
        }
        throw new AppError(
          500,
          'backup_failed',
          `备份当前数据库失败，已中止恢复：${(err as Error)?.message ?? err}`
        );
      }

      // 4) 热替换：关连接 → 换文件 → 重开 → 补迁移
      try {
        closeDatabase();
        // WAL 附属文件：close 时已 checkpoint，防御性删除避免旧 WAL 覆盖新库
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
        renameSync(uploadPath, dbPath);
        const reopened = openDatabase();
        migrate(reopened);
      } catch (err) {
        // 5) 回滚：兜底拷回、重开、补迁移
        let rolledBack = false;
        try {
          closeDatabase();
          rmSync(`${dbPath}-wal`, { force: true });
          rmSync(`${dbPath}-shm`, { force: true });
          copyFileSync(backupPath, dbPath);
          const reopened = openDatabase();
          migrate(reopened);
          rolledBack = true;
        } catch (rollbackErr) {
          log?.error?.(
            `恢复失败且回滚失败，请手动用 ${backupPath} 覆盖 ${dbPath}：${
              (rollbackErr as Error)?.message ?? rollbackErr
            }`
          );
        }
        throw new AppError(
          500,
          rolledBack ? 'restore_failed' : 'restore_failed_rollback_failed',
          rolledBack
            ? `恢复失败，已自动回滚到原数据库：${(err as Error)?.message ?? err}`
            : `恢复失败且回滚失败，请手动用 ${backupPath} 覆盖 ${dbPath} 后重启服务`
        );
      }

      // 内存缓存失效（本地曲库缓存等服务级缓存）
      invalidateLocalCatalogCache();

      // 恢复后统计（给前端一个确认反馈）
      const db = getDatabase();
      const countOf = (table: string): number => {
        try {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          };
          return Number(row.n);
        } catch {
          return -1;
        }
      };
      const versionRow = db
        .prepare('SELECT MAX(version) AS v FROM schema_migrations')
        .get() as { v: number | null } | undefined;

      return {
        ok: true,
        backupPath,
        users: countOf('users'),
        tracks: countOf('tracks'),
        schemaVersion: versionRow?.v ?? null,
      };
    }
  );
}
