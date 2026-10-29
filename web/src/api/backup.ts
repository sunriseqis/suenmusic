/**
 * 整库加密备份 / 恢复（管理员）。
 *
 * 契约唯一来源：`server/src/routes/backup.ts`。全部端点走 `requireWebAdmin`
 * （同源 cookie 会话；写请求的 `X-Requested-With` 由 `api/client.ts` 统一补）。
 *
 * 口令只上行：**没有任何响应回传口令**，状态里只有 `hasPassword` 布尔。
 * 浏览器不再直连 WebDAV：那条路撞 CORS，浏览器端的 WebDAV 模块已整体删除。
 */
import { http, requestBlob } from './client.ts';

export interface LocalBackupFile {
  name: string;
  size: number;
  /** 修改时间（毫秒） */
  mtimeMs: number;
  createdAt: number;
}

/** 服务端对外视图，不含口令 */
export interface WebdavView {
  configured: boolean;
  url: string;
  username: string;
  enabled: boolean;
  hasPassword: boolean;
  lastRunAt: number | null;
  lastResult: string | null;
}

export interface BackupStatus {
  localDir: string;
  localDirReady?: boolean;
  localFiles: LocalBackupFile[];
  webdav: WebdavView;
  hasPassword: boolean;
}

export interface RestoreResponse {
  ok: true;
  source: 'upload' | 'webdav';
  fileName?: string;
  restored: true;
  requiresRelogin: true;
  backupPath: string;
  schemaVersion: number | null;
  message?: string;
}

export interface LocalBackupCreated {
  ok: true;
  fileName: string;
  size: number;
  createdAt: number;
  localDir: string;
  kept: number;
}

export interface WebdavUploadResult {
  ok: true;
  fileName: string;
  size: number;
  remoteRemoved: string[];
  lastRunAt: number;
}

/** 恢复要解归档 + 整库换文件：默认 20s 不够，且超时后换路径重放会把整库恢复做两遍 */
const RESTORE_OPTS = { timeoutMs: 180_000, noFailover: true };
/** 上传/生成同样要压缩整库，比普通请求慢 */
const ARCHIVE_OPTS = { timeoutMs: 120_000 };

export function fetchBackupStatus(): Promise<BackupStatus> {
  return http.get<BackupStatus>('/api/admin/backup/status');
}

/** 设定或更换备份口令（服务端最少 4 个字符） */
export function setBackupPassword(password: string): Promise<{ ok: true; hasPassword: boolean }> {
  return http.put<{ ok: true; hasPassword: boolean }>('/api/admin/backup/password', { password });
}

/** 生成一份本地备份；不传口令时服务端用已保存的备份口令 */
export function createLocalBackup(password?: string): Promise<LocalBackupCreated> {
  return http.post<LocalBackupCreated>('/api/admin/backup/local', password ? { password } : {}, ARCHIVE_OPTS);
}

export function downloadLocalBackup(name: string): Promise<Blob> {
  return requestBlob(`/api/admin/backup/local/${encodeURIComponent(name)}`);
}

/** 只保留最新 2 份 */
export function rotateLocalBackups(): Promise<{
  ok: true;
  removed: string[];
  kept: LocalBackupFile[];
}> {
  return http.post('/api/admin/backup/local/rotate', {});
}

/** 保存 WebDAV 配置；`password` 留空 = 保持原口令不变 */
export function saveWebdavConfig(input: {
  url: string;
  username: string;
  password?: string;
  enabled: boolean;
}): Promise<{ ok: true; webdav: WebdavView }> {
  const body: Record<string, unknown> = {
    url: input.url,
    username: input.username,
    enabled: input.enabled,
  };
  if (input.password) body.password = input.password;
  return http.post<{ ok: true; webdav: WebdavView }>('/api/admin/backup/webdav/config', body);
}

/** 生成并上传，随后服务端做远端轮转（只留最新 2 个 `*.sm`） */
export function uploadWebdavBackup(password?: string): Promise<WebdavUploadResult> {
  return http.post<WebdavUploadResult>(
    '/api/admin/backup/webdav/upload',
    password ? { password } : {},
    ARCHIVE_OPTS
  );
}

/**
 * 远端 WebDAV 上的备份文件条目。
 *
 * 字段**照抄**服务端 `webdavList()` 的返回（PROPFIND 只请求了 getlastmodified，
 * 服务端没有 content-length，所以这里同样没有 size）。
 */
export interface WebdavRemoteFile {
  name: string;
  href: string;
  /** getlastmodified（毫秒）；服务端没给就是 null */
  lastModified: number | null;
}

/** 列出远端 `*.sm` 备份（最新在前）。未配置 WebDAV 时服务端回 400 */
export function fetchWebdavFiles(): Promise<{ files: WebdavRemoteFile[] }> {
  return http.get<{ files: WebdavRemoteFile[] }>('/api/admin/backup/webdav/list');
}

/** 从 WebDAV 拉取指定文件并**整库恢复**（成功后所有登录态失效） */
export function pullWebdavBackup(fileName: string, password?: string): Promise<RestoreResponse> {
  const body: Record<string, unknown> = { fileName };
  if (password) body.password = password;
  return http.post<RestoreResponse>('/api/admin/backup/webdav/pull', body, RESTORE_OPTS);
}

/** 上传一份 `.sm` 并整库恢复；`dataBase64` 是文件原文的 base64 */
export function restoreFromBase64(dataBase64: string, password?: string): Promise<RestoreResponse> {
  const body: Record<string, unknown> = { dataBase64 };
  if (password) body.password = password;
  return http.post<RestoreResponse>('/api/admin/backup/restore', body, RESTORE_OPTS);
}
