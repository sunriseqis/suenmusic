import { http } from './client.ts';

/** 更新通道面向的平台。安卓下发 APK，iOS 下发 IPA（见 server 侧 ugreen-update.ts） */
export type UpdatePlatform = 'android' | 'ios';

export interface UpdateArtifact {
  fileName: string;
  path: string;
  versionName: string;
  versionCode: number;
  size: number;
  sha256: string | null;
}

export interface UpdateCheckResult {
  available: boolean;
  current: { versionName: string; versionCode: number };
  latest: UpdateArtifact;
  /** 下载端点的相对路径：还要拼上 `platform` 与 `token` 才是可用的绝对地址 */
  downloadPath: string;
  /**
   * 短期下载令牌（30 分钟）。
   *
   * 安卓侧自己下载能带 Bearer，用不上；iOS 要把 IPA 地址交给应用外部
   * （重签工具 `altstore://install?url=` / Safari），那两条路都发不出请求头，
   * 只能靠这个令牌换鉴权。
   */
  downloadToken: string;
}

/**
 * 查更新。
 *
 * @param opts.platform 不传时服务端按安卓处理 —— 与老客户端的行为保持一致。
 * @param opts.force 跳过服务端 5 分钟元数据缓存、强制重新列一次更新目录。
 *   用户手点「检查更新」必须为 true —— 否则刚上传的新包会被缓存里的旧版本挡住，
 *   表现为「上传了新版却提示已是最新」。启动时的静默检查用 false 即可，
 *   让它继续起到挡上游压力的作用。
 */
export function checkUpdate(
  version: { versionName: string; versionCode: number },
  opts: { force?: boolean; platform?: UpdatePlatform } = {}
): Promise<UpdateCheckResult> {
  return http.get('/api/update/check', {
    query: {
      version_name: version.versionName,
      version_code: version.versionCode,
      platform: opts.platform,
      force: opts.force ? 1 : undefined,
    },
    timeoutMs: 20_000,
  });
}
