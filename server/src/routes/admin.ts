/**
 * 管理员接口：账号管理与注册开关。
 *
 * 所有路由都过 requireAdmin；成员请求一律 403。
 * 这里只暴露"界面真的会用到"的能力，CLI 里的测试脚本不进 HTTP。
 */
import type { FastifyInstance } from 'fastify';
import { requireWebAdmin } from '../http/require-auth.ts';
import { setSetting, deleteSetting } from '../db/repo/settings.ts';
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
import { readAiHealthView } from '../services/ai-health.ts';
import { startKugouQrLogin, pollKugouQrLogin, readKugouCredentialStatus } from '../services/kugou-login.ts';
import { invalidateKugouStatusCache, readKugouLoginState } from '../services/kugou-status.ts';
import { readKugouCheckinState, runKugouCheckin } from '../services/kugou-checkin.ts';
import { countAnchors, deleteAutoAnchors } from '../db/repo/anchors.ts';
import { fetchArtistSongsMulti } from '../services/artist-songs-multi.ts';

import { createLogger } from '../logger.ts';

const log = createLogger('admin');
import { currentDatabasePath } from '../db/index.ts';
import { InvalidUsernameError, UsernameTakenError, WeakPasswordError } from '../db/repo/users.ts';
import { config } from '../config.ts';
import { statSync } from 'node:fs';
import { badRequest, conflict, notFound } from '../http/errors.ts';

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/**
 * 仓储层的校验异常 → HTTP 语义。
 *
 * 不加这层的话，`createUser` / `updatePassword` 抛的 `UsernameTakenError`
 * 之类会一路逃到全局错误处理器，变成 500「服务端内部错误」——
 * 管理员看到的是"服务器挂了"，实际只是重名或口令太弱（重审 F）。
 */
