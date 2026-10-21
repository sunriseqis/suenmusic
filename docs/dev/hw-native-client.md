# 鸿蒙原生客户端工程手册（S2/S3）

> 目标系统：**HarmonyOS NEXT 6 / compatibleSdkVersion 26.0.0**（不兼容低版本）
> 入口页：`pages/NativeRoot`（**无 ArkWeb / 无 WebView**）
> 总纲：`docs/plan/2026-10-21-客户端全原生化迭代方案.md`
> 阶段文档：S2 交接单 / 验收回执 / S3 增量单 均在 `docs/plan`、`docs/memory` 下

## 一、目录结构（原生部分）

```
entry/src/main/ets/
├── core/
│   ├── Models.ets           服务端契约（与 TS / Swift 三方同源）
│   ├── APIClient.ets        http.request + Bearer + 401 单飞刷新 + 多服务端选路
│   ├── OfflineCache.ets     request.agent → filesDir + 2GB LRU
│   └── MediaPlayerCore.ets  AVPlayer 播放内核（队列/接续/中断/长时任务/缓存优先）
├── common/
│   ├── AVSessionManager.ets 播控中心 + 桌面卡片 + 长时任务（原生版）
│   ├── Tokens.ets           设计令牌（**自动生成，禁止手改**）
│   ├── NowPlaying.ets       卡片快照 + LRC 解析（**歌词解析的唯一实现**）
│   └── PlayerControlHub.ets 卡片按钮指令分发（无 WebView 时直驱内核）
├── viewmodel/AppState.ets   登录态 + 首页数据
└── pages/
    ├── NativeRoot.ets       @Entry：Tab + 底部播放条 + 全屏播放层
    ├── LoginPage / HomePage / SettingsPage
    └── PlayerPage.ets       三视图（封面 / 歌词 / 队列）
        ├── LyricView.ets
        └── QueueView.ets
```

`pages/Index.ets`（旧 WebView 壳）**保留为回退路径**，不是入口页，也不要在它上面做新功能。
注意它内部有**自己的** `HarmonyAVSessionManager` 副本 —— 改 `common/` 版不影响它，反之改错份会"改了但没生效"。

## 二、三条硬约束（违反即白干，真机事故换来的）

### ① AVPlayer 必须由 `stateChange` 驱动

```
reset() ──(idle)──> url = …
        ──(initialized)──> audioRendererInfo = … ; prepare()
        ──(prepared)──> play() / 停
        ──(playing)──> 上报播放态 + 启动长时任务 + 起缓存下载
```
`audioRendererInfo` 官方要求「只允许在 `initialized` 状态设置，且在首次 `prepare()` 之前」。
写在 `url = …` 之后立刻执行时状态还是 `idle` → 直接抛异常 → 界面报「这段音源装载失败」，而底层 AVPlayer 其实正常。

### ② 单首播放失败不是致命错误

`failStreak < 3` → 600ms 后自动 `next()`；`≥ 3` → 停下并给人话提示。
服务端对解析不出的曲目回 **503 `source_unavailable`**（`reason: below_threshold`），AVPlayer 报 `5411004` —— 这是正常业务结果。
`fail()` 有 `failHandled` 单次闸门：`prepare` 抛错与 `on('error')` 只计一次。

### ③ AVSession 推送必须有闸门

`updatePlaybackStateFromNative`：在飞即丢 + 播放态未变 900ms 间隔；`doUpdateMetadata`：按 `assetId` 去重且条件含 `currentMetadata !== null`；`timeUpdate` 的推送 ≥1s。
症状对照：日志刷 `SetAVPlaybackState:2 in syncExecutor timeout after err:0` = 闸门被去掉。

## 三、平台与工程约定

| 项 | 约定 |
|---|---|
| 入口页 | `main_pages.json` 与 `EntryAbility.loadContent()` **两处必须一致**，否则白屏 + `err.code=401` |
| 设备类型 | `module.json5` 只声明 `phone` / `tablet`（PC 走 Web 面板） |
| 签名 | `signingConfigs` **故意为空**：CI 出未签名 HAP，真机由侧签工具签，虚拟机不需要 |
| 颜色 | 只允许 `common/Tokens.ets`（由 `web/src/styles/tokens.css` 生成）；唯一例外是错误色 `#E5484D` |
| 长时任务 | `STREAM_USAGE_MUSIC` 必须接 AVSession；暂停/停止要**主动**取消（否则"申请了没在播"会被系统挂起） |
| 音频缓存 | 只准 `filesDir`（`cacheDir` 会被系统按配额清理） |
| ArkTS 禁区 | 禁 `any`/`unknown`、禁无类型对象字面量、`const` 不可同域重复、`seek/pause/stop` 返回 `void` 不能 `.catch`、成员名不能撞 ArkUI 内置属性（`position` / `tabIndex` 已踩）、`request.agent.Task` 没有 `deleteSync()` |
| 生成器 | `python3 scripts/gen-brand-tokens.py`（令牌）；`python3 scripts/gen-brand-icons.py`（图标，含鸿蒙分层图标） |

## 四、本机静态自检（没有 SDK 也能查）

本机无法编译（官方 DevEco 只有 Windows/macOS，`hvigor` 随 IDE 分发，npm/ohpm 上都没有），
但**过去十几轮的编译失败几乎全是静态错误**，这些不需要 SDK：

```bash
npm run hw:check          # 11 条规则，含 0 误报基线
npm run hw:check:strict   # 额外查「裸对象字面量」（启发式，误报率高）
```

| 规则 | 抓什么 | 对应真实事故 |
|---|---|---|
| `arkts-no-any-unknown` | `: any` / `: unknown` | 抽取 AVSessionManager 时漏搬 import → 推导成 unknown |
| `arkts-redeclare` | 同一花括号作用域内 `const` 重名 | 加元数据去重时重复声明 `assetId` |
| `arkui-reserved-member` | 成员名撞 ArkUI 内置属性 | `position`（表单卡片）、`tabIndex`（Tabs） |
| `void-catch` | `seek/pause/stop/reset(...).catch()` | `seek()` 返回 void → 必须 try/catch |
| `fake-api` | 不存在的 API（如 `Task.deleteSync`） | 按记忆写出的伪 API |
| `import-missing` | import 相对路径不存在 | 新文件漏建/改名 |
| `entry-mismatch` | `loadContent` 与 `main_pages.json` 不一致 | 白屏 + `err.code=401` |
| `color-literal` | `Tokens.*` 之外的颜色字面量 | S2 手抄 `#17181B` 当页面底色 |
| `watch-order` | `@Watch` 写法顺序 | 状态联动不生效 |
| `unbalanced` | `{}` / `()` 不配对 | 脚本化改代码切坏文件 |

> **注意**：自检器自身也栽过 —— 首版把字符串一起剥掉，导致「路径」「颜色」两条规则永远不会触发（假绿）。
> 现在拆成 `stripComments`（保留字符串）与 `strip`（再剥字符串）两个版本，并有"埋雷自测"覆盖每一类。

## 五、验收五条命脉（每次动播放链路都要回归）

1. 基本播放（3 秒内出声、进度推进）
2. 无源曲自动跳过（提示后人话 + 600ms 接下一首）
3. 后台/锁屏出声（`state=2` + elapsed 递增）
4. 锁屏/播控按钮有效，且无 `SetAVPlaybackState timeout` 刷屏
5. 断网播已缓存（`fd://` 命中），未缓存的明确提示且不连跳
