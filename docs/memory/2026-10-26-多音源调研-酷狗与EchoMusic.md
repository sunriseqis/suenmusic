# 2026-10-26 多音源调研：酷狗 API / 签到会员 / EchoMusic 架构

三份只读调研的结论归档。标注约定：**[证据]** 看过代码或实测；**[推断]** 判断；**[需实测]** 未验证。

## 一、酷狗 API（MakcRe/KuGouMusicApi）

**[证据] 元数据可用，且匿名即通。**
我方环境（192.168.89.10）实测 `GET /v2/search/song`（MD5 签名 + 本地生成 mid + dfid='-'）→ HTTP 200 / status=1：
```
首条：处处吻 (DJ老鹏版) | 杨千嬅 | 时长 246 | 码率 128
逐档 hash：HQFileHash=有 SQFileHash=有 SuperFileHash=无
权益：Privilege=0 PayType=0 QualityLevel=3
封面模板：imge.kugou.com/stdmusic/{size}/…
```
签名 = `MD5(盐 + 排序参数串 + body + 盐)`，标准版盐 `OIlwieks28dk2k092lksi2UIkp`，纯 MD5 可离线算；`mid = BigInt('0x'+md5(guid))`。

**[证据] 播放直链当前不可用。**
我方实测 `/v5/url`（signKey + 参数齐全）→ `20006 err signature`；子代理用仓库正确签名后实测 → `20028 本次请求需要验证` + `ssa-code` 响应头；`/v1/authorization` 匿名 → `35002 parameter incomplete`。
**关键信号：免费曲与付费曲被同样拦** → 拦的是**请求方**（机房 IP + 未注册 dfid + 无 SID/EDT 行为指纹），不是歌曲。

**[证据] 会员音质是逐档权益**，不是布尔开关：`level 2=128 / 4=320 / 5=FLAC / 6=Hi-Res / 7=DSD`；`viper_tape/clear/atmos` 需**超级 VIP**，概念版 VIP 也拿不到。

## 二、酷狗签到换会员（Vxiaolong666/kg-checkin）

**[证据] 机制**：`/youth/listen/song`（伪造 UA 上报听歌）→ `/youth/vip` ×8（间隔 30s）→ 每次 +3 小时，合计 24 小时/天 → 每天净 +1 天，形成"看起来无限"的会员。
**[证据] 核心步骤是伪造广告播放**：`POST /youth/v1/ad/play_report`，body `{ad_id, play_start: now-30000, play_end: now}` —— 即向平台与广告主上报虚假的"看广告 30 秒"数据。**性质是刷量，不是普通签到**。
**[证据] 即便签到成功，高音质还有两道坎**：① 必须 `platform=lite`（appid 3116 / clientver 11440），issue #156 就是"已是 svip 仍只有 128"，原因是部署时 lite 未生效；② 蝰蛇系列要超级 VIP。
**[证据] 稳定性差**：上游 issue #113/#115/#132/#148/#151/#153/#205 反复报领取失败 → 领取接口约 1–3 个月变一次。

**结论：不做。** 理由：刷量性质 + 权益随时下线 + 高音质仍受参数与超级 VIP 限制。

## 三、EchoMusic（hoowhoami/EchoMusic）——"第三方客户端怎么做的"

**[证据] 它把 KuGouMusicApi 当库内联，不起 HTTP。**
`server/` 是 git submodule（`.gitmodules:2-4`）；打包时 `cd server && npm install --omit=dev`（`package.json:14-16`）；运行时 Electron 主进程扫 `server/module/*.js` 自己分发（`src/main/server.ts:59/70/195/312`）；`src/shared/apiServer.ts` 只有状态机，**没有端口/URL**。

**[证据] 音频全是官方 CDN 直链，无代理**：全仓 grep 音频代理零命中；`api/music.ts:120` 返回 `url`+`backup_url`，原生播放器直接 `loadFile`。

**[证据] 跨平台只搬元数据**：QQ/网易云/酷我/汽水/Apple/Spotify 仅做歌单导入（`external/providers/qqmusic.ts:38` 伪造 Referer 直连；`apple.ts:74` 正则抓 JWT），产物**无 url 字段**，靠 `/audio/match` 匹配回酷狗曲库；B站/YouTube/咪咕完全没接。

**[证据] 风控靠真人**：`utils/kugouVerification.ts:36` 识别 9 种验证码厂商，命中 → 弹验证给用户 → 通过后自动重放（`request.ts:341-381`）。这是它能长期活着、而无头服务撞 20028 就死的关键差别。

**[证据] 音质只如实查询不破解**：`/privilege/lite` 的 `relateGoods` 决定可选档位（`resolver.ts:255/673-681`）。

**[证据] 插件化音源契约强于 MusicFree**：`plugins/audioSource.ts` 是**责任链 + position（before-catalog/catalog/after-catalog/final-fallback）+ match/resolve/transform**。

## 四、对本仓的四条结论

1. **业界通行做法是不自建音源代理** —— 把逆向库当库塞进客户端，拿官方 CDN 直链；我们 `server/` 直连各平台取音频是难度最高的一条路。
2. **风控的真正解法是"让真人过验证"** —— 无头服务没有这条通道，所以酷狗直链对我们天然吃亏。
3. **跨平台只搬元数据** —— 印证现有路线（QQ 元数据 + 本地匹配）。
4. **音源层应改责任链** —— 现在是"两级硬编码 netease→bilibili"，每加一源都要改主流程；应改为 position 语义的链式 provider。

## 五、已定 / 待定

- **已定（不做）**：酷狗直链、签到换会员、汽水（需逆向字节签名）。
- **已定（做）**：酷狗**元数据兜底**（匿名可通，成本低）。
- **待用户拍板**：音源层是否重构成"责任链 + 插件契约"（估 3–4 人日）。
- **遗留**：iOS 客户端本轮改动未编译（Mac 构建机失联），待恢复后补编译与装机。
