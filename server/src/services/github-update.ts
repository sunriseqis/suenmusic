/**
 * 更新产物来源：GitHub Releases（**拉回本地缓存**，客户端只从本服务端下载）。
 *
 * 为什么要缓存而不是让客户端直连 GitHub：
 *   ① 国内访问 `objects.githubusercontent.com` 极不稳定；
 *   ② 客户端（尤其鸿蒙走系统浏览器/侧签工具）发不出鉴权头，直连 GitHub 私有仓库更不可能；
 *   ③ 缓存到本地后 `download` 能支持 Range/断点续传，弱网断线不用重下整包。
 *
 * 约定（CI 侧无需改动，与现有产物命名一致）：
 *   · Release tag：`hw-v1.6.0`（其它平台用 `v1.6.0`，本模块按"tag 里最后一个 semver"解析）
 *   · Asset 名：`SuenMusic-v1.6.0-release.hap` / `.ipa` / `.apk`
 *   · 版本比较：**按 semver 比 versionName**（GitHub 没有 versionCode；
 *     `UpdateArtifact.versionCode` 固定回 0，路由层会自动退回名称比较）
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { config } from '../config.ts';
import { getUpdateProxySettings, proxyUriSafe } from './update-settings.ts';
import { updateProxyDispatcher } from '../utils/http-agent.ts';
import { ProxyAgent } from 'undici';
import { createLogger } from '../logger.ts';
import { SERVER_VERSION } from '../app.ts';
import { getDeployMode, type DeployMode } from './deploy-mode.ts';
import { signUpdateToken } from '../utils/update-token.ts';

const log = createLogger('update');
import {
  PLATFORM_EXTENSION,
  type UpdateArtifact,
  type UpdatePlatform,
} from './update-types.ts';

/** API 基地址可配（国内反代）；产物下载走 `updateGithubProxy`，两者互不覆盖 */
/** API 基地址：Web 设置页优先，其次环境变量，最后官方地址 */
const apiBase = (): string => {
  // API 基地址只来自环境变量（国内反代是部署层决策）；出站代理走 Web 设置
  return (config.updateGithubApiBase || 'https://api.github.com').replace(/\/+$/, '');
};
const PER_PAGE = 20;
/** asset 后缀 → 平台 */
const EXTENSIONS = PLATFORM_EXTENSION;

interface GithubAsset {
  name?: string;
  size?: number;
  browser_download_url?: string;
  /** 新版 API 会带 `sha256:<hex>`；没有则留空 */
  digest?: string | null;
}

interface GithubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  assets?: GithubAsset[];
}

/**
 * 发行产物命名（用户 2026-10-24 裁定）：`suenmusic-<版本>.<ext>`，**同版本永远覆盖同名文件**。
 * 例：`suenmusic-1.6.0.hap` / `suenmusic-1.6.0.ipa` / `suenmusic-1.6.0.fpk`。
 * 版本号只由仓库根 `VERSION` 决定，改版本才换名。
 */
/**
 * versionName → versionCode（与客户端/CI 同一公式，2026-10-24 用户裁定）：
 *     major*1_000_000 + minor*10_000 + patch*100
 * 服务端不再依赖上游给的 code（GitHub 恒 0），一律自己推导 → 单一比较轴。
 * 越界（如 minor ≥ 100）时回落 0，路由层再退回按版本名比较兜底。
 */
export function versionCodeOf(versionName: string): number {
  const parts = versionName.split('.').map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  if (![major, minor, patch].every(Number.isInteger)) return 0;
  if (minor >= 100 || patch >= 100) return 0;
  const code = major * 1000000 + minor * 10000 + patch * 100;
  return code > 0 && code <= 2147483647 ? code : 0;
}

function artifactName(versionName: string, platform: UpdatePlatform): string {
  return `suenmusic-${versionName}.${EXTENSIONS[platform]}`;
}

