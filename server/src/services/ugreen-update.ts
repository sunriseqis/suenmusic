import { config } from '../config.ts';
import { request, requestJson, type UpstreamError } from '../utils/http.ts';

const META_CACHE_MS = 5 * 60 * 1000;
// 收集链接面向任何持有者，子目录数量不可控；只扫前若干个，避免被刷目录拖垮更新检查。
const MAX_SUBDIRS = 20;
// UGREEN 的「路径不存在」错误码。用于区分良性竞态与真实故障。
const PATH_NOT_EXIST_CODE = 1365;

/** 更新通道面向的平台。产物类型、大小上限、缓存都按它分流 */
export type UpdatePlatform = 'android' | 'ios';

/**
 * 产物命名规则。`SuenMusic` 前缀与 `-release` 后缀是必须的：
 * 更新目录里还混着调试包，名字对不上的一律不认。
 */
const ARTIFACT_PATTERNS: Record<UpdatePlatform, RegExp> = {
  android: /^SuenMusic-v(\d+(?:\.\d+)*)-release\.apk$/i,
  ios: /^SuenMusic-v(\d+(?:\.\d+)*)-release\.ipa$/i,
};

/** 产物大小上限：IPA 里装着多架构二进制，比 APK 大一截 */
const MAX_ARTIFACT_BYTES: Record<UpdatePlatform, number> = {
  android: 100 * 1024 * 1024,
  ios: 200 * 1024 * 1024,
};

/** 日志/报错里用的产物简称 */
const ARTIFACT_LABEL: Record<UpdatePlatform, string> = {
  android: 'APK',
  ios: 'IPA',
};

export function isUpdatePlatform(value: unknown): value is UpdatePlatform {
  return value === 'android' || value === 'ios';
}

type UgreenEnvelope<T> = { code?: number; msg?: string; data?: T };
interface ShareFile {
  path?: string;
  name?: string;
  size?: number;
  file_type?: number;
}
interface FileListData {
  files?: ShareFile[];
}
interface VerifyData {
  status?: number;
  file_info?: ShareFile[];
}
interface AddPathData {
  result?: string;
}

/** 目录列举失败。保留上游错误码，便于把「目录不存在」这类良性竞态与真实故障分开。 */
class UgreenListError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'UgreenListError';
    this.code = code;
  }
}

export interface UpdateArtifact {
  fileName: string;
  path: string;
  versionName: string;
  versionCode: number;
  size: number;
  sha256: string | null;
}

let shareCookie = '';
let verifyPromise: Promise<string> | null = null;
/** 元数据缓存分平台：两级产物各自列目录，互不覆盖 */
const cached: Partial<Record<UpdatePlatform, { artifact: UpdateArtifact; expiresAt: number }>> = {};

function configured(): void {
  if (!config.updateShareId) throw new Error('更新服务未配置分享 ID');
}

function apiUrl(path: string): string {
  return `${config.updateUgreenBaseUrl.replace(/\/+$/, '')}${path}`;
}

function shareReferer(): string {
  const u = new URL(config.updateUgreenBaseUrl);
  return `${u.origin}/filemgr/share-download/?id=${encodeURIComponent(config.updateShareId)}`;
}

function headers(cookie = shareCookie): Record<string, string> {
  const result: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: new URL(config.updateUgreenBaseUrl).origin,
    Referer: shareReferer(),
    'UG-Agent': 'PC/WEB',
    'X-Specify-Language': 'zh-CN',
  };
  if (cookie) result.Cookie = cookie;
  return result;
}

async function readEnvelope<T>(res: Response): Promise<UgreenEnvelope<T>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`UGREEN HTTP ${res.status}`);
  try {
    return JSON.parse(text) as UgreenEnvelope<T>;
  } catch {
    throw new Error('UGREEN 返回了非法 JSON');
  }
}

function cookieFromResponse(res: Response): string {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const values = h.getSetCookie?.() ?? [];
  const value = values.find(v => v.startsWith('share_cookie_')) ?? '';
  return value.split(';', 1)[0] ?? '';
}

async function verifyShare(): Promise<string> {
  configured();
  if (shareCookie) return shareCookie;
  if (verifyPromise) return verifyPromise;
  verifyPromise = (async () => {
    const res = await request(apiUrl('/filemgr/externalVerifySharePassword'), {
      method: 'POST',
      headers: headers(''),
      body: { share_id: config.updateShareId, password: '', no_count: false },
      timeoutMs: 10_000,
      retries: 1,
    });
    const envelope = await readEnvelope<VerifyData>(res);
    if (envelope.code !== 200 || envelope.data?.status !== 0) {
      throw new Error(`UGREEN 分享验证失败：${envelope.msg ?? '未知错误'}`);
    }
    const cookie = cookieFromResponse(res);
    if (!cookie) throw new Error('UGREEN 分享验证未返回访问凭据');
    shareCookie = cookie;
    return cookie;
  })();
  try {
    return await verifyPromise;
  } finally {
    verifyPromise = null;
  }
}

