# SuenMusic

自托管音乐服务器 + Web（PC 端客户端 / 管理面板）+ 鸿蒙原生客户端 + iOS 原生客户端 + 飞牛 fnOS 套件。

## 平台矩阵

| 端 | 状态 | 说明 |
|---|---|---|
| 服务端 `server/` | ✅ 主线 | 单一真相源；多音源解析（酷狗 VIP 自动升级 / 网易云 / B 站）、三级会员熔断、CDN 直链下发、多用户、AI 推荐 |
| Web `web/` | ✅ 主线 | **PC 端唯一客户端 + 完整管理面板**（基于 Vue 3 + Vite 的高保真哑光质感 SPA） |
| 鸿蒙 `hw/` | ✅ 主线 | **全原生 ArkUI 客户端**（`pages/NativeRoot`）+ 原生 `MediaPlayerCore` + 2x2/2x4 桌面卡片（ArkTS Form）+ AVSession 播控，无 WebView |
| iOS `ios/` | ✅ 主线 | **纯原生 SwiftUI 客户端**（`ios/SuenMusic/`）+ 单一 Target 架构 + 系统原生 Now Playing（灵动岛 / 锁屏 / 控制中心 / AirPods / CarPlay 深度集成） |
| fnOS `fn/` | ✅ 主线 | 服务端 + Web + Node 22 运行时自包含打进 `.fpk`，面向飞牛应用中心一键安装与 systemd 守护运行 |
| Android `android/` | ❄️ **已封库** | 2026-10-21 起不再维护/更新/构建/分发，归档留底见 `android/README.md` |

单仓（Monorepo）管理，基于 Node 22 运行时，服务端采用零原生编译依赖（内置 `node:sqlite`）。

---

## 目录结构

```
suenmusic/
├── server/       Fastify 服务端：node:sqlite 数据库、多音源解析与熔断、直链下发、账号体系、AI 推荐
├── web/          Vue 3 + Vite 前端（PC 端客户端 + 管理面板唯一入口）
├── hw/           鸿蒙 HarmonyOS NEXT 全原生客户端（ArkTS / ArkUI）+ 桌面卡片 + 播控中心
├── ios/          iOS 纯原生客户端（SwiftUI / AVFoundation）+ 单一 App Target 工程
│   ├── SuenMusic/  SwiftUI 纯原生源码（App / Net / Player / UI）
│   └── App/        Xcode 工程外壳（App.xcodeproj，由脚本自动维护）
├── fn/           飞牛 fnOS 应用套件（fnpack 打包，产物 output/*.fpk）
├── android/      ❄️ 已封库归档（v1.5 冻结）：Capacitor 壳 + Media3 + AppWidget
├── scripts/      自动化构建与工程生成：iOS 工程生成与打包 / 鸿蒙 HAP 构建 / 令牌与图标生成 / ArkTS 门禁
└── docs/         统一文档库：memory（实施记录与根因）/ plan（架构方案）/ dev（构建与运维）
```

---

## 快速开始

```bash
# 1. 启动服务端（默认监听 0.0.0.0:3210，可通过 .env 覆盖）
cd server && npm ci && npm start

# 2. 启动 Web 前端（开发调试环境）
cd web && npm ci && npm run dev
```

> **运行前提**：
> 客户端（Web / 鸿蒙 / iOS）均需先行连接**自建 SuenMusic 服务端**。服务端是音源解析、账号体系、元数据聚合与 CDN 直链下发的单一真相源。
> 
> 数据库文件与运行数据在首次启动时自动创建（SQLite，WAL 模式）。首个注册账号自动成为管理员；注册通道在首账号落地后自动收闭，可在 Web 面板「设置 → 账号管理」中管理。

---

## 核心架构与设计规范（v2.0.0 · 2026-10-28）

