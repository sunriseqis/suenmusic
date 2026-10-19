/**
 * 管理员接口：账号管理与注册开关。
 *
 * 所有路由都过 requireAdmin；成员请求一律 403。
 * 这里只暴露"界面真的会用到"的能力，CLI 里的测试脚本不进 HTTP。
 */
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../http/require-auth.ts';
import { setSetting } from '../db/repo/settings.ts';
import {
  createUser,
  findUserById,
  listUsers,
  setUserRole,
  updatePassword,
  countUsers,
} from '../db/repo/users.ts';
import { registrationAllowed } from '../services/auth.ts';
import { badRequest, notFound } from '../http/errors.ts';

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/users', async req => {
    requireAdmin(req);
    return { users: listUsers() };
  });

  app.post('/api/admin/users', async (req, reply) => {
    requireAdmin(req);
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
    const admin = requireAdmin(req);
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
    requireAdmin(req);
    return { allowRegistration: registrationAllowed() };
  });

  app.patch('/api/admin/settings', async req => {
    requireAdmin(req);
    const body = asRecord(req.body);
    if (typeof body.allowRegistration !== 'boolean') {
      throw badRequest('allowRegistration 必须是布尔值');
    }
    setSetting('allow_registration', body.allowRegistration ? '1' : '0');
    return { ok: true, allowRegistration: body.allowRegistration };
  });
}
