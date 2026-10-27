/**
 * 更新通道的公共类型与平台判定（与具体来源解耦）。
 *
 * 历史：这些原本长在 `ugreen-update.ts` 里。2026-10-21 用户要求「ugreen 不再使用」，
 * 来源只剩 GitHub + 关闭两种，于是把类型抽出来单独放，来源实现只保留 `github-update.ts`。
 */

/**
 * 更新通道面向的平台。产物类型按扩展名映射。
 *
 * `android` 已于 2026-10-21 封库，但枚举值保留 —— 删掉会让老客户端拿到
 * `invalid_platform`，比"已停止更新"更难懂。
 */
export type UpdatePlatform = 'android' | 'ios' | 'harmony' | 'fnos';

/** 平台 → 产物扩展名 */
export const PLATFORM_EXTENSION: Record<UpdatePlatform, string> = {
  android: 'apk',
  ios: 'ipa',
  harmony: 'hap',
  fnos: 'fpk',
};

/** 产物下载时的 MIME。-octet-stream：系统不解析、原样落盘，侧签工具按扩展名接管 */
export const PLATFORM_CONTENT_TYPE: Record<UpdatePlatform, string> = {
  android: 'application/vnd.android.package-archive',
  ios: 'application/octet-stream',
  harmony: 'application/octet-stream',
  fnos: 'application/octet-stream',
};

/** 一个已就绪的更新产物 */
export interface UpdateArtifact {
  fileName: string;
  /** 本地缓存里的绝对路径 */
  path: string;
  versionName: string;
  /** GitHub 没有 versionCode；恒为 0，路由层会退回按 versionName 比较 */
  versionCode: number;
  size: number;
  sha256: string | null;
}

export function isUpdatePlatform(value: unknown): value is UpdatePlatform {
  return value === 'android' || value === 'ios' || value === 'harmony' || value === 'fnos';
}

/** semver 比较（a>b 返回正数） */
export function compareVersionName(a: string, b: string): number {
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