/** tag → semver。接受 `hw-v1.6.0` / `v1.6.0` / `1.6.0`，取最后一个 semver 片段 */
function versionFromTag(tag: string): string | null {
  const m = /(\d+(?:\.\d+)+)$/.exec(tag.trim());
  return m ? m[1] : null;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export function cacheDir(platform: UpdatePlatform): string {
  return resolve(config.updateCacheDir, platform);
}

function latestJsonPath(platform: UpdatePlatform): string {
  return join(cacheDir(platform), 'latest.json');
}

/**
 * 未完成下载的 `*.part` 保留时长。
 *
 * 下载器不支持跨进程续传，所以超过这个时间的 `.part` 一定是**残留**
 * （进程被杀 / 断网 / 磁盘满），留着只会占盘 —— 一个 hap 就上百 MB。
 */
const STALE_PART_MS = 60 * 60 * 1000;

/**
 * 清理下载残留（`*.part`）。正在写的不动（mtime 很新），只清超过 1 小时的。
 *
 * 服务启动时与每次 `refreshPlatform` 开头各调一次：前者防长期积压，
 * 后者保证一个平台的残留不会被另一个平台的轮询漏掉。
 */
export function pruneStaleParts(platform: UpdatePlatform): void {
  let names: string[];
  try {
    names = readdirSync(cacheDir(platform));
  } catch {
    return; // 目录还不存在 = 没有残留
  }
  const dir = cacheDir(platform);
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.part')) continue;
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (now - st.mtimeMs < STALE_PART_MS) continue;
      rmSync(file, { force: true });
      log.info('清理下载残留：' + platform + '/' + name + '（' + Math.max(1, Math.round(st.size / 1024)) + ' KB）');
    } catch {
      /* 并发被清掉 / 权限不足：都不该影响主流程 */
    }
  }
}

/** 全部平台的 `*.part` 残留清理（服务启动时调一次） */
export function pruneAllStaleParts(): void {
  for (const p of Object.keys(EXTENSIONS) as UpdatePlatform[]) pruneStaleParts(p);
}

/**
 * 已经缓存的产物信息（无缓存返回 null）。**不发起任何网络请求**。
 *
 * 只认「**已完整落盘**」的包 —— 客户端拿到 available=true 就去下载/安装，
 * 半个包比没有包更坏。三条校验：
 *   · `latest.json` 里的 path 文件必须真实存在（可能被手删 / 被清理带走）；
 *   · `size` 必须 > 0；
 *   · `size` 必须与实际文件大小一致（磁盘满 / 被截断）。
 * 任一不满足即视为**没有包**（不是报错：客户端显示「已是最新」），并顺手清掉 `.part` 残留。
 *
 * 「没下完」天然被排除：下载中写的是 `<name>.part`，`latest.json` 只在 rename 成功后才写。
 */
export function readCachedArtifact(platform: UpdatePlatform): UpdateArtifact | null {
  try {
    const raw = readFileSync(latestJsonPath(platform), 'utf8');
    const meta = JSON.parse(raw) as UpdateArtifact;
    if (!meta || typeof meta.fileName !== 'string' || meta.fileName === '') return null;

    const file = typeof meta.path === 'string' && meta.path !== '' ? meta.path : join(cacheDir(platform), meta.fileName);
    const declared = Number(meta.size);
    if (!existsSync(file) || !Number.isFinite(declared) || declared <= 0) {
      pruneStaleParts(platform);
      return null;
    }
    const size = statSync(file).size;
    if (size <= 0 || size !== declared) {
      log.warn('缓存包大小不符，视为没有包：' + platform + '/' + meta.fileName + '（声明 ' + declared + '，实际 ' + size + '）');
      pruneStaleParts(platform);
      return null;
    }

    // 旧缓存里 versionCode 可能是 0（当年上游不给）→ 用 versionName 现算，保证单轴比较
    const code = meta.versionCode > 0 ? meta.versionCode : versionCodeOf(meta.versionName);
    return { ...meta, versionCode: code, path: file, size };
  } catch {
    return null;
  }
}

/** 下载用的本地文件（供路由层做 Range 流式发送） */
export function cachedFilePath(platform: UpdatePlatform): { path: string; fileName: string; size: number } | null {
  const artifact = readCachedArtifact(platform);
  if (!artifact) return null;
  return { path: artifact.path, fileName: artifact.fileName, size: artifact.size };
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'suenmusic-server',
  };
  if (config.updateGithubToken) headers.Authorization = `Bearer ${config.updateGithubToken}`;
  return headers;
}

/** 资产下载地址：可套一层国内代理前缀（只影响下载，不影响 API） */
/**
 * 出站代理 dispatcher（HTTP / SOCKS5）。
 *
 * 与旧版"URL 前缀镜像"的本质区别：这是**真正的网络层代理**——
 * 所有 GitHub 流量（API + 产物下载）都经由代理服务器出去，
 * 对 GitHub 而言请求方是代理出口；URL 原样不变，没有任何第三方转写。
 */
function proxyDispatcher(): ProxyAgent | undefined {
  const uri = proxyUriSafe(getUpdateProxySettings());
  return uri ? updateProxyDispatcher(uri) : undefined;
}

