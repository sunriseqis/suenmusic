# SuenMusic

自托管高保真音乐服务与多端原生客户端套件。

## 平台矩阵

| 端 | 状态 | 架构与说明 |
|---|---|---|
| 服务端 `server/` | ✅ 主线 | 单一真相源；多音源聚合解析、音质阶梯分发、智能熔断兜底、CDN 直链派发、多用户与 AI 推荐 |
| Web `web/` | ✅ 主线 | **PC 端客户端 + 管理面板**（Vue 3 + Vite，高保真哑光质感 SPA） |
| 鸿蒙 `hw/` | ✅ 主线 | **HarmonyOS NEXT 全原生客户端**（ArkTS / ArkUI，无 WebView）+ 桌面服务卡片 + AVSession 播控 |
| iOS `ios/` | ✅ 主线 | **iOS 纯原生客户端**（SwiftUI / AVFoundation）+ 单一 Target 架构 + 系统原生 Now Playing（灵动岛 / 锁屏 / 控制中心 / AirPods / CarPlay） |
| fnOS `fn/` | ✅ 主线 | 服务端 + Web + Node 22 运行时自包含打包（`.fpk`），适配飞牛应用中心 |
| Android `android/` | ❄️ 已封库 | 历史版本归档留底，不再迭代维护 |

单仓（Monorepo）管理，运行于 Node 22+ 环境，服务端内置 `node:sqlite`（无原生 C++ 编译依赖）。

---

## 快速开始

```bash
# 1. 启动服务端（默认 0.0.0.0:3210，可通过 .env 配置）
cd server && npm ci && npm start

# 2. 启动 Web 端（开发环境）
cd web && npm ci && npm run dev
```

> **注意**：
> 客户端均需连接自建 SuenMusic 服务端。首次启动自动初始化 SQLite（WAL 模式），首个注册账号自动升级为管理员。

---

## 核心设计特性

1. **多音源聚合与智能熔断**：
   - 支持多源检索与多规格音质（标准 / 高品 / 无损）阶梯式动态调度；
   - 具备上游凭证状态感知与熔断机制，凭证失效或无版权时自动平滑降级，零多余重试。
2. **端到端直链播放**：
   - 客户端直连 CDN 流媒体，跳过服务端中继带宽损耗；
   - 优先读取本地沙箱缓存，实现零网络开销秒播。
3. **音质平滑切换**：
   - 音质调整遵循「下一首生效」原则，不打断、不重载当前正在播放的音轨。
4. **原生系统级融合**：
   - 鸿蒙端支持桌面 2x2/2x4 服务卡片实时状态与深浅色联动；
   - iOS 端全面接入系统媒体中心，锁屏、灵动岛、外设耳机与车机操作自然统一。

---

## 构建命令

```bash
npm run fn:build          # 飞牛套件 → output/suenmusic-v<版本>.fpk
npm run hw:check          # 鸿蒙静态门禁检查 (0E/4W 基线)
npm run hw:build          # 鸿蒙 HAP 构建 → output/suenmusic-<版本>.hap
npm run ios:build         # iOS 开发签名 IPA → app/suenmusic-<版本>.ipa
npm run ios:unsigned      # iOS 未签名 IPA（侧载） → app/unsigned/suenmusic-<版本>.ipa
npm run icons             # 全端矢量图标资源一键重生成
cd server && npm test     # 运行服务端完整自动化测试
```

---

## 文档索引

- `docs/memory/MEMORY.md` —— 历史事实与决策索引
- `docs/plan/` —— 架构设计方案
- `docs/dev/` —— 开发、构建与部署指南
