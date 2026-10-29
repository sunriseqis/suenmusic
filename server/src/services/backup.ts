/**
 * 整库备份归档（`.sm`）——**全新形态**，取代旧的「收藏/黑名单 JSON 备份」。
 *
 * 一次备份 = 当前整库的一致性快照：
 *   `VACUUM INTO` 导出临时 sqlite 副本 → gzip → AES-256-GCM（口令经 scrypt 派生）
 *   → 自定义容器（带 magic / 版本 / KDF 参数 / salt / nonce）→ `*.sm`。
 *
 * ## 文件格式 v1
 *
 *   | 偏移 | 长度 | 内容                                              |
 *   |------|------|---------------------------------------------------|
 *   | 0    | 16   | magic `SUENMUSIC-BACKUP`（ASCII）                 |
 *   | 16   | 1    | 版本号（当前 1）                                   |
 *   | 17   | 4    | scrypt N（uint32 BE）                              |
 *   | 21   | 1    | scrypt r（uint8）                                  |
 *   | 22   | 1    | scrypt p（uint8）                                  |
 *   | 23   | 32   | salt                                               |
 *   | 55   | 12   | GCM nonce                                          |
 *   | 67   | n    | 密文（明文 = gzip(sqlite 字节)）                    |
 *   | 67+n | 16   | GCM auth tag                                       |
 *
 * 头部（0..67）同时作为 AAD 参与认证：改 KDF 参数或 nonce 会直接解不开，
 * 不用另外做完整性校验。**格式变更必须抬版本号**，老文件按老版本读。
 *
 * ## 为什么加密参数写进文件头
 *
 * scrypt 的 N/r/p 将来可能调高（硬件变快）。写进头里，老文件继续按老参数解，
 * 新文件按新参数写 —— 不需要"升级一次全部重加密"。
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { config } from '../config.ts';
import {
  beginRestore,
  closeDatabase,
  currentDatabasePath,
  endRestore,
  getDatabase,
  migrate,
  openDatabase,
} from '../db/index.ts';
import { deleteSetting, getSetting, setSetting } from '../db/repo/settings.ts';
import { AppError, badRequest } from '../http/errors.ts';
import { createLogger } from '../logger.ts';
import { invalidateLocalCatalogCache } from './local-catalog.ts';
import { persistedJwtSecret, rotatePersistedJwtSecret } from './jwt-secret.ts';

const log = createLogger('backup');

// ---------------------------------------------------------------------------
// 容器格式常量
// ---------------------------------------------------------------------------

/** magic：16 字节 ASCII，识别 + 快速报错（"这不是 .sm 备份"） */
const MAGIC = Buffer.from('SUENMUSIC-BACKUP', 'ascii');
/** 当前写出的版本 */
const FORMAT_VERSION = 1;
/** 读取时接受的最低/最高版本：高于本进程已知版本必须明确拒绝，而不是猜着解 */
const MIN_READ_VERSION = 1;
const MAX_READ_VERSION = 1;

/** scrypt 参数（写进文件头，读时以头为准） */
const KDF_N = 16384;
const KDF_R = 8;
const KDF_P = 1;
const KDF_MAXMEM = 64 * 1024 * 1024;

const SALT_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = MAGIC.length + 1 + 4 + 1 + 1 + SALT_LEN + NONCE_LEN; // 67

/** 本地/远端各保留最新几份 */
const KEEP_ARCHIVES = 2;

/** SQLite 文件头：恢复前必须验，避免把随便一段字节覆盖到线上库 */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** WebDAV 出网超时（上传大文件比普通 API 慢，比 upstreamTimeoutMs 宽） */
const WEBDAV_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// 设置项键名
// ---------------------------------------------------------------------------

const KEY_BACKUP_PASSWORD = 'backup.password';
const KEY_WEBDAV = 'backup.webdav';
const KEY_LAST_RUN_AT = 'backup.lastRunAt';
const KEY_LAST_RESULT = 'backup.lastResult';

/** 主密钥派生用的 info 串：与 jwt secret 绑定，不额外引入密钥文件 */
const MASTER_KEY_INFO = Buffer.from('suenmusic/backup/secrets/v1', 'utf8');

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function backupDir(): string {
  return config.backupDir;
}

