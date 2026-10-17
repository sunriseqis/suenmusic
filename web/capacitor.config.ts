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
/**
 * 开发期 live reload：设了 `SUEN_LIVE_URL` 就把 WebView 指到 Vite dev server。
 *
 * 为什么需要：直连逻辑只能跑在原生环境（CapacitorHttp 绕 CORS），
 * 但每改一行就 `build → cap sync → gradle → install` 要一分多钟。
 * 指到 dev server 后：改代码 → HMR 自动刷新 → 仍然是原生环境（插件都在）。
 *
 * 用法：
 *   SUEN_LIVE_URL=http://192.168.89.10:5273 npx cap sync android
 *   ./gradlew assembleDebug && adb install -r ...
 * 之后只要 `SUENMUSIC_WEB_HOST=0.0.0.0 npm run dev` 起服务即可。
 *
 * ⚠️ 这会把页面源从 `http://localhost` 变成 dev server 的地址，
 * **WebView 的 localStorage / IndexedDB 是另一套**（按 origin 隔离）。
 * 所以它只用于调 UI 与交互，验证本地数据持久化仍要用不带这个变量的正式包。
 */
const liveUrl = process.env.SUEN_LIVE_URL;

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
    // https://localhost，所有 fetch 都会被当混合内容硬拦
    // （allowMixedContent 的兼容模式只放行媒体，拦 fetch——实测踩过）。
    // 同协议后此问题消失。
    // ⚠️ 改 scheme 会清空 WebView 的 localStorage（origin 变了）。
    androidScheme: 'http',
    // live reload 时页面来自明文 http 的局域网地址，必须显式放行
    ...(liveUrl ? { url: liveUrl, cleartext: true } : {}),
  },
  plugins: {
    /**
     * 让 fetch / XMLHttpRequest 走**原生 HTTP**，而不是 WebView 的网络栈。
     *
     * 为什么需要：QQ音乐、B站这些上游**不回 Access-Control-Allow-Origin**，
     * 浏览器/WebView 里的跨域 fetch 会被 CORS 直接拦掉（实测：QQ 返回 200
     * 但没有任何 CORS 头；B站对非 bilibili 的 Origin 直接 403）。
     * 走原生后没有同源概念，且可以自定义 Referer 这类浏览器禁止脚本设置的头。
     *
     * 注意：只影响"用 fetch 取数据"。音频字节由原生播放器取（见 SuenAudioCache），
     * 那条路本来就不经过这里。
     */
    CapacitorHttp: {
      enabled: true,
    },
  },
  appId: 'com.suenmusic.app',
  appName: 'SuenMusic',
  webDir: 'dist'
};

export default config;
