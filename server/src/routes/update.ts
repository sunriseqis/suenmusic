/**
 * 更新通道 HTTP 面。**唯一来源是 GitHub Releases**，服务端拉回本地缓存后由客户端从这里下载。
 *
 *   GET /api/update/check     查是否有新版本（读本地缓存，零上游；`force=1` 才去 GitHub 核对）
 *   GET /api/update/download  下载产物（本地文件流式发送，**支持 Range/206**）
 *
 * 为什么客户端不直连 GitHub：
 *   ① 国内访问 objects.githubusercontent.com 极不稳定；
 *   ② 鸿蒙客户端走系统浏览器/侧签工具，**发不出鉴权头**；
 *   ③ 缓存到本地后能支持断点续传。
 *
 * （老的 UGREEN 分享源已于 2026-10-21 按用户要求删除。）
 */

import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { requireUser, requireWebAdmin } from '../http/require-auth.ts';
import { badGateway, badRequest, serviceUnavailable } from '../http/errors.ts';
import { config } from '../config.ts';
import {
  PLATFORM_CONTENT_TYPE,
  compareVersionName,
  isUpdatePlatform,
  type UpdatePlatform,
} from '../services/update-types.ts';
import { signUpdateToken, verifyUpdateToken } from '../utils/update-token.ts';
import { cachedFilePath, checkServerUpdate, readCachedArtifact, refreshPlatform, versionCodeOf } from '../services/github-update.ts';
import {
  getUpdateProxySettings,
  saveUpdateProxySettings,
  validateProxy,
  type UpdateProxyKind,
} from '../services/update-settings.ts';
import { SERVER_VERSION } from '../app.ts';
import { getDeployMode } from '../services/deploy-mode.ts';

function versionName(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)*$/.test(text)) throw badRequest('当前版本号格式不正确', 'invalid_version');
  return text;
}

function versionCode(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0) throw badRequest('当前版本号格式不正确', 'invalid_version');
  return n;
}

/** 平台参数。缺省按安卓 —— 老客户端从不带这个参数，行为必须保持不变。 */
function platform(value: unknown): UpdatePlatform {
  const text = String(value ?? 'android').trim().toLowerCase();
  if (!isUpdatePlatform(text)) throw badRequest('不支持的更新平台', 'invalid_platform');
  return text;
}

function upstreamError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  throw badGateway(`更新源暂时不可用：${message}`, 'update_upstream_failed');
}

