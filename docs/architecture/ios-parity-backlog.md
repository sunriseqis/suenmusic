# iOS 对齐 hw 的差距清单（2026-10-25 调研汇总）

三份只读调研（视觉规范 / 播放页歌词队列 / 设置缓存备份）的结论汇总。**hw 源码是唯一真相**，
实现时直接读 `hw/entry/src/main/ets` 对应文件，本文件只做索引与进度追踪。

## 一、视觉基座（批次 1，进行中）
| 件 | hw 来源 | iOS 目标文件 | 状态 |
|---|---|---|---|
| 动态色令牌（16 token 浅/深） | common/Tokens.ets | UI/DesignTokens.swift（改造） | 进行中 |
| WebIcon（22 图标映射） | common/WebIcons.ets | UI/WebIcon.swift | 进行中 |
| WebIconButton（4 质感×4 尺寸）/ WebButton（4 变体×3 尺寸） | common/WebButtons.ets | UI/WebButton.swift | 进行中 |
| NeuTabs 分段控件 | common/NeuTabs.ets | UI/NeuTabs.swift | 进行中 |
| TrackItem → TrackRow（含 PlayingBars + 右滑收藏状态机） | common/TrackItem.ets | UI/TrackRow.swift | 进行中 |
| EmptyState + Copy 文案表 | pages/EmptyState.ets, common/Copy.ets | UI/EmptyState.swift, UI/Copy.swift | 进行中 |
| AppToast（2200ms/距底132/穿透点击） | common/AppToast.ets | UI/AppToast.swift | 进行中 |
| ConfirmDialog（86%宽/16圆角/危险变体） | common/ConfirmDialog.ets | UI/ConfirmDialog.swift | 进行中 |
| NeuInput（凹陷+琥珀光标） | pages/NeuInput.ets | UI/NeuInput.swift | 进行中 |
| 骨架屏海报块 withPoster | pages/SkeletonList.ets | UI/SkeletonList.swift（改造） | 进行中 |

## 二、页面（批次 2，待派）
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

## 五、遗留待查
1. `PlaybackService.emitTrackChange` 在自动播放路径上未触发（歌词加载挂在这里，已休眠）。代码路径检查无误，
   需在干净构建上用无格式化符日志再验一轮（见 MEMORY 中 2026-10-25 §二十一）。
2. 服务端是否已发布 `platform=ios` 的更新产物（T13 里核）。
