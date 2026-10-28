# iOS 换播放内核到 libmpv（决策记录，2026-10-28）

> **决策**：iOS 端把播放内核从 AVFoundation / AVPlayer 换成 **libmpv**（经 MPVKit 以 SPM 引入）。
> **理由**：AVPlayer 的能力边界导致 B 站音源、FLAC、OGG 播不了，且无法靠配置绕过。
> **范围**：只要音频；不做视频/字幕；不做双引擎过渡（项目未进生产）。
> 执行计划见 [`docs/plan/2026-10-28-iOS播放内核切换libmpv.md`](../plan/2026-10-28-iOS播放内核切换libmpv.md)。

## 一、走到这一步的完整证据链

起点是用户反馈「B 站音源不出声」。中途我给出过三个错误归因，逐一被证据推翻，值得记下来：

| 我的归因 | 为什么错 |
| :-- | :-- |
| 本地缓存文件是 fMP4，AVPlayer 播不了 fMP4 | 后来实测 fMP4 **能播**（本地注入对照，用户实听有声） |
| 酷狗给 iOS 的直链是 OGG | 那是**我自己探测脚本**用了 `preferMp3:false`，App 真实路径是 `preferMp3:true` 拿 mp3 |
| B 站直链播不了是因为缺 Referer | 抓包证明 `Referer` **确实送到了**；curl 带同样头是 206 正常 |

最终被证据钉住的结论：

1. **同一份字节：本地文件能播，走 CDN 的 HTTP 不能播**（缓存注入 vs 直链取流的对照实验）。
2. B 站 fMP4 走 CDN，AVFoundation 报 `-11828 Cannot Open`，**4 个节点（estgcos / mirrorcoso1 / mirrorcos）全挂**。
3. 播放器拿到的头部是对的，URL 也没坏 —— **问题在 AVFoundation 对这类响应的解析**。
4. FLAC / OGG 在 AVPlayer 上**实听不出声**（本地文件与 HTTP + 正确 MIME 都试过）。

## 二、关键旁证：成熟项目都不用 AVPlayer

| 项目 | 播放内核 | 部署方式 |
| :-- | :-- | :-- |
| `AprDeci/bili-music` | `media_kit` + `media_kit_libs_ios_audio`（libmpv/ffmpeg） | `Media(uri, httpHeaders:)` 直连 CDN |
| `NaivG/bilimusic` | `mpv_audio_kit` + libmpv FFI | 同上；离线缓存注释明写「必须带 Referer/UA 否则 403」 |

两者都**没有服务端代理、没有本地代理**。说明「带 Referer 直连」这条路是通的，
卡住的只是 iOS 的 AVFoundation。

顺带记两个它们做了、我们没做的事：

- **解析 `backupUrl` / `backup_url` 存备用镜像**（我们只取一个 URL，碰上劣质节点就死 —— 正好解释「时好时坏」）
- **缓存是「带 Referer 下载成文件再播」**（`getSingleFile(url, headers)` → 播本地路径），与我们「本地能播」的实测一致

## 三、由此产生的两个产品结论

1. `preferMp3`（iOS 剔除 lossless）+ 酷狗 `need_ogg=0` 在 AVPlayer 时代是**正确且必需的**；换内核后应**放开**，让 iOS 也能用无损。
2. 「B 站不下发直链、统一走服务端代理」这个方案**作废** —— 那是绕路，不是解法。

## 三·补：mpv 传防盗链头的坑（P1 实测，必记）

把 B 站的 `Referer` / `User-Agent` 交给 mpv 时，**写法决定了它到底有没有被发出去**：

| 写法 | 结果 |
| :-- | :-- |
| `Referer` 塞进 `http-header-fields` | ❌ ffmpeg 不吃，CDN 回 **400** |
| `http-header-fields` 用 `", "`（逗号+空格）分隔 | ❌ 同样 400 —— mpv 只按 `,` 切分且**不 trim**，第二个头变成带前导空格的非法头 |
| `Referer` → mpv 的 `referrer` 专用选项；`User-Agent` → `user-agent` 专用选项；其余才进 `http-header-fields`（纯逗号） | ✅ 206 |

**这条解释了我们之前一直没想通的现象**：抓包看到 `Referer` 送到了，CDN 却仍拒绝 —— 送达方式与格式都有讲究。
以后任何端接入 mpv 都必须按这个写法，否则会重演「带了 Referer 还是 403」。

## 四、教训

- **「解析成功」不等于「能播放」**：`AVURLAsset.load(.duration)` 通过只说明容器被识别。判断可播性只认实听或 `readyToPlay` + `currentTime` 推进。
- **不要拿自己脚本的入参当产品路径**：`preferMp3:false` 是我探测时的写法，不是 App 的路径，据此下的结论全错。
- **设备/模拟器上装的是哪个包要核实**：曾用 `ls ... | head -1` 取到三天前的 DerivedData，导致「图标不对」被误判成缓存问题。现在一律用 `SYMROOT` 固定输出目录。

_2026-10-28 记录。_