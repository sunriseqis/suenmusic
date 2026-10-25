# iOS 对齐 hw 的差距清单（2026-10-25 调研汇总）

三份只读调研（视觉规范 / 播放页歌词队列 / 设置缓存备份）的结论汇总。**hw 源码是唯一真相**，
实现时直接读 `hw/entry/src/main/ets` 对应文件，本文件只做索引与进度追踪。

## 一、视觉基座（批次 1，**已完成并集成编译通过**）
| 件 | hw 来源 | iOS 目标文件 | 状态 |
|---|---|---|---|
| 动态色令牌（16 token 浅/深） | common/Tokens.ets | UI/DesignTokens.swift（改造） | 完成 |
| WebIcon（22 图标映射） | common/WebIcons.ets | UI/WebIcon.swift | 完成 |
| WebIconButton（4 质感×4 尺寸）/ WebButton（4 变体×3 尺寸） | common/WebButtons.ets | UI/WebButton.swift | 完成 |
| NeuTabs 分段控件 | common/NeuTabs.ets | UI/NeuTabs.swift | 完成 |
| TrackItem → TrackRow（含 PlayingBars + 右滑收藏状态机） | common/TrackItem.ets | UI/TrackRow.swift | 完成 |
| EmptyState + Copy 文案表 | pages/EmptyState.ets, common/Copy.ets | UI/EmptyState.swift, UI/Copy.swift | 完成 |
| AppToast（2200ms/距底132/穿透点击） | common/AppToast.ets | UI/AppToast.swift | 完成 |
| ConfirmDialog（86%宽/16圆角/危险变体） | common/ConfirmDialog.ets | UI/ConfirmDialog.swift | 完成 |
| NeuInput（凹陷+琥珀光标） | pages/NeuInput.ets | UI/NeuInput.swift | 完成 |
| 骨架屏海报块 withPoster | pages/SkeletonList.ets | UI/SkeletonList.swift（改造） | 完成 |


## 一·五、接口层（已完成）
新增 18 个方法 + 10 个模型，均已对应真实 handler（编译 + 16 条解码断言全过）。
踩到并已处理的服务端差异：favorites/tracks 是包裹结构；persona 与 persona/tune 两种形状；
POST anchor 不回锚点本体（写后再读）；**无锚点是 200 + {anchor:null} 而非 404**；
dedup/preview 双键重复；网易云 account 可为 null 而 configured=true；batch 失败项缺字段。

