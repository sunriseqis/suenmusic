# SuenMusic 原生客户端（iOS）—— S0 骨架

> 方案：`docs/plan/2026-10-21-客户端全原生化迭代方案.md`
> 目标系统：**iOS 26+**（不再兼容低版本）
> 本目录**不含 Capacitor、不含 WebView**。

## 目录

```
App/        SuenMusicApp.swift（@main）、AppState.swift、Info.plist
Net/        Models.swift（服务端契约）、APIClient.swift（Bearer + 401 单飞刷新 + 多服务端选路）
Player/     AudioEngine.swift（从 Capacitor 插件抽出的播放内核，去掉了桥接层）
            AudioCacheStore.swift（4GB 磁盘 LRU + LocalStreamProxy 本地回环，整文件搬来）
            PlaybackService.swift（引擎 ↔ SwiftUI 的绑定）
UI/         RootView / LoginView / HomeView / PlayerBar / PlayerView / SettingsView
```

## 在 Xcode 里怎么建 target（3 步）

1. Xcode → File → New → Project → **iOS App**，Product Name `SuenMusic`，
   Interface **SwiftUI**，Language **Swift**，Bundle ID 用 `com.suenmusic.app`
   （与服务端更新通道、钥匙串一致）。
2. 把本目录下 `App/ Net/ Player/ UI/` 四个文件夹**整体拖进**新工程（勾选 *Create groups* +
   *Copy items if needed*），删掉模板自带的 `ContentView.swift`。
3. Target → Info → **删掉生成的 Info.plist 内容，改成用本目录的 `App/Info.plist`**
   （Build Settings → `INFOPLIST_FILE = SuenMusic/App/Info.plist`）；
   Deployment Target 设 **26.0**。

> 旧的 `ios/App/`（Capacitor 壳）在 S0 验收通过后删除，见计划 §七。

## S0 验收：六条命脉（缺一不算过）

| # | 场景 | 判定标准 |
|---|---|---|
| 1 | 登录 | 填服务端地址 + 账号口令 → 进首页，杀进程重开仍是登录态 |
| 2 | 首页列表 | 新歌/榜单正常渲染，下拉刷新有效 |
| 3 | 点歌播放 | 点任意一首 3 秒内出声，播放页进度在走 |
| 4 | 锁屏控制 | 锁屏显示曲名/歌手/进度，暂停/播放/上一首/下一首都生效 |
| 5 | 自动切歌 | 一首放完**自动**接下一首（锁屏状态下也要接） |
| 6 | 断网播缓存 | 完整播放过的歌，飞行模式下仍可播放；未缓存的歌给出明确提示、不连跳 |

## 已知的 S0 边界（S1 补）

- 只有首页 + 我的两个 tab；搜索/收藏/每日/队列/歌词/锚定在 S1。
- 刷新令牌暂存 `UserDefaults`，S1 换 Keychain。
- 多服务端只有一条（登录时填的地址），S1 补编辑与自动选路 UI。
- 未做 AnyCast/隔空播放、未做灵动岛（Live Activity）。
