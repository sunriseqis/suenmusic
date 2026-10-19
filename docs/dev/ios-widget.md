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
   - `PlaybackIntents.swift` → **两个 target 都要勾**（App 侧才真正执行 intent）
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

## 播放控制（iOS 17+）

按钮是 `AudioPlaybackIntent`：`perform()` 在 **App 进程**执行，所以能碰到
App 里那个 AVAudioPlayer；`openAppWhenRun = false`，点了不把 App 拽到前台。

```
SuenMusicWidget.swift   Button(intent:) 渲染三键，空态 .disabled
PlaybackIntents.swift   intent 定义，dispatch 到 PlaybackCommand
SharedNowPlaying.swift  PlaybackCommand：有 handler 直接执行，
                        没有（冷启动）则写 App Group 排队
SuenAudioPlugin.load()  注册 handler + drainQueue()
```

冷启动顺序有兜底：系统为跑 intent 把 App 拉起来时，插件可能还没实例化，
命令先入队，插件 `load()` 时补执行。

**iOS 15/16 不渲染按钮**（`#available(iOS 17.0, *)`）：那个版本的
Widget 点了没有接收方，按钮只会骗人。

## 已知限制

- App 被强杀后点按钮：系统可能拉起 App，但不保证从原进度继续播放。
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
