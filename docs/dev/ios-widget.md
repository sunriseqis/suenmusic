# iOS 桌面卡片（WidgetKit）接入

> **2026-10-19 已下线**：App target 的 `Embed Foundation Extensions` 阶段已移除，
> 产物不再包含 `PlugIns/SuenMusicWidget.appex`。源码与 target 保留但未参与构建；
> 需要恢复时把 Embed 阶段加回 `project.pbxproj`。
> 下线原因见 `docs/memory/2026-10-19-iOS直连播放链路与锁屏上限.md` 第六节。
>
> 下面是当初的接入记录，留作恢复时的参考。
>
> 扩展 target 已写进 `project.pbxproj`，仓库里拉下来就能编译，不需要在 Xcode 里
> 手动加。改动见 `docs/memory/2026-10-19-小组件扩展target补齐.md`。

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

## 工程接线（已在 pbxproj 中完成）

| 项 | 值 |
|---|---|
| target | `SuenMusicWidget`（`com.apple.product-type.app-extension`） |
| Bundle ID | `com.suenmusic.app.widget`（App 的子级） |
| Info.plist | `SuenMusicWidget/SuenMusicWidget-Info.plist` |
| Entitlements | App → `App/App.entitlements`；Widget → `SuenMusicWidget/SuenMusicWidget.entitlements` |
| App Group | 两侧均为 `group.com.suenmusic.app` |
| Deployment Target | 两个 target 均为 15.0（与 App 历史口径一致；`AppIntents` 的使用已由 `@available(iOS 17.0, *)` 隔离，实测 15.0 可编译） |
| 嵌入 | App target 的 `Embed Foundation Extensions`（`dstSubfolderSpec = 13`） |

Target Membership：`SuenMusicWidget.swift` 只进 Widget；`SharedNowPlaying.swift`
与 `PlaybackIntents.swift` 两个 target 都进（同一文件需要两条 PBXBuildFile）。

验证命令（不签名）：

```bash
cd ios/App
xcodebuild -project App.xcodeproj -target App -configuration Debug \
  -sdk iphonesimulator SYMROOT=build/widget-check \
  CODE_SIGNING_ALLOWED=NO build
ls build/widget-check/Debug-iphonesimulator/App.app/PlugIns
```

出现 `SuenMusicWidget.appex` 即为接线正确；随后运行 App → 播放一首歌 →
回桌面长按 → 添加「SuenMusic · 正在播放」。

**签名侧仍需人工确认**：开发者账号里要有 `group.com.suenmusic.app`，且 App 与
Widget 两个 Bundle ID 的描述文件都启用该 capability，否则卡片永远显示空态。

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
| 安装报 `missing or invalid CFBundleExecutable` | `SuenMusicWidget-Info.plist` 必须有 `CFBundleExecutable = $(EXECUTABLE_NAME)`（构建系统不会替 appex 注入） |
