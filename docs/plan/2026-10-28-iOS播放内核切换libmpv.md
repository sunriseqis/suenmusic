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
| **P2** | 补全 queue / 接续 / seek / 打断 / 错误上报，对齐现有 `PlaybackService` 接口；**并完成[系统集成](#七系统集成灵动岛--锁屏--音频会话)全部条目** | 与 AVPlayer 版行为一致 + 系统集成 checklist 全绿 |
| **P3** | 全量切 mpv，删 AVPlayer 路径（不做双引擎） | 无 AVPlayer 残留 |
| **P4** | 回归：FLAC / OGG / B 站 fMP4 / 酷狗 mp3 / 后台播放 / 锁屏控制 / 缓存本地文件 | 逐项实听验过 |
| **P5** | 放开 iOS lossless（去掉 `preferMp3` 对无损的屏蔽）+ 解析 `backupUrl` 多镜像 | iOS 可选无损；单节点故障自动换镜像 |
| **P7** | **真机待验批次**：第七节 checklist 里模拟器验不了的全部条目（锁屏/灵动岛渲染、10s 停滞自愈、媒体服务重置重建、AirPlay、耳机线控、后台播放） | 真机上逐条实听实点，日志佐证 |
| **P6** | **MVP 内核精简**：自建 audio-only 的 ffmpeg + libmpv，替换 MPVKit 全量包（详见[第九节](#九mvp-内核精简p6独立阶段)） | 四种格式仍全可播 + Release/arm64 增量从 +32M 压到 ≤ +12M |

## 五、包体积与「只要音频」

MPVKit 是**预编译全量 ffmpeg**（含视频/滤镜/字体渲染）。仅靠配置层 `--vo=null --audio-display=no` **只能关掉运行，瘦不了包**。

真正的音频瘦身 = 自己交叉编译 audio-only 的 ffmpeg（`--disable-everything` 后只开音频 decoder/demuxer/parser）再编 libmpv。

**P0 实测体积（2026-10-28）**：

| 口径 | 之前 | 之后 | 增量 |
| :-- | --: | --: | --: |
| Debug / iphonesimulator（未 strip） | 24 M | 99 M | +75 M |
| **Release / arm64**（接近上架） | 9 M | 41 M | **+32 M** |

**用户裁定：先跑通，暂不做瘦身。** 理由：瘦身会卡住整个功能，而代码与包体无关 —— 以后换 audio-only 包不需要改播放器代码。
瘦身留作独立阶段，触发条件：功能跑通后若包体不可接受，再自建 audio-only 的 ffmpeg + libmpv。

## 六、风险

0. **Release 的静默陷阱（P0 实测，必须记住）**：wholemodule 优化会把没人调用的符号整体 DCE，
   探针一旦不被播放路径调用，libmpv 就完全不链接 —— 产物只剩 8.2 M、`nm` 里 0 个 `mpv_` 符号，
   但 **`BUILD SUCCEEDED` 照样通过**。所以「编译通过」≠「真的链进去了」，
   Release 下必须 `nm` 复查 `mpv_*` 符号数量 + 看体积。

1. **生成器被冲掉**：pbxproj 由脚本生成，任何手改都会被覆盖 —— 所有 SPM 配置必须落在生成器里。
2. **SPM 首次拉取慢/失败**：必须带代理；失败时检查 `https_proxy` 是否传入 xcodebuild 环境。
3. **音频会话与后台播放**：现由 AVFoundation 驱动，换 mpv 后 `AVAudioSession` 类别、`MPNowPlayingInfoCenter`、`MPRemoteCommandCenter` 要自己维护。
4. **模拟器切片**：MPVKit 是否提供 x86_64-simulator 切片，P0 编译即验证。
5. **状态机差异**：AVPlayer 的 `status/timeControlStatus` 语义要映射到 mpv 的 `property-change` 事件，现有失败三分支逻辑不能丢。

## 七、系统集成（灵动岛 / 锁屏 / 音频会话）

### 前置认知：这套 UI 不归播放内核管

Live Activity 与 Widget Extension 已在 `60ecdcd` 彻底移除，**灵动岛的媒体卡片是系统原生媒体模块**，
不是我们的扩展。它只认四样东西，全部与解码器无关：

| 依赖 | 现状 | 换 mpv 后 |
| :-- | :-- | :-- |
| `MPNowPlayingInfoCenter`（元数据 + 进度） | `AudioEngine.swift:177` 持有、`:1437-1440` 自己写 duration/elapsed/rate | **要改数据源** |
| `MPRemoteCommandCenter`（播放/暂停/上下曲） | `:1344` / `:1408` / `:1472` 三处注册 | **要转发到 mpv 命令** |
| `AVAudioSession`（playback + active） | `:221` 配置；`:290-303` 订阅打断/重置/路由三条通知 | 保留，注意激活时序 |
| `UIBackgroundModes: audio` | `ios/SuenMusic/App/Info.plist:47` 已有 | 不变 |

**结论：灵动岛与锁屏照样接管，但接管所需的数据要由我们从 mpv 侧喂。**

### 必须补的四件事

1. **`playbackState` 目前零处设置**（全仓 grep 为空）。
   AVPlayer 时代系统可从会话与播放状态推断；mpv 不会。必须显式跟随 `playing / paused / buffering`，
   否则锁屏与灵动岛的播放/暂停图标状态错误。

2. **进度回写机制要换**。现在是一次性写 `MPNowPlayingInfoPropertyPlaybackRate = 1.0`，让系统自己往后推算
   （见 `AudioEngine.swift:1420` 注释）。mpv 侧一旦 seek / 缓冲 / 变速，推算就会漂，
   需订阅 mpv `time-pos` 并**节流（约 1s）**写回 `MPNowPlayingInfoPropertyElapsedPlaybackTime`。

3. **`timeControlStatus` 语义要映射**。UI 的 loading 态与「点了没反应」的失败三分支依赖它
   （`waitingToPlayAtSpecifiedRate` 等）。mpv 对应的是 `paused-for-cache` / `core-idle` / `idle` / 正常出流。
   映射做不好会重演一次「点了不出声也没提示」——**这条今晚已经踩过一次**。

4. **远程命令要自己转发**。mpv 不接管 `MPRemoteCommandCenter`，按键回调仍需转成 mpv 的 pause / seek / 上下曲。

### 两个 iOS + mpv 的硬要求

- 音频输出必须走 `--ao=audiounit`（或 coreaudio），否则静音
- `AVAudioSession` 必须在 mpv 初始化**之前**配置并 `setActive(true)`

### 验收 checklist（P2 门槛，逐项实测）

- [ ] 锁屏显示元数据（歌名/歌手/封面）
- [ ] 锁屏进度条推进，seek 后不漂
- [ ] 播放/暂停图标状态正确（`playbackState`）
- [ ] 灵动岛媒体卡片出现且按钮可用
- [ ] 耳机线控（播放/暂停、上下曲）
- [ ] AirPods 双击手势
- [ ] 来电打断后能恢复播放
- [ ] 耳机拔出自动暂停
- [ ] AirPlay 路由切换不断音
- [ ] 后台播放（锁屏后继续出声）
- [ ] 缓冲态有 UI 反馈（mpv `paused-for-cache` → loading）

## 十、P7 · 真机待验批次

模拟器验不了、必须真机的部分（第七节 checklist 的剩余项）。**在真机过完之前，不认为 P2 的系统集成已完成。**

| # | 待验项 | 为什么模拟器验不了 |
| :-- | :-- | :-- |
| 1 | 锁屏显示元数据 + 进度推进 | 模拟器不渲染锁屏媒体控件 |
| 2 | 灵动岛媒体卡片与按钮 | 同上 |
| 3 | `playbackState` 图标翻转（播放/暂停/缓冲） | 同上；且 buffering 用 `playbackState=.playing + rate=0` 是权宜，真机可能画成播放态 |
| 4 | seek 后进度不漂 | 需要真实拖动 + 锁屏对照 |
| 5 | 10s 停滞自愈 | 要造断流（切飞行模式 / 换劣质 CDN） |
| 6 | 媒体服务重置后重建 MpvPlayer | 模拟器难稳定触发 Reset Media Services |
| 7 | AirPlay 路由切换不断音 | 模拟器无 AirPlay |
| 8 | 耳机线控 / AirPods 双击 | 模拟器无实体键 |
| 9 | 拔耳机自动暂停、来电打断恢复策略 | 同上 |
| 10 | 后台播放（锁屏后继续出声） | 需要真机后台调度 |

## 九、MVP 内核精简（P6，独立阶段）

### 为什么要做

MPVKit 是**预编译全量 ffmpeg**：视频解码器、滤镜链、libplacebo/MoltenVK/Vulkan、字体渲染、字幕渲染都在里面，
而我们是纯音频 App，一个都用不到。实测 Release/arm64 从 9M 涨到 41M（**+32M**）。
MVP（最小可用内核）的目标：**只留能播四类音频格式的那一小部分**，把增量压到 ≤ +12M。

### MVP 能力清单（少一个都不行）

| 类别 | 需要保留 |
| :-- | :-- |
| decoder | `mp3`, `mp3float`, `aac`, `flac`, `vorbis`, `opus`, `alac`, `pcm_s16le` |
| demuxer | `mp3`, `mov`（**B 站 m4s 靠它**）、`flac`, `ogg`, `wav`, `aac` |
| parser | `mpegaudio`, `aac`, `flac`, `vorbis`, `opus` |
| protocol | `http`, `https`, `file`, `tcp`（https 需 TLS 库：gnutls / openssl / mbedtls 选一） |
| 关闭 | 全部视频编解码与滤镜、`--disable-programs --disable-doc --disable-postproc --disable-avdevice --disable-swscale`、encoders/muxers |

libmpv 侧同样裁：`--disable-video --disable-gl --disable-caca --disable-libplacebo`，
**但绝不能关掉 demux 能力**（fmp4/m4s 靠 ffmpeg 的 mov demuxer）。

### 构建步骤（在 Mac 上）

1. 准备 iOS 交叉编译环境（`iPhoneOS arm64` + `iPhoneSimulator x86_64/arm64` 两套）
2. 编 ffmpeg：`--enable-cross-compile --target-os=darwin --enable-static --disable-shared` + 上面的白名单
3. 编 libmpv：用第 2 步产出的 `.pc` 文件，`--enable-static --disable-shared`
4. 打成 `xcframework`，以**本地 SPM 包 / binaryTarget** 形式接入
5. 生成器里把 `MPVKIT_URL` 换成本地包路径（`scripts/gen-ios-project.mjs:32-34`）

### 风险

1. **编译链是最大风险**：ffmpeg + mpv 的 iOS 交叉编译要反复试，可能耗掉一整天
2. TLS 库会吃掉一部分体积收益 —— 若要极致可以只留 https 单协议
3. 以后升级 mpv / ffmpeg 要自己重编，不能再 `Package.resolved` 一拉了事
4. **精简过头的代价很高**：少留一个 demuxer 就是某种格式播不了，必须靠回归清单兜住

### 验收

- [ ] 酷狗 mp3 / 酷狗 flac / 酷狗 ogg / B 站 m4s 四种全部出声有进度
- [ ] Release/arm64 体积增量 ≤ +12M（目标；全量基线是 +32M）
- [ ] `nm` 里仍有 `mpv_` 符号（防 wholemodule DCE）
- [ ] 后台播放、锁屏控制不因裁剪而退化

## 附：构建机环境残留（2026-10-28，有意保留）

Mac（`suenqi@suenqideimac.lan`）上为拉 MPVKit 留下的两样，**保留不清**——后续 P1/P2 还要反复 resolve：

| 项 | 内容 |
| :-- | :-- |
| git 全局代理 | `git config --global http.proxy / https.proxy` → `http://192.168.89.3:20170`（Xcode 内部 git 会读） |
| SwiftPM 包缓存 | `~/Library/Caches/org.swift.swiftpm/artifacts`，约 **559 M**（38 个 xcframework zip 预灌） |

**踩坑记录**：Xcode 下载 xcframework 走 NSURLSession，**不认 `HTTPS_PROXY` 环境变量**，设系统代理需要 sudo；
解法是按 SwiftPM 缓存命名规则（非字母数字→`_`）用 `curl -x` 把 zip 预灌进 artifacts 目录，之后 resolve 直接命中。

`Package.resolved` 已入库（`ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/`），
保证任何机器解析出的 revision 与 `1.1.0-n9.0.2` 完全一致。

## 上线前强制项

**仓库内所有调试钩子必须清理干净。** 登记表见 [`docs/memory/MEMORY.md`](../memory/MEMORY.md) 顶部的
「⚠️ 调试钩子登记表」——新增钩子必须先登记再写代码，表里没登记视为违规提交。
当前与本项目相关的钩子：`SUEN_MPV_TRACE`（mpv 日志级别，纯日志不改行为）等，见登记表。

## 八、当前进度

- [x] P0 生成器 SPM + MPVKit 编译通过（`nm` 155 个 mpv_ 符号，Release 有 DCE 陷阱已记录）
- [x] P1 MpvEngine 起播（B 站 m4s 出声有进度；mpv 头部坑：Referer 必须用 `referrer` 专用选项）
- [x] P2 接口对齐 + 系统集成收口（playbackState / time-pos 1s 节流 / 缓冲态 UI / 10s 停滞看门狗 / 媒体服务重置重建）
- [x] P3 移除 AVPlayer（AudioEngine 1588 → 1120 行，AVPlayer 只剩注释）
- [x] P4 回归（mp3 / flac / ogg / m4s 均实测出声；flac 用曲目自己的音频验过内容正确）
- [x] P5 放开 iOS lossless + backupUrls 下发（服务端已重启，晴天实测 .flac 并出声）
- [ ] **P6 MVP 内核精简（音频专用 ffmpeg + libmpv）** ← 下一步
- [ ] **P7 真机待验批次**（锁屏/灵动岛/自愈/重置/AirPlay/线控/后台，见第十节）
- [ ] backupUrls 客户端侧换镜像（服务端已下发，iOS 尚未消费）
- [ ] P3 移除 AVPlayer
- [ ] P4 回归
- [ ] P5 放开无损 + 多镜像