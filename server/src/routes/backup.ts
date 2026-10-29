/**
 * 备份 / 恢复 / 收藏导入导出（管理员）。
 *
 * 全部走 `requireWebAdmin`：服务器配置类操作只允许 Web 面板的同源 cookie 会话
 * （与既有 `/api/admin/backup`、`/api/admin/db/restore` 同口径，见
 * http/require-auth.ts 的产品约定）。
 *
 * 与老路由的分工：
 *   · `GET  /api/admin/backup`        —— 保留：裸 .db 下载（兼容旧前端/脚本）
 *   · `POST /api/admin/db/restore`    —— 保留：裸 .db 恢复
 *   · 本文件                           —— 新形态 `.sm`：口令加密归档 + WebDAV + 定时
 *
 * 口令处理原则：**任何响应都不回传明文或密文**，只给 `hasPassword` 布尔。
 */

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { requireWebAdmin } from '../http/require-auth.ts';
import { badRequest, notFound } from '../http/errors.ts';
import { getDatabase } from '../db/index.ts';
import { addFavorite, countFavorites } from '../db/repo/favorites.ts';
import { upsertTracks } from '../db/repo/tracks.ts';
import { createLogger } from '../logger.ts';
import {
  assertSafeArchiveName,
  backupDir,
  backupDirReady,
  createArchive,
  createAndUpload,
  hasBackupPassword,
  listLocalArchives,
  readBackupPassword,
  readWebdavView,
  restoreWholeDb,
  rotateLocalArchives,
  saveWebdavSettings,
  setBackupPassword,
  webdavDownload,
} from '../services/backup.ts';

const log = createLogger('backup-api');

/** 恢复/上传的请求体上限：整库归档 base64 之后约 1.34 倍，256MB 够家庭实例用很久 */
const LARGE_BODY_LIMIT = 256 * 1024 * 1024;

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/**
 * 口令来源：请求里显式传的优先，否则用库里存的自动备份口令。
 * 两者都没有时给一句能直接照做的提示。
 */
function resolvePassword(body: Record<string, unknown>): string {
  const provided = typeof body.password === 'string' ? body.password : '';
  if (provided.length > 0) return provided;
  const stored = readBackupPassword();
  if (stored) return stored;
  throw badRequest(
    '缺少备份口令：请在请求里传 password，或先设置自动备份口令',
    'backup_password_required'
  );
}

