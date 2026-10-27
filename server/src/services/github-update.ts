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

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { config } from '../config.ts';
import { getUpdateProxySettings, proxyUriSafe } from './update-settings.ts';
import { updateProxyDispatcher } from '../utils/http-agent.ts';
import { ProxyAgent } from 'undici';
import { createLogger } from '../logger.ts';

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

function compareSemver(a: string, b: string): number {
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

/** 已经缓存的产物信息（无缓存返回 null）。**不发起任何网络请求** */
export function readCachedArtifact(platform: UpdatePlatform): UpdateArtifact | null {
  try {
    const raw = readFileSync(latestJsonPath(platform), 'utf8');
    const meta = JSON.parse(raw) as UpdateArtifact;
    if (!meta || typeof meta.fileName !== 'string') return null;
    const file = join(cacheDir(platform), meta.fileName);
    if (!existsSync(file)) return null;
    // 旧缓存里 versionCode 可能是 0（当年上游不给）→ 用 versionName 现算，保证单轴比较
    const code = meta.versionCode > 0 ? meta.versionCode : versionCodeOf(meta.versionName);
    return { ...meta, versionCode: code, path: file, size: statSync(file).size };
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

/** 轮询全部平台（后台定时调用） */
export async function refreshAll(): Promise<void> {
  // 来源以 Web 设置页为准（env 只作初始缺省）
  if (getUpdateProxySettings().source === 'off' || config.updateSource === 'off') return;
  for (const platform of Object.keys(EXTENSIONS) as UpdatePlatform[]) {
    try {
      await refreshPlatform(platform);
    } catch (err) {
      log.warn(`更新检查失败（${platform}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
