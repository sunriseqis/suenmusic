# hw/ —— HarmonyOS NEXT (鸿蒙纯血) 全原生客户端工程

本目录是 **SuenMusic 鸿蒙全原生工程**（基于 HarmonyOS NEXT / OpenHarmony API 11/12+ Stage 模型，100% 采用 ArkTS / ArkUI 纯原生渲染，零 WebView 依赖）。

## 架构定位

- **纯原生 UI**：基于 ArkUI 声明式范式重构，主页面入口为 `pages/NativeRoot`，无任何 Web 容器与混合桥接；
- **原生音频播放核心**：基于系统 `@ohos.multimedia.media` 的 `AVPlayer` 构建 `MediaPlayerCore`，支持直连 CDN 流、音质动态切换、本地 `fd://` 零拷贝极速起播；
- **桌面服务卡片**：支持 ArkTS Form 架构的 2x2 与 2x4 桌面常驻服务卡片，实时展示曲目、封面、歌词进度与交互式播控；
- **系统 AVSession 播控**：集成鸿蒙系统播控中心（控制中心、锁屏播控、蓝牙外设联动）。

---

## 目录结构

```
hw/
├── build-profile.json5         # 工程级构建配置（API 11/12 Stage 模型）
├── hvigorfile.ts               # Hvigor 构建系统入口
├── oh-package.json5            # 工程级依赖清单
├── AppScope/                   # 全局元数据（包名 com.suenmusic.app、图标、版本号）
└── entry/                      # 主应用模块 (HAP)
    └── src/main/
        ├── module.json5        # 权限声明（INTERNET、KEEP_BACKGROUND_RUNNING、audioPlayback）
        ├── resources/          # 原生资源目录（基础色板、矢量图标、音质 SVG、多语言）
        └── ets/
            ├── entryability/
            │   └── EntryAbility.ets   # 应用入口生命周期、沉浸式窗口与深浅主题初始化
            ├── core/
            │   ├── MediaPlayerCore.ets # 原生播放引擎核心（AVPlayer / 直连 CDN / 缓存 / 熔断）
            │   ├── APIClient.ets       # RESTful API 客户端（单例 / 超时熔断 / 令牌自动续签）
            │   └── Models.ets          # 数据模型 + 音质档位常量（QUALITY_LEVELS / normalizeQuality，唯一真源）
            ├── pages/
            │   ├── NativeRoot.ets      # 根路由与底部 Tab 容器（无过度切页动效，瞬时切换）
            │   ├── PlayerPage.ets      # 完整沉浸式播放页（封面光晕/歌词 Sheet/音质切换弹层）
            │   ├── HomePage.ets        # 发现主页（AI 专属歌单/每日推荐/新碟上架）
            │   ├── SearchPage.ets      # 多源聚合搜索页
            │   ├── FavoritesPage.ets   # 收藏列表页
            │   └── SettingsPage.ets    # 设置与多服务器管理页
            ├── form/                   # 桌面服务卡片组件与 FormExtensionAbility
            └── common/                 # 品牌主题 Tokens、自绘弹窗、图标、工具类
```

---

## 核心技术与踩坑沉淀

1. **纯 CDN 直连流与音质切换**：
   - 使用 `media.createMediaSourceWithUrl(direct.url, direct.headers)` 直连上游 CDN（携带防盗链 Referer 等 Header），彻底绕过服务端中间代理带宽；
   - 音质切换严格遵守「下一首生效」准则，用户在播放页切换音质只修改全局期望，绝不原地打断正在播放的媒体流；
   - 本地缓存绝对优先：当 `fd://` 本地沙箱缓存命中时，绕过网络与音质决议，直接秒播。

2. **静态门禁检查 (0E/4W 基线)**：
   - 鸿蒙工程设置有严格的 ArkTS 静态语法门禁脚本（`scripts/check-arkts.mjs`）；
   - 代码提交前需确保通过 `npm run hw:check`（维持 0 Error / 4 Warnings 的基线，禁止产生任何新 warning）。

3. **桌面卡片深浅色同步**：
   - 桌面服务卡片由系统的 FormRender 进程绘制，无法直接借用 App 内存中的动态色；
   - 通过在卡片推送 payload 中注入 `suen_dark`，配合色板字面量转换与 `AVSessionManager.refreshCard()` 广播，确保卡片与 App 主题精准对齐。

---

## 开发与构建

```bash
# 1. 静态语法门禁自检
npm run hw:check

# 2. 命令行打包未签名 HAP（产物：output/suenmusic-<版本>.hap）
npm run hw:build

# 3. DevEco Studio 导入与调试
# 直接在 DevEco Studio 中打开 hw/ 目录，连接 HarmonyOS NEXT 模拟器或真机即可运行调试。
```