function parseVersion(name: string, platform: UpdatePlatform): string | null {
  const match = ARTIFACT_PATTERNS[platform].exec(name);
  return match?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
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

async function listFiles(cookie: string, path: string): Promise<ShareFile[]> {
  const res = await request(apiUrl('/filemgr/getShearDirFileList'), {
    method: 'POST',
    headers: headers(cookie),
    body: {
      share_id: config.updateShareId,
      password: '',
      path,
      page: 1,
      limit: 1000,
      sort_type: 1,
      as_dir: false,
      reverse: false,
      file_exts: [],
    },
    timeoutMs: 10_000,
    retries: 1,
  });
  const envelope = await readEnvelope<FileListData>(res);
  if (envelope.code !== 200 || !envelope.data?.files) {
    // 错误码进消息体：路由层只透出 message，出问题时得能从日志直接看到上游码。
    throw new UgreenListError(
      `UGREEN 文件列表失败(${envelope.code ?? '?'})：${envelope.msg ?? '未知错误'}`,
      envelope.code ?? 0
    );
  }
  return envelope.data.files;
}

async function listFilesWithRetry(path: string): Promise<ShareFile[]> {
  try {
    return await listFiles(await verifyShare(), path);
  } catch (err) {
    // 访问凭据可能已过期：清掉重验一次，仍失败才把最初的错误抛出去。
    shareCookie = '';
    try {
      return await listFiles(await verifyShare(), path);
    } catch {
      throw err;
    }
  }
}

/**
 * 汇总根目录与一级子目录中的全部 release 产物（按平台过滤）。
 *
 * 收集链接上传的产物**必然**落在以上传者命名的子目录里（UGREEN 收集功能的固有行为，
 * 实测无法上传到根目录），所以只扫根目录会漏掉 CI 直传的包。这里把一级子目录一并纳入。
 *
 * 子目录列举失败只在「目录已不存在」时才跳过（两次调用之间被删属良性竞态）；
 * 其余错误一律上抛 —— 更新链路绝不能把故障静默降级成「已是最新版本」。
 */
async function collectCandidates(
  platform: UpdatePlatform
): Promise<Array<{ file: ShareFile; versionName: string }>> {
  const root = await listFilesWithRetry(config.updateSharePath);
  const dirs = root
    .filter(dir => dir.file_type === 1 && typeof dir.name === 'string')
    .slice(0, MAX_SUBDIRS);
  // 用 allSettled 而不是 Promise.all：先收齐所有结果再决定抛哪个错，
  // 避免被 Promise.all 提前 reject 后其余请求变成未处理的 rejection。
  const settled = await Promise.allSettled(
    dirs.map(dir => listFilesWithRetry(dir.path ?? `${config.updateSharePath.replace(/\/$/, '')}/${dir.name}`))
  );
  const all: ShareFile[] = [...root];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
      continue;
    }
    if (result.reason instanceof UgreenListError && result.reason.code === PATH_NOT_EXIST_CODE) continue;
    throw result.reason;
  }
  return all
    .filter(file => file.file_type === 0 && typeof file.name === 'string' && parseVersion(file.name, platform))
    .map(file => ({ file, versionName: parseVersion(file.name!, platform)! }))
    .sort((a, b) => compareVersions(b.versionName, a.versionName));
}

export async function getLatestUpdateArtifact(
  platform: UpdatePlatform = 'android',
  force = false
): Promise<UpdateArtifact> {
  configured();
  const hit = cached[platform];
  if (!force && hit && hit.expiresAt > Date.now()) return hit.artifact;

  const candidates = await collectCandidates(platform);
  if (candidates.length === 0) {
    throw new Error(`更新目录中没有有效的 SuenMusic release ${ARTIFACT_LABEL[platform]}`);
  }

  const selected = candidates[0]!;
  const fileName = selected.file.name!;
  const path = selected.file.path ?? `${config.updateSharePath.replace(/\/$/, '')}/${fileName}`;
  if (selected.file.size && selected.file.size > MAX_ARTIFACT_BYTES[platform]) {
    throw new Error(`更新 ${ARTIFACT_LABEL[platform]} 超过允许大小`);
  }
  const artifact: UpdateArtifact = {
    fileName,
    path,
    versionName: selected.versionName,
    // versionCode 只有安卓侧能从文件名之外注入（见 config.updateVersionCode）。
    // iOS 用 CFBundleVersion，与 versionName 同源，拿 0 让路由层退回版本名比较。
    versionCode: platform === 'android' ? config.updateVersionCode : 0,
    size: Number(selected.file.size ?? 0),
    sha256: platform === 'android' ? config.updateSha256 || null : null,
  };
  cached[platform] = { artifact, expiresAt: Date.now() + META_CACHE_MS };
  return artifact;
}

export function clearUpdateCache(): void {
  for (const key of Object.keys(cached) as UpdatePlatform[]) delete cached[key];
  shareCookie = '';
}

export async function openUpdateDownload(
  platform: UpdatePlatform = 'android'
): Promise<{ response: Response; artifact: UpdateArtifact }> {
  const artifact = await getLatestUpdateArtifact(platform, true);
  const add = await requestJson<UgreenEnvelope<AddPathData>>(apiUrl('/filemgr/addPathsByShareId'), {
    method: 'POST',
    headers: headers(),
    body: { paths: [artifact.path], share_id: config.updateShareId },
    timeoutMs: 10_000,
    retries: 1,
  });
  if (add.code !== 200 || !add.data?.result) throw new Error(`UGREEN 下载任务创建失败：${add.msg ?? '未知错误'}`);

  const response = await request(
    apiUrl('/filemgr/shareDownloadFile'),
    {
      query: {
        coding: 'true',
        share_id: config.updateShareId,
        password: '',
        task_id: add.data.result,
      },
      headers: { Accept: acceptHeader(platform), Cookie: shareCookie },
      timeoutMs: 30_000,
      retries: 0,
      stream: true,
    }
  );
  if (!response.ok || !response.body) {
    throw new Error(`UGREEN ${ARTIFACT_LABEL[platform]} 下载失败：HTTP ${response.status}`);
  }
  return { response, artifact };
}

/**
 * 下游 `Accept` 头。上游只是把磁盘文件流出来，这个头不影响取到什么，
 * 但保持一致便于在 UGREEN 侧日志里分辨请求来源。
 */
function acceptHeader(platform: UpdatePlatform): string {
  return platform === 'android' ? 'application/vnd.android.package-archive' : 'application/octet-stream';
}
