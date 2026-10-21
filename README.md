# SuenMusic

自托管音乐服务器 + Web（PC 端客户端 / 管理面板）+ 鸿蒙原生客户端 + iOS 原生客户端 + fnOS 套件。

## 平台矩阵

| 端 | 状态 | 说明 |
|---|---|---|
| 服务端 `server/` | ✅ 主线 | 单一真相源；音源解析、流代理、多用户、AI 推荐 |
| Web `web/` | ✅ 主线 | **PC 端唯一客户端 + 管理面板**（同一份 SPA） |
| 鸿蒙 `hw/` | ✅ 主线 | ArkUI 原生客户端（`pages/NativeRoot`），无 WebView |
| iOS `ios/SuenMusic/` | 🚧 重做中 | SwiftUI 原生，代码已就位（S0），**待 Xcode 环境验证** |
| iOS `ios/App/` | ⚠️ 旧壳 | Capacitor 壳，待 S1 通过后删除 |
| Android `android/` | ❄️ **已封库** | 2026-10-21 起不再更新/构建/分发/上架，见 `android/README.md` |
| fnOS `fn/` | ✅ 主线 | 服务端 + Web 打进 `.fpk`，面向飞牛应用中心 |
单仓（monorepo），Node 22 起步，无原生编译依赖的服务端（`node:sqlite`）。

## 结构

```
server/    Fastify 服务端：node:sqlite 数据库、账号体系、流媒体代理、AI 接口
web/       Vue 3 + Vite 前端（各端共用同一份 SPA）
android/   ❄️ 已封库（v1.5 归档，不再更新）：Capacitor 壳 + media3 + AppWidget
ios/       ios/SuenMusic = SwiftUI 原生客户端（重做中）；ios/App = 旧 Capacitor 壳（待删）
hw/        鸿蒙 ArkUI 原生客户端 + 桌面卡片（ArkTS Form）
fn/        飞牛 fnOS 应用套件（fnpack 打包，产物 output/*.fpk）
scripts/   构建与生成：fpk 打包 / iOS 构建 / 鸿蒙 HAP / 令牌与图标生成 / ArkTS 静态自检
docs/      memory（实施记录）/ plan（计划与设计定稿）/ dev（构建指南）
```

## 快速开始

```bash
# 服务端
cd server && npm ci && npm start        # 默认 0.0.0.0:3210，可用 .env 覆盖

# Web 开发
cd web && npm ci && npm run dev
```

数据库文件与运行数据在首次启动时自动创建（SQLite，WAL 模式）。
首个注册账号自动成为管理员；注册通道在首账号落地后自动收闭，
可在 Web 面板「设置 → 账号管理」重新打开。

## 构建产物

```bash
npm run fn:build                        # fnOS 套件 → output/suenmusic-v<version>.fpk
cd android && ./gradlew assembleDebug   # APK（版本由 VERSION_NAME/VERSION_CODE 传入）
npm run hw:sync                         # web/dist → 鸿蒙 rawfile（DevEco 再编译）
npm run ios:build                       # iOS（需 macOS + Xcode）
npm run icons                           # 从 MarkBold.vue 重生成全端图标
```

产物一律落在本地 `output/`（正式）与 `output/test/`（测试），**不入库**。

> fnOS 套件的安装布局、启停/守护行为、密钥与数据库落点，以及**命令行运维必须显式
> 指定 `SUENMUSIC_DB`** 这个坑，见 `docs/dev/fnos-ops.md`。

## 服务器配置类操作的边界

账号管理、AI 模型增删改与分配、音源扫码授权、数据库备份/恢复等
「服务器配置」操作**只接受 Web 面板**发起的同源 cookie 会话
（Bearer 令牌一律 403）；三个原生壳的设置页不渲染这些区块。
客户端保留的是播放 / 搜索 / 收藏 / 历史 / 歌单 / 画像 / 调优 /
音源只读状态 / 多服务端列表。详见
`docs/memory/2026-10-18-设置页与服务端边界.md`。

## 测试

```bash
cd server && npm test    # db / api / cli / business / plaza / resolver 全套件
```

## 品牌标识

实心折角 S（`web/src/components/brand/MarkBold.vue`，段 0 染琥珀）+
Gunstop 字体字标。改字形只改 MarkBold.vue 后重跑 `npm run icons`；
各端图标与启动图由 `scripts/gen-brand-icons.py` 一键重生。

## 文档

`docs/` 下三类：

- `memory/` —— 每次实施/排障/决策的记录（含踩坑与根因）
- `plan/` —— 计划与设计定稿（桌面卡片、账号体系、架构方案等）
- `dev/` —— 构建与运维指南（iOS 构建、iOS 卡片留档、live-reload、fnOS 套件运维）