function ensureBackupDir(): string {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** `suenmusic-backup-YYYYMMDD-HHmmss.sm`（**服务器本地时间**，与用户看到的文件名一致） */
export function archiveFileName(at = new Date()): string {
  return (
    'suenmusic-backup-' +
    `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-` +
    `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}.sm`
  );
}

/** 只接受"单个 .sm 文件名"，防路径穿越；下载/下载后恢复都走这里 */
export function assertSafeArchiveName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw badRequest('备份文件名不合法');
  }
  if (basename(name) !== name || name.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sm$/.test(name)) {
    throw badRequest('备份文件名不合法（只接受 *.sm）');
  }
  return name;
}

// ---------------------------------------------------------------------------
// 归档：生成 / 解出
// ---------------------------------------------------------------------------

export interface CreatedArchive {
  fileName: string;
  path: string;
  size: number;
  createdAt: number;
}

/** 口令 → 32 字节密钥。salt 每次随机，所以同一口令的两份备份密钥不同 */
function deriveArchiveKey(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, KEY_LEN, { N: n, r, p, maxmem: KDF_MAXMEM });
}

function buildHeader(salt: Buffer, nonce: Buffer, n: number, r: number, p: number): Buffer {
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 16);
  header.writeUInt32BE(n, 17);
  header.writeUInt8(r, 21);
  header.writeUInt8(p, 22);
  salt.copy(header, 23);
  nonce.copy(header, 23 + SALT_LEN);
  return header;
}

/** 把 sqlite 字节按容器格式加密成 .sm 内容（不落盘，方便单测/复用） */
export function sealArchive(sqliteBytes: Buffer, password: string): Buffer {
  if (!password) throw badRequest('备份口令不能为空');
  const gz = gzipSync(sqliteBytes, { level: 6 });
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const header = buildHeader(salt, nonce, KDF_N, KDF_R, KDF_P);

  const key = deriveArchiveKey(password, salt, KDF_N, KDF_R, KDF_P);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(gz), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

/**
 * 生成一份备份写进本地目录，并按 mtime 只保留最新 `KEEP_ARCHIVES` 份。
 *
 * 用 `VACUUM INTO` 而不是直接拷 .db：WAL 模式下直接 cp 会漏掉还没 checkpoint
 * 的数据；VACUUM INTO 让 SQLite 自己吐一个自洽单文件快照，且不锁主库的正常读写。
 */
export function createArchive(input: { password: string }): CreatedArchive {
  const password = input.password;
  if (typeof password !== 'string' || password.length === 0) {
    throw badRequest('备份口令不能为空');
  }
  const dir = ensureBackupDir();
  const tempDb = join(
    tmpdir(),
    `suenmusic-vacuum-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.db`
  );

  let sqliteBytes: Buffer;
  try {
    getDatabase().exec(`VACUUM INTO '${tempDb.replace(/'/g, "''")}'`);
    sqliteBytes = readFileSync(tempDb);
  } finally {
    try {
      unlinkSync(tempDb);
    } catch {
      /* 临时文件删不掉不影响结果 */
    }
  }

  const sealed = sealArchive(sqliteBytes, password);
  const fileName = archiveFileName();
  const path = join(dir, fileName);
  writeFileSync(path, sealed);

  const removed = rotateLocalArchives();
  if (removed.length > 0) log.info(`本地备份轮转删除：${removed.join(', ')}`);

  return { fileName, path, size: sealed.length, createdAt: Date.now() };
}

export interface ArchiveHeaderInfo {
  version: number;
  kdf: { n: number; r: number; p: number };
}

/** 只读文件头（不派生密钥），用于状态展示与"这不是备份文件"的快速判断 */
export function readArchiveHeader(buffer: Buffer): ArchiveHeaderInfo {
  if (buffer.length < HEADER_LEN + TAG_LEN) {
    throw badRequest('备份文件太小，不是有效的 .sm 归档', 'backup_too_small');
  }
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw badRequest('文件格式不正确（不是 SUENMUSIC 备份归档）', 'backup_bad_magic');
  }
  const version = buffer.readUInt8(MAGIC.length);
  if (version < MIN_READ_VERSION || version > MAX_READ_VERSION) {
    throw badRequest(
      `备份文件版本不支持（v${version}，本服务支持 v${MIN_READ_VERSION}-v${MAX_READ_VERSION}）`,
      'backup_unsupported_version'
    );
  }
  return {
    version,
    kdf: {
      n: buffer.readUInt32BE(MAGIC.length + 1),
      r: buffer.readUInt8(MAGIC.length + 5),
      p: buffer.readUInt8(MAGIC.length + 6),
    },
  };
}