### 1. 多源音质精细化与三级会员熔断
- **酷狗音乐**：
  - **非会员/未登录**：直接熔断，**零上游请求**立即转哔哩哔哩兜底（彻底消除 60s 试听与无效打点）；
  - **普通 VIP**：仅请求 128k MP3 完整版，客户端锁定为标准音质，SQ/原声置灰；
  - **概念版 SVIP**：开放 FLAC 无损、320k、128k 全码率调度（支持每日自动签到保持 VIP 状态）。
- **网易云音乐**：
  - 非 VIP 账号永不向上游打 `lossless`；动态适配 `encodeType`（MP3 / FLAC）；404 版权缺失与 301 凭证失效立即短路。
- **哔哩哔哩**：
  - UGC DASH 音频流精细分档：标准档选取 `30216`（约 64kbps），高品档选取 `30280`（约 192kbps）。

### 2. 直链播放闭环与音质切换准则
- **音质切换「下一首生效」**：用户在播放页切换音质只修改全局期望档位，绝不原地打断或重载当前在播流；
- **本地缓存绝对优先级**：鸿蒙 `fd://` 与 iOS 命中完整缓存时直接本地起播，完全绕过网络直连与音质决议；
- **端到端纯 CDN 直连**：端侧直连上游 CDN 播放（带防盗链 Headers），彻底移除服务端中间代理带宽消耗与客户端并发下载风暴。

### 3. 系统级无缝原生体验
- **鸿蒙端**：原生 `MediaPlayerCore` 驱动，AVPlayer 直连播放，支持 2x2/2x4 桌面服务卡片与系统 AVSession 播控；
- **iOS 端**：采用纯原生单一 Target 架构，彻底剥离冗余的 Live Activity 扩展，全面由 iOS 系统级 `MPNowPlayingInfoCenter` 与 `MPRemoteCommandCenter` 原生驱动。锁屏、灵动岛（原生单胶囊音浪）、控制中心、AirPods 耳机触控及 CarPlay 车机实现 100% 官方标准体验。

---

## 构建与发布命令

SuenMusic 采用单一轴单调递增版本体系（由根目录 `VERSION` 文件决定）。

```bash
# 飞牛 fnOS 套件打包
npm run fn:build                        # 产物：output/suenmusic-v<版本>.fpk

# 鸿蒙 HarmonyOS NEXT HAP 构建与静态自检
npm run hw:check                        # 鸿蒙 ArkTS 语法与门禁静态检查 (0E/4W 基线)
npm run hw:build                        # 鸿蒙 HAP 构建 → output/suenmusic-<版本>.hap

# iOS 原生客户端构建（需 macOS 编译环境）
node scripts/gen-ios-project.mjs        # 刷新生成纯原生 Xcode 工程 (project.pbxproj)
npm run ios:build                       # 开发签名 IPA → app/suenmusic-<版本>.ipa
npm run ios:unsigned                    # 未签名 IPA（侧载适用） → app/unsigned/suenmusic-<版本>.ipa

# 品牌设计与资源生成
npm run icons                           # 从 MarkBold.vue 一键生成三端各尺寸母版图标
```

---

## 权限与管理边界

- **服务端管理操作**（账号创建/封禁、AI 模型配置、音源扫码授权、系统备份与恢复）：**仅限 Web 桌面管理面板**发起（要求同源 Cookie 鉴权，Bearer Token 默认 403 阻断）；
- **移动原生端（鸿蒙 / iOS）**：仅保留播放、搜索、收藏、历史、队列、歌手/专辑浏览、修正音源、音源状态只读与多服务端配置切换。

---

## 测试套件

```bash
cd server && npm test    # 运行 db / api / cli / business / resolver / content-filter / update 全量自动化测试
```

---

## 记忆与文档索引

所有架构方案、版本决策、问题复盘与实施流水均记录在 `docs/` 目录：

- `docs/memory/MEMORY.md` —— **全库唯一事实与历史索引**
- `docs/plan/` —— 架构与功能设计方案定稿
- `docs/dev/` —— 跨平台构建、自动化发布与部署运维指南
