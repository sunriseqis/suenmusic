# 2026-10-28 iOS 彻底移除 Live Activity 与 Widget Extension，全面回归系统原生

> 状态：**已落地并验证**  
> 涉及端：iOS 端 (`ios/`)、构建脚本 (`scripts/`)  
> 触发原因：用户调研决策采纳方案 B —— 彻底砍掉自定义 Live Activity 与灵动岛代码，消除锁屏双卡片与灵动岛分裂问题，大幅精简代码维护成本并缩短编译流水线耗时。

---

## 一、 核心背景与裁定

1. **问题根因**：
   - iOS 系统在 `MPNowPlayingInfoCenter` 有数据时会自动在锁屏和灵动岛渲染原生媒体控制（封面 + 振幅音浪波形 + 播放控件）；
   - 自定义 ActivityKit Live Activity 导致锁屏出现两张重叠卡片、灵动岛分裂为两截（左侧胶囊 + 右侧独立小圆点），严重造成视觉冗余与交互割裂。
2. **决策裁定**：
   - 采纳**方案 B**：彻底移除 ActivityKit 与 `SuenWidgets` 扩展，不再维护自定义 Live Activity，全面由 iOS 原生 `MPNowPlayingInfoCenter` 与 `MPRemoteCommandCenter` 承担锁屏、灵动岛、控制中心、AirPods/蓝牙耳机及 CarPlay 的原生呈现与交互。

---

## 二、 变更清单

1. **移除的文件与扩展**：
   - 删除 `ios/SuenWidgets/` 目录（包含 `PlaybackLiveActivity.swift`、`Info.plist`）。
   - 删除主工程中的 ActivityKit 管理与意图代码：
     - `ios/SuenMusic/Player/LiveActivityController.swift`
     - `ios/SuenMusic/Player/PlaybackActivity.swift`
     - `ios/SuenMusic/Player/PlaybackIntents.swift`

2. **主 App 代码精简**：
   - [ios/SuenMusic/Player/PlaybackService.swift](file:///home/suenmusic/ios/SuenMusic/Player/PlaybackService.swift)：
     - 移除 `pushActivity(force:)` 方法及其在切歌、切状态、切音质、进度回调等各处的调用；
     - 移除 `prewarm()` 中多余的残留清理逻辑 `LiveActivityController.shared.endAllStale()`；
     - 移除 ActivityKit 专用的换行预算追踪 `lastPushedLyric` 与 `lyricLagMs()`，保留页面级歌词解析。
   - [ios/SuenMusic/UI/Theme.swift](file:///home/suenmusic/ios/SuenMusic/UI/Theme.swift) & [ios/SuenMusic/UI/RootView.swift](file:///home/suenmusic/ios/SuenMusic/UI/RootView.swift)：
     - 移除为 Widget Extension 专门设置的编译条件与切主题广播 `refreshActivityForTheme()`。
   - [ios/SuenMusic/App/Info.plist](file:///home/suenmusic/ios/SuenMusic/App/Info.plist)：
     - 移除 `NSSupportsLiveActivities` 与 `NSSupportsLiveActivitiesFrequentUpdates` 权限声明。

3. **构建体系与工程文件纯原生收敛**：
   - [scripts/gen-ios-project.mjs](file:///home/suenmusic/scripts/gen-ios-project.mjs)：
     - 重构为**纯原生单一 Target（App）**工程生成器；
     - 彻底移除 `SuenWidgets` 目标、PBXContainerItemProxy、PBXTargetDependency、以及 Embed Foundation Extensions 嵌入构建阶段；
     - 统一部署版本基线为 `IPHONEOS_DEPLOYMENT_TARGET = 17.0`；
     - 重新生成 [ios/App/App.xcodeproj/project.pbxproj](file:///home/suenmusic/ios/App/App.xcodeproj/project.pbxproj)，通过 `--check` 一致性门禁校验。

---

## 三、 收益与验证

1. **界面交互纯净化**：
   - 锁屏恢复为 iOS 官方最自然干净的单层媒体播放卡片（大封面、时间拉杆、AirPlay）；
   - 灵动岛恢复为 Apple 官方单胶囊（左侧图标 + 右侧动态跳动音浪，长按展开原生控制面板），彻底告别分裂小圆点和双卡干扰。
2. **构建与维护大幅提速**：
   - 减少一个独立的 App Extension Target 构建，减少重复编译 5 个共享文件的开销；
   - 消除签名阶段针对 Widget Extension 的额外 provisioning / entitlements 处理，降低 CI 与本地打包出错概率。