async function listReleases(): Promise<GithubRelease[]> {
  if (!config.updateGithubRepo) throw new Error('未配置 SUENMUSIC_UPDATE_GITHUB_REPO');
  const res = await fetch(`${apiBase()}/repos/${config.updateGithubRepo}/releases?per_page=${PER_PAGE}`, {
    headers: githubHeaders(),
    dispatcher: proxyDispatcher(),
  } as never);
  if (res.status === 404) {
    // 2026-10-24：仓库**没有 Release**、或仓库是**私有**（未配 token）时 GitHub 都回 404。
    // 按产品口径「有没有更新由后端管理」：这种情况一律当**无包**处理（返回空列表），
    // 让 /api/update/check 正常回 available=false（客户端显示「已是最新」），而不是 502 报错。
    log.warn('GitHub Releases 404（无 Release 或私有仓库未配 token），按无包处理');
    return [];
  }
  if (!res.ok) {
    throw new Error(`GitHub Releases 查询失败：HTTP ${res.status}`);
  }
  const list = (await res.json()) as GithubRelease[];
  return list.filter(r => !r.draft && Array.isArray(r.assets));
}

function isAssetMatch(assetName: string, versionName: string, platform: UpdatePlatform): boolean {
  const ext = EXTENSIONS[platform];
  const name = assetName.toLowerCase();
  const v = versionName.toLowerCase();
  const candidates = [
    `suenmusic-${v}.${ext}`,
    `suenmusic-v${v}.${ext}`,
    `suenmusic-${v}-release.${ext}`,
    `suenmusic-v${v}-release.${ext}`,
  ];
  return candidates.includes(name);
}

/** 在 release 列表里找该平台**版本最高**的产物 */
function pickAsset(
  releases: GithubRelease[],
  platform: UpdatePlatform
): { versionName: string; asset: GithubAsset; publishedAt: string | null } | null {
  let best: { versionName: string; asset: GithubAsset; publishedAt: string | null } | null = null;
  for (const release of releases) {
    const versionName = versionFromTag(release.tag_name ?? '');
    if (!versionName) continue;
    const asset = (release.assets ?? []).find(
      a => typeof a.name === 'string' && isAssetMatch(a.name, versionName, platform)
    );
    if (!asset || typeof asset.browser_download_url !== 'string') continue;
    if (!best || compareSemver(versionName, best.versionName) > 0) {
      best = { versionName, asset, publishedAt: release.published_at ?? null };
    }
  }
  return best;
}

/** 只保留当前版本的文件，删掉历史产物（缓存目录不会无限涨） */
async function pruneOldFiles(platform: UpdatePlatform, keep: string): Promise<void> {
  const dir = cacheDir(platform);
  try {
    for (const name of await readdir(dir)) {
      if (name === keep || name === 'latest.json') continue;
      if (!/^(?:suenmusic|SuenMusic)-.+\.(hap|ipa|apk|fpk)$/i.test(name)) continue;
      rmSync(join(dir, name), { force: true });
    }
  } catch (err) {
    log.warn(`更新缓存清理失败（${platform}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 检查并在需要时把最新产物拉到本地。
 *
 * @param force true = 忽略"已是最新"的短路，强制重新核对（用户手点检查更新时用）
 * @returns 最新产物（无可用产物返回 null）
 */
export async function refreshPlatform(
  platform: UpdatePlatform,
  force = false
): Promise<UpdateArtifact | null> {
  pruneStaleParts(platform);
  const cached = readCachedArtifact(platform);
  const releases = await listReleases();
  const picked = pickAsset(releases, platform);
  if (!picked) {
    log.warn(`GitHub 上没有 ${platform} 的 release 产物（期望 ${artifactName('<版本>', platform)}）`);
    return cached;
  }

  if (!force && cached && compareSemver(cached.versionName, picked.versionName) >= 0) {
    return cached;
  }

  const fileName = artifactName(picked.versionName, platform);
  const dir = cacheDir(platform);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, fileName);
  const temp = `${target}.part`;

  const res = await fetch(picked.asset.browser_download_url!, {
    headers: githubHeaders(),
    dispatcher: proxyDispatcher(),
  } as never);
  if (!res.ok || !res.body) {
    throw new Error(`产物下载失败：HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(temp));

  const size = statSync(temp).size;
  if (typeof picked.asset.size === 'number' && picked.asset.size > 0 && size !== picked.asset.size) {
    rmSync(temp, { force: true });
    throw new Error(`产物大小不符：期望 ${picked.asset.size}，实际 ${size}`);
  }

  renameSync(temp, target);
  await pruneOldFiles(platform, fileName);

  const digest = typeof picked.asset.digest === 'string' ? picked.asset.digest : '';
  const artifact: UpdateArtifact = {
    fileName,
    path: target,
    versionName: picked.versionName,
    // 上游不提供 versionCode（GitHub 恒 0）→ 用 versionName 按统一公式推导
    versionCode: versionCodeOf(picked.versionName),
    size,
    sha256: digest.startsWith('sha256:') ? digest.slice(7) : null,
  };
  writeFileSync(latestJsonPath(platform), JSON.stringify(artifact, null, 2), 'utf8');
  log.info(`更新产物已缓存：${platform} v${artifact.versionName}（${Math.round(size / 1024 / 1024)} MB）`);
  return artifact;
}

export function pickLatestReleaseVersion(releases: GithubRelease[]): string | null {
  let best: string | null = null;
  for (const release of releases) {
    const v = versionFromTag(release.tag_name ?? '');
    if (!v) continue;
    if (!best || compareSemver(v, best) > 0) {
      best = v;
    }
  }
  return best;
}

export interface ServerUpdateResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  deployMode: DeployMode;
  artifact: {
    fileName: string;
    size: number;
    downloadToken: string;
    downloadPath: string;
  } | null;
}