/**
 * 解开一份 .sm：校验 magic/版本 → 派生密钥 → 解密 → gunzip → 校验 sqlite 头。
 *
 * 任何一步失败都抛 `AppError`（400），错误文案直接面向用户 ——
 * 管理员在恢复现场需要知道"是格式不对、口令不对，还是文件坏了"。
 */
export function extractArchive(buffer: Buffer, password: string): Buffer {
  const header = readArchiveHeader(buffer);
  if (typeof password !== 'string' || password.length === 0) {
    throw badRequest('备份口令不能为空', 'backup_password_required');
  }
  const { n, r, p } = header.kdf;
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) {
    throw badRequest('备份文件的 KDF 参数不合法（文件可能已损坏）', 'backup_bad_kdf');
  }

  const salt = buffer.subarray(MAGIC.length + 7, MAGIC.length + 7 + SALT_LEN);
  const nonce = buffer.subarray(MAGIC.length + 7 + SALT_LEN, HEADER_LEN);
  const ciphertext = buffer.subarray(HEADER_LEN, buffer.length - TAG_LEN);
  const tag = buffer.subarray(buffer.length - TAG_LEN);

  let plain: Buffer;
  try {
    const key = deriveArchiveKey(password, salt, n, r, p);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(buffer.subarray(0, HEADER_LEN));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM 认证失败 = 口令错 **或** 文件被改过。两者对用户是同一句话
    throw badRequest('密码不正确（或备份文件已损坏）', 'backup_bad_password');
  }

  let sqliteBytes: Buffer;
  try {
    sqliteBytes = gunzipSync(plain);
  } catch {
    throw badRequest('备份内容解压失败（文件可能已损坏）', 'backup_bad_gzip');
  }
  if (sqliteBytes.length < SQLITE_MAGIC.length || !sqliteBytes.subarray(0, 16).equals(SQLITE_MAGIC)) {
    throw badRequest('备份内容不是 SQLite 数据库（文件头不符）', 'backup_bad_sqlite');
  }
  return sqliteBytes;
}

// ---------------------------------------------------------------------------
// 本地目录轮转
// ---------------------------------------------------------------------------

export interface LocalArchiveFile {
  name: string;
  size: number;
  /** 修改时间（毫秒） */
  mtimeMs: number;
  createdAt: number;
}

/** 列出备份目录里的 `*.sm`，按修改时间倒序（最新在前） */
export function listLocalArchives(): LocalArchiveFile[] {
  const dir = backupDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const files: LocalArchiveFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.sm')) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      files.push({
        name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        createdAt: Math.round(st.mtimeMs),
      });
    } catch {
      /* 列目录期间被删掉：跳过 */
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return files;
}

/**
 * 只保留最新 `keep` 份（按 mtime），其余删除。
 * @returns 被删除的文件名
 */
