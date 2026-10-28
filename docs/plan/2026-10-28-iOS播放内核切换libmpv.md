# iOS 播放内核切换到 libmpv（MPVKit）· 执行计划

> 状态：**已获用户裁定，进入执行**。日期 2026-10-28。
> 关联：[iOS 音频格式实测矩阵](../memory/2026-10-28-iOS音频格式实测矩阵.md) · [直链播放与音质开关设计方案](../memory/2026-10-28-直链播放与音质开关设计方案.md)

## 一、起因与决策

iOS 端 B 站音源不出声，排查结论不是配置问题，是**播放内核的能力边界**：

| 事实 | 证据 |
| :-- | :-- |
| FLAC / OGG 在 AVPlayer 上播不了（本地文件与 HTTP 都试过） | 实听 + 设备日志 |
| B 站 fMP4 走 CDN 的 HTTP 取流，AVFoundation 报 `-11828 Cannot Open`，4 个 CDN 节点全挂 | 设备日志 + 逐节点复现 |
| 同样的 URL 带 Referer 用 curl 是 206 正常，头部也确实送到了（抓到 `Referer`） | 抓包验证 |
| 同一份字节**本地文件能播**，走 CDN 的 HTTP 不能播 | 缓存注入对照实验 |

**用户裁定（2026-10-28）**：

1. **换播放内核**，用 libmpv（经 MPVKit 引入）——一次解决 B 站 fMP4 / FLAC / OGG / 防盗链。
2. **只要音频**（不做视频/字幕/滤镜）。
3. **不做双引擎过渡**——本项目未进生产，改好为止。

## 二、为什么是这个选型

两个成熟的 B 站音乐客户端都**不用 AVPlayer**，都用 libmpv：

| 项目 | 内核 | 怎么把地址交给播放器 |
| :-- | :-- | :-- |
| `AprDeci/bili-music` | `media_kit` + `media_kit_libs_ios_audio` | `Media(uri, httpHeaders: headers)` |
| `NaivG/bilimusic` | `mpv_audio_kit` + libmpv FFI | `mpv.Media(...)` + `NetworkConfig.biliHeaders` |

两者都**没有服务端代理、没有本地代理**，直接客户端带 Referer 播 CDN —— 证明「带 Referer 直连」这条路本身是通的，
卡住我们的只是 AVFoundation 吃不下这类响应。

`MPVKit`（`github.com/mpvkit/MPVKit`）：SPM、iOS 15+、内含 libmpv + ffmpeg（avcodec/avformat/swresample）。

## 三、环境

| 项 | 值 |
| :-- | :-- |
| 构建机 | `suenqi@suenqideimac.lan`（Darwin 25.6 / x86_64），Xcode 26.5 |
| 模拟器 | iPhone 17，UDID `4A478A12-1A0C-4874-BC2B-94AFAA073822` |
| **GitHub 代理** | `http://192.168.89.3:20170` —— Mac 直连可用但很慢（约 9s 握手），拉 SPM 包时**必须走代理** |
| 本机（Linux） | 只做源码与生成器改动，不编译 iOS |

构建命令（固定输出目录，避免装错旧包）：

```
xcodebuild -project App.xcodeproj -target App -configuration Debug -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=iPhone 17" \
  SYMROOT=$HOME/suen-build OBJROOT=$HOME/suen-obj \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
```

## 四、阶段与验收

| 阶段 | 内容 | 验收 |
| :-- | :-- | :-- |
| **P0** | 给 `scripts/gen-ios-project.mjs` 加 SPM 支持（XCRemoteSwiftPackageReference / XCSwiftPackageProductDependency / PBXProject.packageReferences / target.packageProductDependencies / Frameworks phase 的 productRef），挂 MPVKit，加一个**真调用 libmpv 符号**的探针文件 | `gen-ios-project.mjs --check` exit 0 + Mac `BUILD SUCCEEDED` + 量出 App.app 体积增量 |
| **P1** | 写 `MpvEngine`：播一个带 Referer 的 URL、拿时长、上报播放态 | 模拟器里 B 站 m4s 出声有进度 |
| **P2** | 补全 queue / 接续 / seek / 打断 / 错误上报，对齐现有 `PlaybackService` 接口 | 与 AVPlayer 版行为一致 |
| **P3** | 全量切 mpv，删 AVPlayer 路径（不做双引擎） | 无 AVPlayer 残留 |
| **P4** | 回归：FLAC / OGG / B 站 fMP4 / 酷狗 mp3 / 后台播放 / 锁屏控制 / 缓存本地文件 | 逐项实听验过 |
| **P5** | 放开 iOS lossless（去掉 `preferMp3` 对无损的屏蔽）+ 解析 `backupUrl` 多镜像 | iOS 可选无损；单节点故障自动换镜像 |

## 五、包体积与「只要音频」

MPVKit 是**预编译全量 ffmpeg**（含视频/滤镜/字体渲染）。仅靠配置层 `--vo=null --audio-display=no` **只能关掉运行，瘦不了包**。

真正的音频瘦身 = 自己交叉编译 audio-only 的 ffmpeg（`--disable-everything` 后只开音频 decoder/demuxer/parser）再编 libmpv。
**P0 会先量出全量体积增量**，据此决定：

- 增量可接受 → 保持 MPVKit 全量，配置层只做音频；
- 增量过大 → 启动自编 audio-only 方案，作为独立阶段。

## 六、风险

1. **生成器被冲掉**：pbxproj 由脚本生成，任何手改都会被覆盖 —— 所有 SPM 配置必须落在生成器里。
2. **SPM 首次拉取慢/失败**：必须带代理；失败时检查 `https_proxy` 是否传入 xcodebuild 环境。
3. **音频会话与后台播放**：现由 AVFoundation 驱动，换 mpv 后 `AVAudioSession` 类别、`MPNowPlayingInfoCenter`、`MPRemoteCommandCenter` 要自己维护。
4. **模拟器切片**：MPVKit 是否提供 x86_64-simulator 切片，P0 编译即验证。
5. **状态机差异**：AVPlayer 的 `status/timeControlStatus` 语义要映射到 mpv 的 `property-change` 事件，现有失败三分支逻辑不能丢。

## 七、当前进度

- [ ] P0 生成器 SPM + MPVKit 编译通过（进行中）
- [ ] P1 MpvEngine 起播
- [ ] P2 接口对齐
- [ ] P3 移除 AVPlayer
- [ ] P4 回归
- [ ] P5 放开无损 + 多镜像