# iOS 构建与发布（单仓）

适用布局：`web/`、`ios/`、`server/`、`android/`、`hw/` 同在 `suenmusic` 单仓内。
**所有路径均为仓内相对路径**，不依赖任何本地目录结构，CI 可直接照搬。

## 环境

- macOS + Xcode（含 iphoneos SDK）
- node（本仓库成员走 nvm；注意非交互 shell 的 PATH 里可能没有 node，
  构建请在交互式终端执行）

## 一条命令跑完整链路

```bash
node scripts/build-ios.mjs            # web 构建 → cap sync → vendor 还原 → xcodebuild → 签名 IPA
node scripts/build-ios.mjs --sync-only  # 只做到"Web 产物同步进 iOS 工程"（进 Xcode 前跑）
node scripts/build-ios.mjs --unsigned   # 不签名，产出 app/unsigned/ 下的 IPA（交重签工具）
```

> 注意：脚本头部虽写着 `npm run ios:*`，但仓库根没有 package.json，
> 实际请用上面的 `node scripts/build-ios.mjs` 形式（见 plan/2026-10-19-iOS-config-xml残留引用.md）。

## 手工分步（排查问题时用）

```bash
# 1) 构建 web 产物（必须在 web/ 目录，vue-tsc + vite）
cd web && npm run build && cd ..

# 2) 同步进 iOS 工程（必须站在 web/ 跑！capacitor.config.ts 在这里，
#    ios.path: '../ios' 才会解析到 ios/App）
cd web && npx cap sync ios && cd ..

# 3) 还原本地 vendor 依赖（cap sync 刚把 Package.swift 改回远程 GitHub 依赖）
bash scripts/fix-ios-vendor.sh

# 4) 编译（与脚本同款参数；SYMROOT 可改）
xcodebuild -project ios/App/App.xcodeproj -target App -configuration Release \
  -sdk iphoneos SYMROOT=ios/App/build \
  MARKETING_VERSION=1.5 CURRENT_PROJECT_VERSION=20001 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
```

## 必须知道的口径

1. **`cap sync ios` 必须站在 `web/` 跑。** 站在仓库根或 `ios/` 跑都不会同步对地方
   （站在根目录跑会因找不到 webDir 报 "Could not find the web assets directory"）。
2. **`cap sync` 之后必须跟 `bash scripts/fix-ios-vendor.sh`。** 否则 SPM 去连
   GitHub Releases 拉 xcframework，直连大概率超时。
3. **iOS 生成物三件套**（均被 `ios/.gitignore` 排除，不随仓库分发）：
   - `ios/App/App/capacitor.config.json`（sync 写入）
   - `ios/App/App/public/`（web/dist 拷入）
   - `ios/App/App/config.xml`（Cordova 存根，**Capacitor 8 不再生成**，属已知坑，
     处置方案见 plan 文档）
4. **版本号**：`MARKETING_VERSION` 取自仓库根 `VERSION` 文件，必须与它一致——
   服务端 iOS 更新判定走版本名比较，不一致则更新通道失效。
   `CURRENT_PROJECT_VERSION = 20000 + git 提交数`（与安卓同源）。
5. **`IPHONEOS_DEPLOYMENT_TARGET` 保持 15.0**（App 与 `SuenMusicWidget` 两个
   target 都是）。Xcode 的 "Update to recommended settings" 会把它抬到当前
   SDK 大版本（曾出现 26.0），产物随即只能在 iOS 26+ 安装、旧 Xcode 也无法构建。
   详见 `docs/memory/2026-10-19-部署目标被抬到26.0.md`。
6. **IPA 命名**必须是 `SuenMusic-v<版本>-release.ipa`，服务端按
   `^SuenMusic-v(\d+)-release\.ipa$` 挑包，改名字它认不出来。
6. **上传是手动的**：把 IPA 放到 NAS 的 `release/` 目录，App 的更新检查才看得到。

## CI 注意事项

- CI 里先 `cd web && npm ci`（会重建 `node_modules/.bin`；本地环境曾出现
  `.bin` 为空导致 `npm run build` 报 `command not found`，本地修复同样是
  `cd web && npm install`，修完确认 `package-lock.json` 无改动）。
- **禁止**在脚本、配置、文档里写本地绝对路径或 `../` 跨仓相对路径——
  单仓之后这类引用全部失效，CI 必挂。