export function rotateLocalArchives(keep = KEEP_ARCHIVES): string[] {
  const files = listLocalArchives();
  const stale = files.slice(keep);
  const removed: string[] = [];
  for (const f of stale) {
    try {
      rmSync(join(backupDir(), f.name), { force: true });
      removed.push(f.name);
    } catch (err) {
      log.warn(`删除旧备份失败（${f.name}）：${(err as Error)?.message ?? String(err)}`);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 凭据加密（服务端主密钥 = jwt secret 经 HKDF 派生的 32 字节）
// ---------------------------------------------------------------------------

/**
 * 主密钥。**不引入新密钥文件**：直接用 jwt secret（它已有持久化机制，
 * 见 services/jwt-secret.ts），经 HKDF-SHA256 派生一把专用子密钥。
 *
 * 取值顺序：**库里持久化的那把**优先，没有才退回内存里的 `config.jwtSecret`。
 * 理由见 jwt-secret.ts 的 `persistedJwtSecret()`：恢复流程会轮换密钥并落库，
 * 而显式配置 env 时重启后 `config.jwtSecret` 会变回 env 值 —— 拿它派生就会
 * 让轮换期间加密的口令在下次重启后解不开（实测踩过）。
 *
 * 每次现算不缓存：恢复流程会轮换密钥，缓存会让新旧密钥混用。
 */
function masterKey(): Buffer {
  let seed = config.jwtSecret;
  try {
    seed = persistedJwtSecret() ?? seed;
  } catch {
    /* 库暂不可用（恢复窗口）→ 退回内存值 */
  }
  const ikm = Buffer.from(seed, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.from('suenmusic', 'utf8'), MASTER_KEY_INFO, KEY_LEN));
}

/** AES-256-GCM 加密任意短串；输出 JSON（iv/tag/ct 全 base64） */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  });
}

/** 解密；主密钥换过（例如 jwt secret 轮换）或数据损坏时返回 null，由调用方给可读提示 */
export function decryptSecret(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as {
      v?: number;
      iv?: string;
      tag?: string;
      ct?: string;
    };
    if (
      !parsed ||
      typeof parsed.iv !== 'string' ||
      typeof parsed.tag !== 'string' ||
      typeof parsed.ct !== 'string'
    ) {
      return null;
    }
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 自动备份口令（加密存储；任何接口都**不回传**明文或密文）
// ---------------------------------------------------------------------------

export function setBackupPassword(password: string): void {
  setSetting(KEY_BACKUP_PASSWORD, encryptSecret(password));
}

export function hasBackupPassword(): boolean {
  const raw = getSetting(KEY_BACKUP_PASSWORD);
  return typeof raw === 'string' && raw.length > 0;
}

/**
 * 取自动备份口令明文。**只给服务端自己用**（定时任务 / 缺省口令的备份请求），
 * 绝不能出现在任何 HTTP 响应里。
 */
export function readBackupPassword(): string | null {
  const raw = getSetting(KEY_BACKUP_PASSWORD);
  if (!raw) return null;
  const plain = decryptSecret(raw);
  if (plain === null) {
    log.warn('已存的备份口令无法解密（主密钥可能已轮换），请重新设置');
    return null;
  }
  return plain;
}

export function clearBackupPassword(): void {
  deleteSetting(KEY_BACKUP_PASSWORD);
}

// ---------------------------------------------------------------------------
// WebDAV 配置
// ---------------------------------------------------------------------------

export interface WebdavSettings {
  url: string;
  username: string;
  /** 明文口令（仅服务端内部使用，不落库、不出响应） */
  password: string;
  enabled: boolean;
}

/** 对外视图：**不含口令**，只给 hasPassword */
export interface WebdavView {
  configured: boolean;
  url: string;
  username: string;
  enabled: boolean;
  hasPassword: boolean;
  lastRunAt: number | null;
  lastResult: string | null;
}

interface StoredWebdav {
  url: string;
  username: string;
  /** encryptSecret 的输出 */
  passwordEnc: string;
  enabled: boolean;
}

function readStoredWebdav(): StoredWebdav | null {
  const raw = getSetting(KEY_WEBDAV);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredWebdav>;
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      passwordEnc: typeof parsed.passwordEnc === 'string' ? parsed.passwordEnc : '',
      enabled: parsed.enabled === true,
    };
  } catch {
    log.warn('WebDAV 配置解析失败（app_settings.backup.webdav），按未配置处理');
    return null;
  }
}

export function readWebdavView(): WebdavView {
  const stored = readStoredWebdav();
  return {
    configured: !!stored && stored.url.length > 0,
    url: stored?.url ?? '',
    username: stored?.username ?? '',
    enabled: stored?.enabled ?? false,
    hasPassword: !!stored && stored.passwordEnc.length > 0,
    lastRunAt: readLastRunAt(),
    lastResult: getSetting(KEY_LAST_RESULT),
  };
}

