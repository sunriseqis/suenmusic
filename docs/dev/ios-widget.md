# iOS 桌面卡片（WidgetKit）接入

> 源码已经写好，**Xcode target 需要手动加一次**：本机是 Linux，没有 Xcode，
> 手改 `project.pbxproj` 无法验证，容易把工程写坏。加 target 是一次性的。

## 已经准备好的文件

```
ios/App/SuenMusicWidget/
  SuenMusicWidget.swift            2×2 / 4×2 视图 + TimelineProvider
  SharedNowPlaying.swift           App 与 Widget 共享的快照读写
  SuenMusicWidget-Info.plist       NSExtensionPointIdentifier
  SuenMusicWidget.entitlements     App Group

ios/App/App/
  App.entitlements                 App Group
  SuenAudioPlugin.swift            已接入：元数据 / 歌词 / 进度写入共享区
  Info.plist                       已注册 suenmusic:// URL scheme
```

## Xcode 里要做的

1. 打开 `ios/App/App.xcodeproj`。
2. **File → New → Target → Widget Extension**
   - Product Name：`SuenMusicWidget`
   - Bundle Identifier：`com.suenmusic.app.widget`
   - 取消勾选 "Include Configuration App Intent"（我们用 StaticConfiguration）
   - 取消勾选 "Include Live Activity"（如出现）
3. 删除模板生成的 `SuenMusicWidget.swift` / `Info.plist` / `Assets`，
   把本仓 `ios/App/SuenMusicWidget/` 下的四个文件加入工程。
4. **Target Membership**
   - `SuenMusicWidget.swift` → Widget target
   - `SharedNowPlaying.swift` → **App 与 Widget 两个 target 都要勾**
   - `SuenMusicWidget-Info.plist` → Build Settings 的 `INFOPLIST_FILE`
     指向 `SuenMusicWidget/SuenMusicWidget-Info.plist`
5. **Signing & Capabilities**
   - App target：+ App Groups → `group.com.suenmusic.app`
   - Widget target：同样勾 `group.com.suenmusic.app`
   - Code Signing Entitlements 分别指向 `App/App.entitlements` 与
     `SuenMusicWidget/SuenMusicWidget.entitlements`
6. Deployment Target 两个 target 都设 15.0（Widget 视图对 17 的
   `containerBackground` 做了可用性判断）。
7. 运行 App → 播放一首歌 → 回桌面长按 → 添加「SuenMusic · 正在播放」。

## 数据链路

```
SuenAudioPlugin
  updateNowPlaying / setLyricTimeline / 进度心跳
        ↓ 写 App Group UserDefaults + cover.jpg
SharedNowPlaying
        ↓ WidgetCenter.reloadAllTimelines（20 秒节流）
Widget 的 Provider 读取快照 → 渲染
```

## 已知限制

- **卡片是只读的**：iOS 第三方 Widget 不能控制 App 里的 AVAudioPlayer，
  点卡片只打开 App。传输键留在 App 内。
- 进度是最近一次写入的快照（2 秒节流），WidgetKit 本身不做实时刷新。
- 歌词时间轴只有在 App 播放时才会写；没播放过时显示「暂无歌词」。
- 封面下载失败时保留上一张 / 显示占位音符。

## 排查

| 现象 | 检查 |
|---|---|
| 卡片一直「暂无歌曲播放」 | 两个 target 的 App Group 是否一致；签名是否带 capability |
| 有歌名没封面 | `cover.jpg` 是否在共享容器；封面 URL 是否允许 ATS |
| 没有歌词 | 是否在 iOS 上推过 `setLyricTimeline`（Web 已改成 iOS 无条件推送） |
| 点击卡片没反应 | App 的 URL scheme `suenmusic` 是否注册 |