let cachedDockerLatestVersion: { version: string; checkedAt: number } | null = null;

/**
 * 检查服务端/套件自身更新：
 * - fnOS 原生套件部署：自动拉取并缓存 .fpk，返回下载信息供用户覆盖安装；
 * - Docker 部署：仅比对最新镜像版本，提示用户手动拉取最新镜像，不下载 .fpk。
 */
export async function checkServerUpdate(force = false): Promise<ServerUpdateResult> {
  const mode = getDeployMode();

  if (mode === 'fnos') {
    let artifact = readCachedArtifact('fnos');
    if (force || !artifact) {
      try {
        artifact = await refreshPlatform('fnos', force);
      } catch (err) {
        log.warn(`检查飞牛套件更新失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const latestVersion = artifact ? artifact.versionName : SERVER_VERSION;
    const available = artifact ? compareSemver(artifact.versionName, SERVER_VERSION) > 0 : false;
    return {
      available,
      currentVersion: SERVER_VERSION,
      latestVersion,
      deployMode: 'fnos',
      artifact: available && artifact ? {
        fileName: artifact.fileName,
        size: artifact.size,
        downloadToken: signUpdateToken('fnos'),
        downloadPath: '/api/update/download',
      } : null,
    };
  }

  // Docker 部署逻辑：只比对 GitHub Releases 上的最新标签版本，不拉取 .fpk 产物
  let latestVersion = SERVER_VERSION;
  if (!force && cachedDockerLatestVersion && (Date.now() - cachedDockerLatestVersion.checkedAt < 10 * 60 * 1000)) {
    latestVersion = cachedDockerLatestVersion.version;
  } else {
    try {
      const releases = await listReleases();
      const picked = pickLatestReleaseVersion(releases);
      if (picked) {
        latestVersion = picked;
        cachedDockerLatestVersion = { version: picked, checkedAt: Date.now() };
      }
    } catch (err) {
      log.warn(`检查 Docker 镜像更新失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const available = compareSemver(latestVersion, SERVER_VERSION) > 0;
  return {
    available,
    currentVersion: SERVER_VERSION,
    latestVersion,
    deployMode: 'docker',
    artifact: null,
  };
}

/** 轮询全部平台（后台定时调用） */
export async function refreshAll(): Promise<void> {
  // 来源以 Web 设置页为准（env 只作初始缺省）
  if (getUpdateProxySettings().source === 'off' || config.updateSource === 'off') return;
  const mode = getDeployMode();
  // 飞牛原生套件才拉取 .fpk；Docker 部署不拉取 .fpk，只拉取移动双端 (.hap / .ipa)
  const platforms: UpdatePlatform[] = mode === 'fnos'
    ? ['harmony', 'ios', 'fnos']
    : ['harmony', 'ios'];

  for (const platform of platforms) {
    try {
      await refreshPlatform(platform);
    } catch (err) {
      log.warn(`更新检查失败（${platform}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Docker 模式下定时刷新版本号缓存
  if (mode === 'docker') {
    try {
      const releases = await listReleases();
      const picked = pickLatestReleaseVersion(releases);
      if (picked) {
        cachedDockerLatestVersion = { version: picked, checkedAt: Date.now() };
      }
    } catch {
      /* ignore */
    }
  }
}