export function registerBackupRoutes(app: FastifyInstance): void {
  /** 状态：本地目录与文件、WebDAV 配置（不含口令）、是否已存口令 */
  app.get('/api/admin/backup/status', async req => {
    requireWebAdmin(req);
    return {
      localDir: backupDir(),
      localDirReady: backupDirReady(),
      localFiles: listLocalArchives(),
      webdav: readWebdavView(),
      hasPassword: hasBackupPassword(),
    };
  });

  /** 设定/更换自动备份口令（明文只在这里出现一次，落库前加密） */
  app.put('/api/admin/backup/password', async req => {
    requireWebAdmin(req);
    const body = asRecord(req.body);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 4) throw badRequest('备份口令至少 4 个字符', 'weak_password');
    setBackupPassword(password);
    log.info('自动备份口令已更新');
    return { ok: true, hasPassword: true };
  });

  /** 生成一份备份到本地（body.password 缺省用已存口令） */
  app.post('/api/admin/backup/local', async req => {
    requireWebAdmin(req);
    const body = asRecord(req.body);
    const created = createArchive({ password: resolvePassword(body) });
    return {
      ok: true,
      fileName: created.fileName,
      size: created.size,
      createdAt: created.createdAt,
      localDir: backupDir(),
      kept: listLocalArchives().length,
    };
  });

  /** 下载本地某份备份；只接受单个 `*.sm` 文件名（防路径穿越） */
  app.get('/api/admin/backup/local/:name', async (req, reply) => {
    requireWebAdmin(req);
    const name = assertSafeArchiveName((req.params as { name?: string }).name);
    const path = join(backupDir(), name);
    if (!existsSync(path) || !statSync(path).isFile()) throw notFound('备份文件不存在');
    const buf = readFileSync(path);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
    );
    reply.header('Content-Length', buf.length);
    return reply.send(buf);
  });

  /** 清理多余的本地备份（只留最新 2 份，与自动轮转同规则） */
  app.post('/api/admin/backup/local/rotate', async req => {
    requireWebAdmin(req);
    return { ok: true, removed: rotateLocalArchives(), kept: listLocalArchives() };
  });

  /** 保存 WebDAV 配置（口令加密存储；留空表示"不改"） */
  app.post('/api/admin/backup/webdav/config', async req => {
    requireWebAdmin(req);
    const body = asRecord(req.body);
    const view = saveWebdavSettings({
      url: typeof body.url === 'string' ? body.url : '',
      username: typeof body.username === 'string' ? body.username : '',
      password: typeof body.password === 'string' ? body.password : undefined,
      enabled: body.enabled === true,
    });
    log.info(`WebDAV 配置已保存：${view.url}（enabled=${view.enabled}, hasPassword=${view.hasPassword}）`);
    return { ok: true, webdav: view };
  });

  /** 生成并上传到 WebDAV，再做远端轮转（只留最新 2 个 `*.sm`） */
  app.post('/api/admin/backup/webdav/upload', async req => {
    requireWebAdmin(req);
    const body = asRecord(req.body);
    const result = await createAndUpload(resolvePassword(body));
    return { ok: true, ...result };
  });

  /** 从 WebDAV 拉取指定文件并**整库恢复** */
  app.post('/api/admin/backup/webdav/pull', { bodyLimit: 1024 * 1024 }, async req => {
    requireWebAdmin(req);
    const body = asRecord(req.body);
    const fileName = assertSafeArchiveName(body.fileName);
    const password = resolvePassword(body);
    const buffer = await webdavDownload(fileName);
    const result = restoreWholeDb(buffer, password);
    log.warn(`已从 WebDAV 恢复整库：${fileName}`);
    return { ok: true, source: 'webdav', fileName, ...result, message: '恢复成功，请用备份里的管理员账号重新登录' };
  });

  /**
   * 上传一份 `.sm` 并整库恢复（base64，避免为 multipart 引入新依赖）。
   *
   * 口令语义（用户口径）：请求里的 password **既可能是当前管理员口令，
   * 也可能就是备份口令** —— 不做额外比对，直接拿它解密；解不开就是"密码不正确"。
   */
  app.post('/api/admin/backup/restore', { bodyLimit: LARGE_BODY_LIMIT }, async req => {
    requireWebAdmin(req);
    const body = asRecord(req.body);
    const dataBase64 = body.dataBase64;
    if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
      throw badRequest('缺少备份文件内容（dataBase64）', 'missing_data');
    }
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length === 0) throw badRequest('备份文件内容为空', 'empty_data');
    const password = resolvePassword(body);

    const result = restoreWholeDb(buffer, password);
    log.warn('已通过上传 .sm 恢复整库');
    return { ok: true, source: 'upload', ...result, message: '恢复成功，请用备份里的管理员账号重新登录' };
  });

  /**
   * 导出收藏列表（**只收藏**，不含账号/黑名单/凭据）。
   *
   * 与旧的 `GET /api/favorites/export`（zip 内含 persona）刻意不同：这里是纯 JSON、
   * 只有曲目，方便脚本与新的导入接口对接。
   */
  app.get('/api/admin/export/favorites', async (req, reply) => {
    const user = requireWebAdmin(req);
    const rows = getDatabase()
      .prepare(
        `SELECT f.track_id, f.created_at,
                t.id, t.mid, t.name, t.artists_json, t.album_id, t.album_mid,
                t.album_name, t.cover_url, t.duration_ms, t.payload_json
           FROM favorites f
           LEFT JOIN tracks t ON t.id = f.track_id
          WHERE f.user_id = ?
          ORDER BY f.created_at DESC, f.track_id DESC`
      )
      .all(user.id) as Array<{
      track_id: string;
      created_at: number;
      id: string | null;
      mid: string | null;
      name: string | null;
      artists_json: string | null;
      album_id: string | null;
      album_mid: string | null;
      album_name: string | null;
      cover_url: string | null;
      duration_ms: number | null;
      payload_json: string | null;
    }>;

    const tracks = rows.map(r => {
      if (r.payload_json) {
        try {
          const parsed = JSON.parse(r.payload_json);
          if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
        } catch {
          /* payload 坏了就按列拼一个最小对象 */
        }
      }
      let ar: Array<{ id?: string; mid?: string; name: string }> = [];
      try {
        ar = JSON.parse(r.artists_json || '[]');
      } catch {
        /* ignore */
      }
      return {
        id: r.id || r.track_id,
        mid: r.mid || undefined,
        name: r.name || '',
        ar,
        al: {
          id: r.album_id || undefined,
          mid: r.album_mid || undefined,
          name: r.album_name || undefined,
          picUrl: r.cover_url || undefined,
        },
        dt: r.duration_ms || 0,
      };
    });

    const payload = {
      app: 'suenmusic',
      version: 1,
      type: 'favorites_backup',
      exportedAt: new Date().toISOString(),
      total: tracks.length,
      tracks,
    };

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `suenmusic-favorites-${stamp}.json`;
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    return reply.send(JSON.stringify(payload, null, 2));
  });

  /**
   * 增量导入收藏：重复的跳过（`favorites` 是 (user_id, track_id) 主键 + INSERT OR IGNORE）。
   *
   * 接受两种入参：`{ tracks: [...] }` 或导出的整个对象（`{ type, total, tracks }`）；
   * 曲目先 upsert 进 tracks 缓存，避免"导入进来列表一片空白"。
   */
  app.post('/api/admin/import/favorites', { bodyLimit: 16 * 1024 * 1024 }, async req => {
    const user = requireWebAdmin(req);
    const body = asRecord(req.body);
    if (!Array.isArray(body.tracks)) throw badRequest('缺少 tracks 数组', 'missing_param');
    if (body.tracks.length > 5000) throw badRequest('tracks 最多 5000 首', 'too_many_tracks');

    const incoming = body.tracks as Array<Record<string, unknown>>;
    const ids = incoming
      .map(t => (t && typeof t.id === 'string' ? t.id : ''))
      .filter(id => id.length > 0);
    if (ids.length === 0) throw badRequest('tracks 里没有有效的曲目 id', 'empty_favorites');

    upsertTracks(incoming as never[]);
    let added = 0;
    for (const id of ids) {
      if (addFavorite(user.id, id)) added++;
    }

    return {
      ok: true,
      received: ids.length,
      added,
      skipped: ids.length - added,
      total: countFavorites(user.id),
    };
  });
}
