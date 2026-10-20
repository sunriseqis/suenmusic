# iOS 直连模式播不出声：`setDirectUrl` 没实现（2026-10-19）

## 现象

不配服务端（直连模式）播放：UI 有歌名、进度 0、没有声音。控制台：

```
[direct] 网易云取流 3448897178《放羊歌》score=80 → ok br=320000
To Native -> SuenAudio reloadCurrent
NSURLConnection finished with error - code -1002
```

`-1002 = NSURLErrorUnsupportedURL`。

## 根因：跨端能力缺口

Web 端 `stores/player.ts` 在直连模式下会把客户端解析出的上游地址逐首登记：

```ts
await SuenAudio.setDirectUrl({ id: track.id, url: direct ? url : '' })
```

- **Android 已实现**：`SuenAudioPlugin.setDirectUrl` → `SuenAudio.directUrls` 映射，
  `streamUrlFor()` 优先返回直链。
- **iOS 没实现**：插件 `pluginMethods` 里没有该方法，Web 端的调用被
  `.catch(() => {})` 静默吞掉。

于是原生继续走 `directStreamUrl()`：`baseUrl` 是空串，拼出来是
`/api/stream/<id>` —— 一个**相对 URL**。`AVURLAsset` 无法解析，报 -1002。
（`setQueue` 当时因为 `baseUrl=""` 能通过校验，所以队列装得上、元数据也正常，
只是没声。）

## 修复（`ios/App/App/SuenAudioPlugin.swift`）

1. `SuenTrack` 增加 `var directUrl: String?`，`setQueue` 解析 `items[].directUrl`。
2. `setQueue` 不再把空 `baseUrl` / `token` 当缺参拒绝（对齐 Android 的
   `direct` / `anyDirect` 判断）。
3. 新增 `setDirectUrl` 插件方法并注册到 `pluginMethods`。
4. `AudioEngine.setDirectUrl(id, url)` 按 id 更新队列里的直链（空串 = 清除）。
5. `streamUrl()` 优先级：**本地回环代理（有直链时也由代理接管）→ 直连地址 → 服务端代理**。
   AVPlayer 自己直连 CDN 只收到几百字节就放弃，所以代理必须优先。
6. `makeItem()` 不再对 `URL(string:)!` 强解包：无可用地址时用
   `suenmusic://invalid-stream/<id>` 占位，让错误走 `itemFailed` 上报而不是崩溃。

编译验证 `BUILD SUCCEEDED`；直连播放需要在无服务端配置下实测。

后续几层坑（AVPlayer 缓冲速率评估、占位条目导致连续跳歌、换条目 seek、锁屏续播上限）
见 `2026-10-19-iOS直连播放链路与锁屏上限.md`。

## 口径

**新增任何 Web 端会调用的原生插件方法，必须三端对齐**（web/src/native/audio.ts
的接口就是契约）。iOS 侧漏实现时不会报错，只会静默走回退路径，现象离根因很远。