/** 内部用：带明文口令的完整配置；口令解不开时返回 null（视为"未配置完成"） */
export function readWebdavSettings(): WebdavSettings | null {
  const stored = readStoredWebdav();
  if (!stored || !stored.url) return null;
  const password = stored.passwordEnc ? decryptSecret(stored.passwordEnc) : null;
  if (password === null) return null;
  return { url: stored.url, username: stored.username, password, enabled: stored.enabled };
}

export interface SaveWebdavInput {
  url: string;
  username: string;
  /** 留空 = 保持原口令不变（前端不回传口令，所以"不改"必须是默认语义） */
  password?: string;
  enabled: boolean;
}

export function saveWebdavSettings(input: SaveWebdavInput): WebdavView {
  const previous = readStoredWebdav();
  const url = input.url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    throw badRequest('WebDAV 地址必须以 http:// 或 https:// 开头');
  }
  const passwordEnc =
    typeof input.password === 'string' && input.password.length > 0
      ? encryptSecret(input.password)
      : (previous?.passwordEnc ?? '');

  const stored: StoredWebdav = {
    url,
    username: input.username.trim(),
    passwordEnc,
    enabled: input.enabled,
  };
  setSetting(KEY_WEBDAV, JSON.stringify(stored));
  return readWebdavView();
}

