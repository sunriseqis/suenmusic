/**
 * 管理员接口：账号管理与注册开关。
 *
 * 所有路由都过 requireAdmin；成员请求一律 403。
 * 这里只暴露"界面真的会用到"的能力，CLI 里的测试脚本不进 HTTP。
 */
import type { FastifyInstance } from 'fastify';
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
import { getDatabase } from '../db/index.ts';
import { config } from '../config.ts';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badRequest, notFound } from '../http/errors.ts';

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
}