function mapUserRepoError(err: unknown): never {
  if (err instanceof UsernameTakenError) throw conflict('该用户名已被占用', 'username_taken');
  if (err instanceof InvalidUsernameError) {
    throw badRequest('用户名只能包含字母、数字、下划线和连字符，长度 3-32 位', 'invalid_username');
  }
  if (err instanceof WeakPasswordError) throw badRequest(err.message, 'weak_password');
  throw err instanceof Error ? err : new Error(String(err));
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
    let user;
    try {
      user = createUser({
        username: body.username,
        password: body.password,
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      });
    } catch (err) {
      mapUserRepoError(err);
    }
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
      try {
        updatePassword(id, body.password);
      } catch (err) {
        mapUserRepoError(err);
      }
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
      dbBytes = statSync(currentDatabasePath()).size;
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
   * AI 健康度：最近一次尝试/成功/失败 + 连续失败次数 + 一句人话判定。
   *
   * 数据由生成流程写入（`services/ai-health.ts`：复核 ok 记成功，失败按 401/429/超时…分类记失败），
   * 这里只做读取映射 —— 面板不该自己再猜一遍原因。
   */
  app.get('/api/admin/ai-health', async req => {
    requireWebAdmin(req);
    return readAiHealthView();
  });

  /**
   * 酷狗扫码登录（三步）：
   *   POST /api/admin/kugou/login/qr     → 生成二维码（pngBase64 dataURL 直接给 <img>）
   *   POST /api/admin/kugou/login/poll   → 轮询扫码状态（confirmed 时凭据已落库）
   *   GET  /api/admin/kugou/credentials  → 查凭据是否已存在
   *
   * 凭据落在 app_settings 的 kugou.credentials（管理员通道），用于 VIP 取流。
   * 用户扫码必须用**概念版 App**（权益跟平台参数走）。
   */
  app.post('/api/admin/kugou/login/qr', async () => {
    const session = await startKugouQrLogin();
    return { ok: true, pngBase64: session.pngBase64, expiresInSec: Math.round((session.expiresAt - Date.now()) / 1000) };
  });

  app.post('/api/admin/kugou/login/poll', async () => {
    const r = await pollKugouQrLogin();
    return { ok: true, ...r };
  });

  /**
   * 直接导入酷狗凭据（供外部登录态使用）。
   *
   * 为什么需要：扫码/手机号登录只下发 `token`，**拿不到 `vip_token`** ——
   * 没有 vip_token 时酷狗只给 60 秒试听片段（实测：每首直链都是 ~960KB@128k）。
   * 概念版客户端自己的登录态里带 vip_token，把那份 cookie 灌进来即可拿到完整音频。
   *
   * body: { token, userid, vipToken?, t1?, nickname? }
   */
  app.post('/api/admin/kugou/credentials/import', async req => {
    const body = (req.body ?? {}) as {
      token?: string; userid?: unknown; vipToken?: string; t1?: string; nickname?: string;
      mid?: string; dfid?: string; guid?: string;
      /** 直接粘 Cookie 串（抓包/工具状态文件），省得逐个字段抠 */
      cookie?: string;
    };
    const parseCookie = (text: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const seg of text.split(';')) {
        const i = seg.indexOf('=');
        if (i <= 0) continue;
        out[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
      }
      return out;
    };
    const cookie = body.cookie ? parseCookie(String(body.cookie)) : {};
    const token = String(body.token ?? cookie.token ?? '').trim();
    const userid = String(body.userid ?? cookie.userid ?? '').trim();
    if (!token || !userid) throw badRequest('token 与 userid 必填（或直接给 cookie 串）', 'invalid_param');
    setSetting(
      'kugou.credentials',
      JSON.stringify({
        token,
        userid,
        // vip_token 是完整音频的关键：没有它酷狗只给 60 秒试听片段
        vipToken: String(body.vipToken ?? cookie.vip_token ?? cookie.viptoken ?? ''),
        t1: String(body.t1 ?? cookie.t1 ?? ''),
        nickname: String(body.nickname ?? ''),
        mid: String(body.mid ?? cookie.mid ?? cookie.KugouC1 ?? '') || undefined,
        dfid: String(body.dfid ?? cookie.dfid ?? '') || undefined,
        guid: String(body.guid ?? cookie.guid ?? '') || undefined,
        savedAt: Date.now(),
      })
    );
    deleteSetting('kugou.credentialsInvalidAt');
    invalidateKugouStatusCache();
    log.info(`酷狗凭据已导入：userid=${userid} vip_token=${body.vipToken ? '有' : '无'}`);
    await runKugouCheckin(true).catch(err =>
      log.warn(`导入凭据后自动签到失败：${(err as Error)?.message ?? String(err)}`),
    );
    return { ok: true, ...(await readKugouLoginState()) };
  });

  /**
   * 建库 dry-run：只跑多源拉取、**不写库**，用于上线前评估命中率与请求量。
   *
   * 参数 `names`（逗号分隔的歌手名，最多 5 个）。返回每位歌手的命中数与消耗的上游请求数，
   * 以及前 5 首曲目名，便于判断「酷狗为主」是否真的够用、要不要退到网易云/QQ。
   */
  app.post('/api/admin/library/dry-run', async req => {
    const body = (req.body ?? {}) as { names?: unknown };
    const raw = Array.isArray(body.names)
      ? body.names.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, 5)
      : String(body.names ?? '')
          .split(/[,，;；]/)
          .map(s => s.trim())
          .filter(Boolean)
          .slice(0, 5);
    if (raw.length === 0) throw badRequest('缺少 names', 'missing_param');

    const results = [];
    for (const name of raw) {
      // 串行 + 间隔：dry-run 也是真实上游请求，别把风控打出来
      const r = await fetchArtistSongsMulti(name, 30, { stopWhenEnough: true });
      results.push({
        name,
        source: r.source,
        requests: r.requests,
        counts: r.detail,
        total: r.songs.length,
        sample: r.songs.slice(0, 5).map(s => `${s.name} - ${(s.ar ?? []).map(a => a.name).join('/')}`),
      });
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    log.info(`建库 dry-run 完成：${results.map(r => `${r.name}=${r.total}(${r.source})`).join(' ')}`);
    return { ok: true, results };
  });

  /** 锚点概况（自动 / 手动条数），面板展示与确认文案用 */
  app.get('/api/admin/anchors', async () => {
    return { ok: true, ...countAnchors() };
  });

  /**
   * 清理**自动沉淀**锚点（pinned = 0）。手动锚定一条都不动。
   *
   * 多源改造后「酷狗为主」的收益会被历史 B 站自动锚点吃掉（锚点优先于取流链），
   * 这个开关让用户可以随时把自动锚点清空重算，而不必逐个解锚。
   */
  app.post('/api/admin/anchors/purge-auto', async () => {
    const removed = deleteAutoAnchors();
    log.info(`管理员清理自动锚点：${removed} 条`);
    return { ok: true, removed, ...countAnchors() };
  });

  app.get('/api/admin/kugou/credentials', async () => {
    return { ok: true, ...readKugouCredentialStatus() };
  });

  /**
   * 酷狗登录态（四态：未登录 / 失效 / 会员到期 / 正常）。
   * 两端设置页都读这一个接口，文案由服务端给，避免两端各自拼出不同说法。
   */
  app.get('/api/admin/kugou/status', async () => {
    return { ok: true, ...(await readKugouLoginState()) };
  });

  /** 查询酷狗今日签到与概念 SVIP 升级状态 */
  app.get('/api/admin/kugou/checkin', async () => {
    return { ok: true, ...readKugouCheckinState() };
  });

  /** 手动触发酷狗今日签到与概念 SVIP 升级 */
  app.post('/api/admin/kugou/checkin', async () => {
    invalidateKugouStatusCache();
    const checkin = await runKugouCheckin(true);
    const status = await readKugouLoginState();
    return { ok: true, checkin, status };
  });

  /** 退出授权：清掉 kugou.credentials（对齐 B 站 DELETE /api/bilibili/account 的语义） */
  app.delete('/api/admin/kugou/credentials', async () => {
    deleteSetting('kugou.credentials');
    deleteSetting('kugou.credentialsInvalidAt');
    deleteSetting('kugou.checkin');
    invalidateKugouStatusCache();
    log.info('酷狗授权已退出（凭据清除）');
    return { ok: true };
  });
}