function readLastRunAt(): number | null {
  const raw = getSetting(KEY_LAST_RUN_AT);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function recordRun(at: number, result: string): void {
  try {
    setSetting(KEY_LAST_RUN_AT, String(at));
    setSetting(KEY_LAST_RESULT, result.slice(0, 500));
  } catch (err) {
    log.warn(`写入备份运行记录失败：${(err as Error)?.message ?? String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// WebDAV 客户端（服务端出网，绕开浏览器 CORS）
// ---------------------------------------------------------------------------

function basicAuthHeader(settings: WebdavSettings): string {
  return (
    'Basic ' + Buffer.from(`${settings.username}:${settings.password}`, 'utf8').toString('base64')
  );
}

function requireWebdav(): WebdavSettings {
  const settings = readWebdavSettings();
  if (!settings) {
    throw new AppError(400, 'webdav_not_configured', 'WebDAV 未配置或不完整（地址/账号/口令）');
  }
  return settings;
}

function davUrl(settings: WebdavSettings, name: string): string {
  const base = settings.url.replace(/\/+$/, '');
  return name === '' ? `${base}/` : `${base}/${encodeURIComponent(name)}`;
}

/** 状态码 + 原因 + 响应体摘要。**不吞错误**：管理员要能在界面上看到到底怎么了 */
async function describeFailure(method: string, url: string, res: Response): Promise<string> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* 读不到响应体不影响状态码 */
  }
  const reason = res.statusText || 'HTTP 错误';
  return `WebDAV ${method} ${url} 失败：HTTP ${res.status} ${reason}${body ? ` — ${body}` : ''}`;
}

async function davFetch(
  settings: WebdavSettings,
  method: string,
  url: string,
  init: { body?: string | Uint8Array; headers?: Record<string, string> } = {}
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: {
        Authorization: basicAuthHeader(settings),
        ...(init.headers ?? {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(WEBDAV_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError(
      502,
      'webdav_unreachable',
      `无法连接 WebDAV（${settings.url}）：${(err as Error)?.message ?? String(err)}`
    );
  }
}

/** 上传一个文件：PUT `{url}/{fileName}` */
export async function webdavUpload(fileName: string, buffer: Buffer): Promise<void> {
  const settings = requireWebdav();
  const name = assertSafeArchiveName(fileName);
  const url = davUrl(settings, name);
  const res = await davFetch(settings, 'PUT', url, {
    body: buffer,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) throw new AppError(502, 'webdav_upload_failed', await describeFailure('PUT', url, res));
  log.info(`WebDAV 上传成功：${name}（${buffer.length} 字节）`);
}

export interface WebdavRemoteFile {
  name: string;
  href: string;
  lastModified: number | null;
}

/** PROPFIND（Depth: 1）列出远端文件；只保留 `*.sm` 文件条目 */
export async function webdavList(): Promise<WebdavRemoteFile[]> {
  const settings = requireWebdav();
  const url = davUrl(settings, '');
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop></d:propfind>';

  const res = await davFetch(settings, 'PROPFIND', url, {
    body,
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
  });
  if (!res.ok) {
    throw new AppError(502, 'webdav_list_failed', await describeFailure('PROPFIND', url, res));
  }
  const xml = await res.text();
  return parsePropfind(xml, settings.url);
}

/** 从 207 多状态 XML 里取文件条目。不引 XML 库：DAV 的这段结构稳定且极浅 */
function parsePropfind(xml: string, baseUrl: string): WebdavRemoteFile[] {
  const files: WebdavRemoteFile[] = [];
  const blocks = xml.match(/<((?:[\w-]+:)?)response\b[\s\S]*?<\/\1response>/gi) ?? [];
  for (const block of blocks) {
    const hrefMatch = /<(?:[\w-]+:)?href>([^<]+)<\/(?:[\w-]+:)?href>/i.exec(block);
    if (!hrefMatch) continue;
    const href = hrefMatch[1].trim();
    if (!href || href.endsWith('/')) continue; // 目录本身
    const lmMatch = /<(?:[\w-]+:)?getlastmodified>([^<]+)<\/(?:[\w-]+:)?getlastmodified>/i.exec(block);
    const lm = lmMatch ? Date.parse(lmMatch[1]) : NaN;

    let decoded: string;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      decoded = href;
    }
    const name = basename(decoded.split('?')[0]);
    if (!name.endsWith('.sm')) continue;
    files.push({
      name,
      href: new URL(href, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(),
      lastModified: Number.isFinite(lm) ? lm : null,
    });
  }
  return files;
}

/** 下载指定文件：GET `{url}/{fileName}` */
export async function webdavDownload(fileName: string): Promise<Buffer> {
  const settings = requireWebdav();
  const name = assertSafeArchiveName(fileName);
  const url = davUrl(settings, name);
  const res = await davFetch(settings, 'GET', url);
  if (!res.ok) throw new AppError(502, 'webdav_download_failed', await describeFailure('GET', url, res));
  return Buffer.from(await res.arrayBuffer());
}

export async function webdavDelete(href: string): Promise<void> {
  const settings = requireWebdav();
  const res = await davFetch(settings, 'DELETE', href);
  if (!res.ok) throw new AppError(502, 'webdav_delete_failed', await describeFailure('DELETE', href, res));
}

/**
 * 远端轮转：只保留最新 `keep` 个 `*.sm`（按 getlastmodified 倒序）。
 * 删除失败只记警告 —— 保留多一份备份不是错误，不该让整次备份失败。
 */
export async function rotateWebdavArchives(keep = KEEP_ARCHIVES): Promise<string[]> {
  const files = await webdavList();
  files.sort(
    (a, b) =>
      (b.lastModified ?? 0) - (a.lastModified ?? 0) || b.name.localeCompare(a.name)
  );
  const removed: string[] = [];
  for (const f of files.slice(keep)) {
    try {
      await webdavDelete(f.href);
      removed.push(f.name);
    } catch (err) {
      log.warn(`远端旧备份删除失败（${f.name}）：${(err as Error)?.message ?? String(err)}`);
    }
  }
  if (removed.length > 0) log.info(`远端备份轮转删除：${removed.join(', ')}`);
  return removed;
}

// ---------------------------------------------------------------------------
// 生成 + 上传（手动 / 定时共用的同一条路径）
// ---------------------------------------------------------------------------

export interface UploadResult {
  fileName: string;
  size: number;
  remoteRemoved: string[];
  lastRunAt: number;
}

export async function createAndUpload(password: string): Promise<UploadResult> {
  const archive = createArchive({ password });
  await webdavUpload(archive.fileName, readFileSync(archive.path));
  const remoteRemoved = await rotateWebdavArchives();
  const lastRunAt = Date.now();
  recordRun(lastRunAt, `成功：${archive.fileName}（${archive.size} 字节），远端轮转删除 ${remoteRemoved.length} 个`);
  return { fileName: archive.fileName, size: archive.size, remoteRemoved, lastRunAt };
}

// ---------------------------------------------------------------------------
// 整库恢复
// ---------------------------------------------------------------------------

export interface RestoreResult {
  restored: true;
  requiresRelogin: true;
  backupPath: string;
  schemaVersion: number | null;
}

/**
 * **整库覆盖**恢复。
 *
 * 步骤（与旧 `/api/admin/db/restore` 同源，多两步：解归档 + 让登录态失效）：
 *   1. 解归档（口令错在这里就报"密码不正确"，此时**一个字节都没动**）
 *   2. 临时连接上验 integrity_check + 必需表（防止把坏库覆盖上去）
 *   3. 当前库 VACUUM INTO 一份 `.pre-restore-<ts>.db` 兜底（**保留，不自动删**）
 *   4. 关连接 → 换文件 → 重开 → 补迁移 → quick_check，失败自动回滚
 *   5. 吊销所有刷新令牌 + 全体 token_epoch+1 + 轮换 jwt secret → 所有登录态失效
 *
 * 为什么第 5 步是三件事一起做：访问令牌是无状态 JWT（靠 jwt secret 失效），
 * Web 面板走的是 **cookie 里的刷新令牌**（靠库里的行失效），两者都堵才叫"全部下线"。
 */
export function restoreWholeDb(buffer: Buffer, password: string): RestoreResult {
  // 1) 解归档
  const sqliteBytes = extractArchive(buffer, password);

  const dbPath = currentDatabasePath();
  const uploadPath = `${dbPath}.sm-restore.tmp`;
  writeFileSync(uploadPath, sqliteBytes);

  // 2) 完整性与表结构校验（临时连接，不动正在服务的库）
  const requiredTables = ['users', 'schema_migrations'];
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(uploadPath);
    const check = probe.prepare('PRAGMA integrity_check').get() as
      | { integrity_check: string }
      | undefined;
    if (!check || check.integrity_check !== 'ok') {
      throw badRequest(`备份数据库完整性检查未通过：${check?.integrity_check ?? '无结果'}`);
    }
    const tables = (
      probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map(r => r.name);
    for (const t of requiredTables) {
      if (!tables.includes(t)) throw badRequest(`备份数据库缺少必需表：${t}`);
    }
  } catch (err) {
    try {
      rmSync(uploadPath, { force: true });
    } catch {
      /* ignore */
    }
    if (err instanceof AppError) throw err;
    throw badRequest(`备份数据库无法打开：${(err as Error)?.message ?? String(err)}`);
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }

  // 3) 当前库兜底（保留，不删）
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
      `备份当前数据库失败，已中止恢复：${(err as Error)?.message ?? String(err)}`
    );
  }

  /**
   * 轮换 jwt secret 会让"用旧密钥加密"的备份口令 / WebDAV 口令解不开，
   * 所以恢复前先取出这两份明文，换完密钥再按新密钥写回。
   * （读的是**恢复前**的库，写的是**恢复后**的库 —— 保留的是本机当前配置。）
   */
  const preservedBackupPassword = safeCall(() => readBackupPassword());
  const preservedWebdav = safeCall(() => readWebdavSettings());

  // 4) 热替换（beginRestore 挡住恢复窗口内的 getDatabase，详见 db/index.ts）
  beginRestore();
  try {
    closeDatabase();
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    renameSync(uploadPath, dbPath);
    const reopened = openDatabase();
    migrate(reopened);
    const check = reopened.prepare('PRAGMA quick_check').get() as
      | { quick_check?: string }
      | undefined;
    const verdict = check?.quick_check ?? 'unknown';
    if (verdict !== 'ok') throw new Error(`恢复后的数据库自检未通过：${verdict}`);

    // 5) 让所有登录态失效（库内部分：吊销刷新令牌 + 抬 epoch）
    const revoked = reopened
      .prepare('UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL')
      .run(Date.now());
    reopened.exec('UPDATE users SET token_epoch = token_epoch + 1');
    log.warn(
      `数据库已恢复；已吊销 ${Number(revoked.changes)} 个刷新令牌并使全部访问令牌失效（token_epoch +1）`
    );
  } catch (err) {
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
      log.error(
        `恢复失败且回滚失败，请手动用 ${backupPath} 覆盖 ${dbPath}：${
          (rollbackErr as Error)?.message ?? String(rollbackErr)
        }`
      );
    }
    try {
      rmSync(uploadPath, { force: true });
    } catch {
      /* ignore */
    }
    endRestore();
    throw new AppError(
      500,
      rolledBack ? 'restore_failed' : 'restore_failed_rollback_failed',
      rolledBack
        ? `恢复失败，已自动回滚到原数据库：${(err as Error)?.message ?? String(err)}`
        : `恢复失败且回滚失败，请手动用 ${backupPath} 覆盖 ${dbPath} 后重启服务`
    );
  }
  endRestore();

  // 6) 轮换持久化 jwt secret（签名侧失效；与 applyPersistedJwtSecret 同一把键）
  try {
    rotatePersistedJwtSecret();
  } catch (err) {
    log.warn(`轮换 jwt secret 失败（旧访问令牌会在过期前继续可用）：${(err as Error)?.message ?? String(err)}`);
  }

  // 7) 用新密钥把口令重新加密写回（否则定时备份会因为"解不开口令"而静默失效）
  try {
    if (preservedBackupPassword) setBackupPassword(preservedBackupPassword);
    if (preservedWebdav) {
      saveWebdavSettings({
        url: preservedWebdav.url,
        username: preservedWebdav.username,
        password: preservedWebdav.password,
        enabled: preservedWebdav.enabled,
      });
    }
  } catch (err) {
    log.warn(`恢复后重写 WebDAV/备份口令失败：${(err as Error)?.message ?? String(err)}`);
  }

  invalidateLocalCatalogCache();

  let schemaVersion: number | null = null;
  try {
    const row = getDatabase()
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number | null } | undefined;
    schemaVersion = row?.v ?? null;
  } catch {
    /* 统计失败不影响恢复结论 */
  }

  return { restored: true, requiresRelogin: true, backupPath, schemaVersion };
}

function safeCall<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 定时自动备份
// ---------------------------------------------------------------------------

let autoRunning = false;

export interface ScheduledBackupOutcome {
  ran: boolean;
  /** 跳过原因（ran=false 时有值） */
  skipped?: string;
  /** 给日志/状态面板看的一行结果 */
  result: string;
}

/**
 * 每天定时跑的那一次：WebDAV 已配置 + enabled + 已存口令，三者缺一即跳过。
 *
 * 并发保护：上一轮没跑完就重入会同时 VACUUM + PUT 两份大文件，
 * 在 NAS 上够把磁盘写满一次。`autoRunning` 直接挡住。
 */
export async function runScheduledBackup(): Promise<ScheduledBackupOutcome> {
  if (autoRunning) {
    return { ran: false, skipped: '上一轮自动备份仍在执行', result: 'skipped' };
  }
  autoRunning = true;
  try {
    const settings = readWebdavSettings();
    let reason = '';
    if (!settings || !settings.url) reason = 'WebDAV 未配置';
    else if (!settings.enabled) reason = 'WebDAV 自动备份未启用（enabled=false）';
    else if (!readBackupPassword()) reason = '未设置自动备份口令';

    if (reason) {
      log.warn(`自动备份跳过：${reason}`);
      recordRun(Date.now(), `跳过：${reason}`);
      return { ran: false, skipped: reason, result: `跳过：${reason}` };
    }

    const password = readBackupPassword();
    if (!password) {
      // 理论上上面已拦；这里只是让类型收敛
      const msg = '未设置自动备份口令';
      recordRun(Date.now(), `跳过：${msg}`);
      return { ran: false, skipped: msg, result: `跳过：${msg}` };
    }

    const uploaded = await createAndUpload(password);
    const result = `成功：${uploaded.fileName}（${uploaded.size} 字节），远端轮转删除 ${uploaded.remoteRemoved.length} 个`;
    log.info(`自动备份完成：${result}`);
    return { ran: true, result };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    const result = `失败：${message}`;
    log.error(`自动备份失败：${message}`);
    recordRun(Date.now(), result);
    return { ran: true, result };
  } finally {
    autoRunning = false;
  }
}

/** 供运维/测试观察：是否有一轮自动备份正在跑 */
export function isAutoBackupRunning(): boolean {
  return autoRunning;
}

/** 备份目录是否可写（status 接口用它提前暴露权限问题） */
export function backupDirReady(): boolean {
  try {
    const dir = ensureBackupDir();
    return existsSync(dir);
  } catch {
    return false;
  }
}
