import { Capacitor, registerPlugin } from '@capacitor/core';

export const isAndroid = Capacitor.getPlatform() === 'android';
export const isIOS = Capacitor.getPlatform() === 'ios';

/**
 * 鸿蒙 NEXT：**不走 Capacitor** —— 那套桥在鸿蒙端不存在，`isAndroid` / `isIOS` /
 * `isNativeAudio` 在这里全是 false。鸿蒙只通过 ArkTS 注入的全局对象
 * `window.SuenHarmony` 通信，所以用"注入对象在不在"来认平台。
 */
export const isHarmony = typeof window !== 'undefined' && !!window.SuenHarmony;

/**
 * 是不是「Web 面板」——同源浏览器里的控制台（服务端自己发的前端）。
 *
 * 服务器配置类操作（账号管理、AI 模型增删改、音源扫码、数据备份）只允许
 * 从这里发起：约定见 docs/memory/2026-10-18-设置页与服务端边界.md，
 * 服务端配套 requireWebAdmin（Bearer 一律 403）。
 * 三个原生壳（安卓/iOS 的 Capacitor、鸿蒙的 bridge）都不是 Web 面板。
 */
export const isWebPanel = !isHarmony && !Capacitor.isNativePlatform();

/**
 * 原生端是否存在应用更新通道。
 *
 * 两端形态不同，这里只回答"这一端要不要检查/展示更新"：
 *   - 安卓：原生下载 APK 并拉起系统安装界面 —— 真正的一键更新
 *   - iOS：沙箱不允许应用自行安装自己，只能把 IPA 地址交给**应用外部**
 *     （重签工具 / Safari），安装动作在应用外完成
 * 具体怎么装由 stores/update.ts 按平台分流。
 */
export const isNativeUpdate = isAndroid || isIOS;

export interface AppVersion {
  versionName: string;
  versionCode: number;
}

export interface UpdatePlugin {
  getAppVersion(): Promise<AppVersion>;
  /** 安卓：下载 APK 并拉起系统安装界面 */
  downloadAndInstall(options: {
    url: string;
    accessToken: string;
    fileName: string;
    expectedVersionName?: string;
    expectedVersionCode?: number;
    expectedSha256?: string;
  }): Promise<{ status: 'installer_opened' | 'install_permission_required' }>;
  /**
   * iOS：把安装包地址交给应用外部。
   *
   * 依次尝试重签工具的 URL scheme（AltStore / SideStore），都不在则用 Safari
   * 打开下载。iOS 没有 Android 那种"应用内拉起安装器"的能力，免费签名下更是
   * 必须由重签工具完成安装 —— 所以这里返回的 `external` 是正常结果，不是失败。
   */
  openUpdate(options: { url: string }): Promise<{ status: 'opened' | 'external' }>;
}

export const SuenUpdate = registerPlugin<UpdatePlugin>('SuenUpdate');
