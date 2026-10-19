import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { requireUser } from '../http/require-auth.ts';
import { badGateway, badRequest, serviceUnavailable } from '../http/errors.ts';
import { config } from '../config.ts';
import {
  getLatestUpdateArtifact,
  isUpdatePlatform,
  openUpdateDownload,
  type UpdatePlatform,
} from '../services/ugreen-update.ts';
import { signUpdateToken, verifyUpdateToken } from '../utils/update-token.ts';

/**
 * 产物 MIME。
 *
 * IPA 没有注册的 MIME 类型，这里必须给 `application/octet-stream`：
 * Safari 收到它才会把文件原样落盘、交给「文件」App 或重签工具；
 * 声明成某个已知归档类型反而可能被当场解开，安装工具就拿不到 .ipa 了。
 */
const CONTENT_TYPE: Record<UpdatePlatform, string> = {
  android: 'application/vnd.android.package-archive',
  ios: 'application/octet-stream',
};

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

function updateError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (!config.updateShareId) throw serviceUnavailable('更新服务尚未配置', 'update_not_configured');
  throw badGateway(`更新源暂时不可用：${message}`, 'update_upstream_failed');
}

export function registerUpdateRoutes(app: FastifyInstance): void {
  app.get('/api/update/check', async req => {
    requireUser(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const currentName = versionName(query.version_name);
    const currentCode = versionCode(query.version_code);
    /**
     * `?force=1` 跳过 5 分钟的元数据缓存。
     *
     * 为什么需要：刚把新 APK 放进更新目录后，缓存里还是上一版，
     * 检查更新会回答「已是最新」—— 用户手点按钮时必须拿到真实现状。
     * 启动时的静默检查不带这个参数，缓存继续挡上游压力（列目录要过 UGREEN 云端握手）。
     */
    const force = ['1', 'true', 'yes'].includes(String(query.force ?? '').toLowerCase());
    const target = platform(query.platform);
    let artifact;
    try {
      artifact = await getLatestUpdateArtifact(target, force);
    } catch (err) {
      return updateError(err);
    }

    const available = artifact.versionCode > 0 && currentCode > 0
      ? artifact.versionCode > currentCode
      : compareVersionName(artifact.versionName, currentName) > 0;
    return {
      available,
      current: { versionName: currentName, versionCode: currentCode },
      latest: artifact,
      downloadPath: '/api/update/download',
      /**
       * 短期下载令牌。
       *
       * 安卓原生侧自己下载，能带 Bearer，用不上它；iOS 要把 IPA 地址交给
       * 应用外部（重签工具 `altstore://install?url=` / Safari），那两条路
       * 都发不出请求头 —— 只能靠这个令牌换鉴权。两端统一返回，省得客户端分叉。
       */
      downloadToken: signUpdateToken(target),
    };
  });

  app.get('/api/update/download', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const target = platform(query.platform);
    /**
     * 两条鉴权入口，满足其一即可：
     *   - `?token=`　check 签发的短期令牌 —— 给**发不出请求头**的调用方
     *     （iOS 的重签工具、Safari）用；
     *   - `Authorization: Bearer`　安卓原生侧自己下载时走这条。
     * 令牌本身就代表"已登录用户的这次更新授权"，有效时不必再查登录态。
     */
    const rawToken = typeof query.token === 'string' ? query.token : undefined;
    if (!verifyUpdateToken(target, rawToken)) requireUser(req);

    let result;
    try {
      result = await openUpdateDownload(target);
    } catch (err) {
      return updateError(err);
    }
    const { response, artifact } = result;
    const stream = Readable.fromWeb(response.body as any);
    reply.code(200);
    reply.header('Content-Type', CONTENT_TYPE[target]);
    reply.header('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
    reply.header('Cache-Control', 'no-store');
    if (response.headers.get('content-length')) reply.header('Content-Length', response.headers.get('content-length'));
    stream.on('error', () => {
      try { (reply.raw.socket ?? reply.raw).destroy(); } catch { /* client already closed */ }
    });
    reply.raw.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    return stream;
  });
}

function compareVersionName(a: string, b: string): number {
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}