export function registerUpdateRoutes(app: FastifyInstance): void {
  app.get('/api/update/check', async req => {
    requireUser(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const currentName = versionName(query.version_name);
    const currentCode = versionCode(query.version_code);
    const force = ['1', 'true', 'yes'].includes(String(query.force ?? '').toLowerCase());
    const target = platform(query.platform);

    // 来源以 Web 设置页为准（env 只作初始缺省）
    if (getUpdateProxySettings().source === 'off' || config.updateSource === 'off') {
      return serviceUnavailable('更新服务已关闭', 'update_not_configured');
    }

    /**
     * 默认**只读本地缓存**：客户端登录/回前台/定时检查都不会给 GitHub 添压力，
     * 也不会被它的限流牵连。只有 `force=1`（用户手点检查更新）才去上游核对。
     */
    let artifact;
    try {
      artifact = force
        ? await refreshPlatform(target, true)
        : readCachedArtifact(target);
      if (!artifact) {
        // 首次启动还没轮询到：同步拉一次，避免"刚开机查不到更新"
        artifact = await refreshPlatform(target, true);
      }
    } catch (err) {
      return upstreamError(err);
    }

    const noUpdate = {
      available: false,
      current: { versionName: currentName, versionCode: currentCode },
      latest: artifact,
      downloadPath: '/api/update/download',
      downloadToken: signUpdateToken(target),
    };
    if (!artifact) return noUpdate;

    // GitHub 没有 versionCode（恒 0）→ 退回按 versionName 比较
    /**
     * 比对**单一轴**：versionCode（2026-10-24 用户裁定）。
     * latest 的 code 由 `versionCodeOf(versionName)` 推导（上游恒 0）；客户端上报自己的 code。
     * 兜底：任一侧拿不到 code（越界/老客户端上报 0）才退回按版本名比较。
     */
    const latestCode = artifact.versionCode > 0 ? artifact.versionCode : versionCodeOf(artifact.versionName);
    const available =
      latestCode > 0 && currentCode > 0
        ? latestCode > currentCode
        : compareVersionName(artifact.versionName, currentName) > 0;

    return {
      available,
      current: { versionName: currentName, versionCode: currentCode },
      latest: artifact,
      downloadPath: '/api/update/download',
      /**
       * 短期下载令牌。
       *
       * 鸿蒙/iOS 都把地址交给系统浏览器或侧签工具，那些调用方**发不出请求头**，
       * 只能靠这个令牌换鉴权；安卓原生侧自己下载时仍可用 Bearer。
       */
      downloadToken: signUpdateToken(target),
    };
  });

  app.get('/api/update/download', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const target = platform(query.platform);

    /**
     * 两条鉴权入口，满足其一即可：
     *   - `?token=`　check 签发的短期令牌 —— 给**发不出请求头**的调用方；
     *   - `Authorization: Bearer`　原生侧自己下载时走这条。
     */
    const rawToken = typeof query.token === 'string' ? query.token : undefined;
    if (!verifyUpdateToken(target, rawToken)) requireUser(req);

    if (getUpdateProxySettings().source === 'off' || config.updateSource === 'off') {
      return serviceUnavailable('更新服务已关闭', 'update_not_configured');
    }

    const file = cachedFilePath(target);
    if (!file) {
      return serviceUnavailable('更新产物尚未就绪', 'update_not_ready');
    }

    /**
     * Range 支持（断点续传）。HAP/IPA 有 40–150MB，移动网络断一次不能从 0 重下。
     *
     * 起点越界必须回 **416**，不能夹到最后一个字节 —— 夹住会让客户端把 1 字节
     * 当"续传成功"，文件静默残缺（2026-10-21 实测踩到）。
     */
    const total = file.size;
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    let start = 0;
    let end = total - 1;
    let partial = false;

    if (m && total > 0) {
      const rawStart = m[1] === '' ? null : Number(m[1]);
      const rawEnd = m[2] === '' ? null : Number(m[2]);
      if (rawStart === null && rawEnd !== null) {
        // 后缀范围：最后 N 字节
        start = Math.max(0, total - rawEnd);
      } else if (rawStart !== null) {
        if (rawStart >= total) {
          reply.code(416);
          reply.header('Content-Range', `bytes */${total}`);
          return { error: { code: 'invalid_range', message: '请求的字节范围无效' } };
        }
        start = rawStart;
        if (rawEnd !== null) end = Math.min(rawEnd, total - 1);
      }
      partial = true;
      if (start > end) {
        reply.code(416);
        reply.header('Content-Range', `bytes */${total}`);
        return { error: { code: 'invalid_range', message: '请求的字节范围无效' } };
      }
    }

    reply.header('Content-Type', PLATFORM_CONTENT_TYPE[target]);
    reply.header('Content-Disposition', `attachment; filename="${file.fileName}"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', String(end - start + 1));
    if (partial) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
    } else {
      reply.code(200);
    }

    const local = createReadStream(file.path, { start, end });
    local.on('error', () => {
      try { (reply.raw.socket ?? reply.raw).destroy(); } catch { /* client already closed */ }
    });
    reply.raw.on('close', () => {
      if (!local.destroyed) local.destroy();
    });
    return reply.send(local);
  });

  // ---- 更新通道设置（Web 管理页；只认 cookie 会话，与其它管理操作同一渠道闸） ----

  app.get('/api/admin/update-settings', async req => {
    requireWebAdmin(req);
    return {
      ...getUpdateProxySettings(),
      currentVersion: SERVER_VERSION,
      deployMode: getDeployMode(),
    };
  });

  app.get('/api/admin/server-update', async req => {
    requireWebAdmin(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const force = ['1', 'true', 'yes'].includes(String(query.force ?? '').toLowerCase());
    return checkServerUpdate(force);
  });

  app.patch('/api/admin/update-settings', async req => {
    requireWebAdmin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = getUpdateProxySettings();

    const source = body.source === 'off' ? ('off' as const) : ('github' as const);

    /**
     * **单框语义**：调用方只传 `proxyUrl` 一个字段。
     *   有值（http://…）→ 自动 kind=http
     *   空串/缺省      → 自动直连
     * 若显式传了 proxyKind 则尊重它（保留将来扩展余地），但 socks5 会被
     * saveUpdateProxySettings 的规范化直接落为 none 并拒绝地址。
     */
    const proxyUrl = typeof body.proxyUrl === 'string' ? body.proxyUrl.trim() : current.proxyUrl;
    let proxyKind: UpdateProxyKind;
    if (typeof body.proxyKind === 'string' && (body.proxyKind === 'http' || body.proxyKind === 'none')) {
      proxyKind = body.proxyKind;
    } else {
      proxyKind = proxyUrl === '' ? 'none' : 'http';
    }

    try {
      return saveUpdateProxySettings({ source, proxyKind, proxyUrl });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err), 'invalid_proxy');
    }
  });
}