## 二、页面（批次 2，**已交付并集成编译通过**）
| 页面 | hw 来源 | 要点 |
|---|---|---|
| 播放页重写 | pages/PlayerPage.ets | 环境光晕(封面 blur60 op0.15)、封面 280/194、曲名 24、推荐理由卡、Slider(step 1s)、五键排(模式/上一首/60播放键渐变/下一首/队列)、歌词 peek 三行(58 高)、浮层层键 lyrics/queue/more/anchor/dislike |
| 歌词面板 | pages/LyricView.ets | 状态机 idle/loading/ready/empty/error；首尾占位 120/160；当前行 18 Medium accent、非当前 15 text2；点击行 seek；翻译双指针 ±300ms 对齐；LRC 正则与缓存(60 条)共用一套 |
| 队列页 | pages/QueueView.ets | 70% 抽屉、当前项 accent+「播放中」、删除键(danger)、长按拖动排序、jumpTo/removeAt/moveItem 语义照抄内核 |
| 「更多」菜单 | PlayerPage 内 | 音源行 / 歌手行 / 专辑行 / **修正音源**；没有收藏/分享/下载/定时 |
| 修正音源弹窗 | PlayerPage 'anchor' 层 | 候选搜索(默认 歌名+主歌手)、试听(暂停主播放，结束恢复)、锚定(清离线缓存+重装当前曲)、解除锚定；接口 GET/POST/DELETE `/api/tracks/:id/anchor` |
| 不喜欢弹窗 | common/DislikeDialog.ets | 两个范围(歌/歌手)、歌手用 ar[0].mid、成功后 removeAt + 摘同歌手曲目(从尾到头最后删当前曲) |
| 缓存页 | pages/CachePage.ets | 只显示 已用/上限 一行 + 说明 + 全宽 danger「清空全部」；无逐曲列表、无上限设置 |
| 服务器列表 | pages/ServerListPage.ets | 底部浮层、四态探活(必须校验 ok===true)、新增/编辑/切换/删除、切换失败整笔回滚、删前先切 |
| 设置页三段 | pages/SettingsPage.ets | 本机(缓存/歌词翻译/主题/资料库4行/账号2行/退出)、智能(画像解析#/-/·/分隔线、调优)、高级(检查更新/桌面卡片/多服务端/音源授权) |
| 五个弹层 | SettingsPage 内 | 黑名单(分片+恢复)、歌单导入、去重(preview→清理)、改密码、数据备份(WebDAV) |

## 三、功能/接口缺口（批次 3）
服务端**全部已存在**，iOS 只缺调用：
`/api/favorites/{tracks?limit=500,import,import-qq-playlist,dedup/preview,dedup}`、
`/api/recommend/{dislikes,dislike,dislike/:type/:id}`、
`/api/ai/{persona,persona/tune}`、
`/api/{bilibili,netease}/account`（授权状态：configured 优先）、
`/api/tracks/:id/anchor`（GET/POST/DELETE）、
`/api/stream/session-token`（切服后重建队列）、
`/api/resolve/batch`（列表预热应改用它）、
`/api/auth/{sessions,session,revoke,logout-all}`、`/api/admin/backup`、`/api/history*`。

WebDAV 是纯客户端 PUT/GET `<url>/suenmusic.sm`，不经服务端。

## 四、桌面卡片（独立工程）
hw 用 FormAbility + 2×2/2×4 两种尺寸；iOS 对应 **WidgetKit 桌面小组件**（与 Live Activity 无关，后者已关）。
payload/配色/歌词 3 行窗口/按钮指令(play/pause/next/prev/favorite)/刷新节流 1000ms —— 规格见调研原文
（`forms/SuenFormCard.ets`）。注意 iOS 小组件进程不能联网、不能读 App 内存，需 App 侧写共享容器。

## 四·五、批次 2 实测结论（模拟器 OCR + 日志）
- 播放页：eyebrow / 封面 / 曲名 24 / 进度 / 时间 / 歌词 peek 均渲染（截图 OCR：正在播放·每、小城大事、杨千嬅·温馨小品钢琴集、0:10、歌词行）
- 设置页：播放段（缓存 177M/2.0、显示歌词翻译）、主题段（跟随系统/浅色/深色）、资料库段（黑名单）渲染正确
- 歌词链路：日志逐行输出 `[Lyric] 当前行=…`，说明换歌事件与歌词加载都正常
- Live Activity：`[LiveActivity] 已请求 activity id=… title=小城大事`；后台请求会被系统拒（Target is not foreground）并静默降级
- **澄清悬案**：`emitTrackChange` 一直是通的 —— 之前“未触发”是 NSLog 混用 %d/%@ 格式符导致日志被吞

## 五、遗留待查
1. `PlaybackService.emitTrackChange` 在自动播放路径上未触发（歌词加载挂在这里，已休眠）。代码路径检查无误，
   需在干净构建上用无格式化符日志再验一轮（见 MEMORY 中 2026-10-25 §二十一）。
2. 服务端是否已发布 `platform=ios` 的更新产物（T13 里核）。

## 六、收尾状态（2026-10-25 晚）
- **iOS 端完工**：真机（iPad 8th）已安装、模拟器全链路验收通过。详见 `docs/memory/2026-10-25-iOS端完工.md`。
- 上一节「遗留待查」两条均已闭环：① `emitTrackChange` 已确认正常（歌词首播改由 `play()` 显式调用 `ensureLyrics/ensureRecoReasons`）；
  ② 服务端 `platform=ios` 产物留待 T13 发布链一并核。
- 明确不做：桌面 widget、曲目行歌手名下钻、队列拖动排序。
