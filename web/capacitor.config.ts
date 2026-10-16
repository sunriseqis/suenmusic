import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 2026-10-16 起改为**单仓**布局（原先拆成 suenmusic-server / suenmusic-mobile
 * 两个同级仓库，path 是跨仓相对路径）。现在路径是仓内相对：
 *
 *   suenmusic/            ← 本仓
 *   ├── web/              ← 本文件所在，前端源码
 *   ├── server/           ← 服务端
 *   ├── android/          ← 安卓壳工程
 *   ├── ios/              ← iOS 壳工程
 *   ├── hw/               ← 鸿蒙壳工程
 *   └── fn/               ← 飞牛 fpk
 *
 * 好处：`npx cap sync` 不再依赖「两个仓必须检出在同一级目录」这个前提。
 */
const config: CapacitorConfig = {
  android: {
    allowMixedContent: true,
    path: '../android',
  },
  ios: {
    // ⚠️ 不配这一项时 CLI 会按默认值去找 `web/ios`（不存在），
    //    于是 `cap sync ios` 直接报"找不到 iOS 工程"。
    path: '../ios',
    // scheme 默认就是 `App`，与 Xcode target 名一致，无需覆盖。
  },
  server: {
    // ⚠️ 安卓侧的 scheme 配置键是 server.androidScheme（android.scheme 是 iOS 的）。
    // 页面源用 http：API 服务器是明文 http（局域网/Tailscale），若页面是
    // https://localhost，所有 fetch 都会被当混合内容硬拦（allowMixedContent
    // 的兼容模式只放行媒体，拦 fetch——实测踩过）。同协议后此问题消失。
    // ⚠️ 改 scheme 会清空 WebView 的 localStorage（origin 变了）。
    androidScheme: 'http',
  },
  appId: 'com.suenmusic.app',
  appName: 'SuenMusic',
  webDir: 'dist'
};

export default config;
