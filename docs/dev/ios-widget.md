# iOS 桌面卡片（WidgetKit）—— 已移除（2026-10-20）

> **状态：整个特性已删除。** 用户当日在 Xcode 里移除 Widget Extension target，
> 本仓同步清理：target 及其全部 pbxproj 引用、`ios/App/SuenMusicWidget/`
> （含共享的 `SharedNowPlaying.swift` / `PlaybackIntents.swift`）、
> `SuenAudioPlugin.swift` 里的快照发布与 intent 转发、
> `stores/lyrics.ts` 的 iOS 无条件歌词推送，全部回退到加卡片之前的状态。
>
> 本文档留档——将来若重新做 iOS 卡片，下面的接入步骤仍然有效
> （共享源码、App Group、 entitlement 接线方式不变）。

## 当时的实现（留档）

源码曾在 `ios/App/SuenMusicWidget/`：

```
SuenMusicWidget.swift        2×2 / 4×2 视图 + TimelineProvider
SharedNowPlaying.swift       App 与 Widget 共享的快照读写 + PlaybackCommand
PlaybackIntents.swift        AudioPlaybackIntent（播放/暂停/上一首/下一首）
SuenMusicWidget-Info.plist   NSExtensionPointIdentifier
SuenMusicWidget.entitlements App Group
```

数据链：

```
SuenAudioPlugin（元数据/歌词/进度）→ App Group UserDefaults + cover.jpg
  → WidgetCenter.reloadAllTimelines（20s 节流）→ Widget Provider 读取渲染
```

## 历史接入步骤（重做时参考）

1. Xcode：File → New → Target → Widget Extension，名称 `SuenMusicWidget`，
   bundle id `com.suenmusic.app.widget`，取消 Configuration App Intent / Live Activity；
2. 删模板文件，加入上述源码；`SharedNowPlaying.swift` 与 `PlaybackIntents.swift`
   **同时勾选 App 与 Widget 两个 target**；
3. 两个 target 的 Signing & Capabilities 都加 App Group
   `group.com.suenmusic.app`，Code Signing Entitlements 分别指向两个
   `.entitlements`；
4. Deployment Target 两端都 15.0。

## 历史限制（重做前知道）

- 卡片按钮是 `AudioPlaybackIntent`（iOS 17+ 可交互，15/16 只读）；
- App 被强杀后点按钮不保证从原进度继续；
- 进度是 2 秒节流的快照，WidgetKit 不做实时刷新。
