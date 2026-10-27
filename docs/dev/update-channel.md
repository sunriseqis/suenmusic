# 更新通道（GitHub 源 → 服务端缓存 → 客户端下载）

> 代码：`server/src/services/github-update.ts`（拉取与缓存）、`server/src/routes/update.ts`（HTTP 面）
> 客户端单子：`docs/plan/2026-10-21-鸿蒙端-T7-更新通道客户端.md`

## 一、为什么是"服务端去拉、客户端只连服务端"

| 方案 | 问题 |
|---|---|
| 客户端直连 GitHub Releases | 国内访问 `objects.githubusercontent.com` 极不稳定；鸿蒙客户端走系统浏览器/侧签工具，**发不出鉴权头**（私有仓库更不可能） |
| 客户端自己解析 GitHub API | 同上，且要在客户端维护 API 逻辑与限流处理 |
| **服务端拉取并缓存**（本方案） | 上游只被服务端访问一次；客户端从自己的服务器下载，可鉴权、可限流、支持 Range 续传 |

## 二、配置

### 环境变量（部署层）

> 发行产物统一发布在公开仓库 `sunriseqis/suenapp`，匿名即可访问 Releases API（60次/小时）。
> 配置 `SUENMUSIC_UPDATE_GITHUB_TOKEN` 可提额到 5000/小时。

```ini
SUENMUSIC_UPDATE_GITHUB_REPO=owner/repo   # 缺省 sunriseqis/suenapp（公开仓库）
SUENMUSIC_UPDATE_GITHUB_TOKEN=            # 可选：60/h → 5000/h
SUENMUSIC_UPDATE_GITHUB_API_BASE=         # 可选：API 反代（部署层决策），默认官方
SUENMUSIC_UPDATE_GITHUB_PROXY=            # 可选：下载代理前缀（如 https://gh-proxy.com/）
SUENMUSIC_UPDATE_CACHE_DIR=./data/updates # 持久化
SUENMUSIC_UPDATE_POLL_MINUTES=30          # 0 = 只手点时核对
```

### Web 管理页（管理员随时调；即改即生效）

`Settings.vue → 高级 → 更新通道`（cookie 渠道闸 + CSRF；`GET/PATCH /api/admin/update-settings`）：

| 控件 | 字段 | 说明 |
|---|---|---|
| 更新来源开关 | `source` | GitHub Releases / 已关闭 |
| 出站代理 | `proxyKind` + `proxyUrl` | **直连 / HTTP(S) / SOCKS5** 三选一 |

**代理语义**：真正的**网络层出站代理**（undici `ProxyAgent`）—— API 查询与产物下载**共用同一条代理**，
URL 原样不变，GitHub 看到的请求方是代理出口。HTTP 代理访问 https 目标走 CONNECT 隧道；
SOCKS5 由 undici 8.x 原生支持（`socks5://` scheme），无需额外依赖。

**校验**（保存时做，失败回 400 `invalid_proxy`，原因带给前端）：
- `none` → `proxyUrl` 必须为空
- `http` → `http://` 或 `https://` 开头
- `socks5` → `socks5://` 或 `socks5h://` 开头
- 都必须带主机名

优先级：Web 设置 > 环境变量 > 默认直连。改动即生效，无需重启。

## 三、产物命名约定（CI 侧无需改动）

```
Release tag  = hw-v1.6.0                  # 其它平台 v1.6.0
Asset 名     = SuenMusic-v1.6.0-release.hap   # .ipa / .apk 同理
```

服务端按 tag 里**最后一个 semver** 解析版本，按扩展名映射平台：

| 扩展名 | 平台 |
|---|---|
| `.hap` | `harmony` |
| `.ipa` | `ios` |
| `.apk` | `android` |

版本比较按 **semver 比 versionName**（GitHub 没有 versionCode，`UpdateArtifact.versionCode` 恒回 0，
路由层会自动退回名称比较）。

## 四、运行时行为

```
启动 20s 后首次拉取 → 之后每 POLL_MINUTES 分钟
GET /api/update/check   → 读本地 latest.json（零上游）；?force=1 才去 GitHub 核对
GET /api/update/download → 本地文件流式发送，**支持 Range/206**
```

- `download` 支持两种鉴权：`?token=`（check 签发的短期令牌，给发不出头的调用方）或 `Authorization: Bearer`
- 起点越界回 **416**（不要夹到最后一字节 —— 那会让客户端把 1 字节当续传成功）
- 只保留当前版本文件，历史产物自动清理

## 四、Web 管理页（代理在这里填）

`Settings.vue` → 高级 → **更新通道**（仅 Web 面板管理员可见，接口层有渠道闸 + CSRF）。

| 控件 | 对应字段 | 说明 |
|---|---|---|
| 更新来源开关 | `source` | GitHub Releases / 已关闭 |
| 产物下载代理 | `downloadProxy` | 拼在 `browser_download_url` 前（例 `https://gh-proxy.com/`） |
| API 反代基地址 | `apiBase` | 只影响 `/repos/…/releases` JSON 查询 |

- **两个代理不能互相替代**：文件代理前缀套 JSON API 会失败（已在前端 hint 里写明）
- 存 `app_settings` 表（键 `update_proxy`），**改完即生效**，无需重启
- 优先级：Web 设置 > 环境变量 > 官方默认
- 接口：`GET/PATCH /api/admin/update-settings`（PATCH 必须带 `x-requested-with: suenmusic` CSRF 头；Bearer 403）

## 五、运维自检

```bash
# 1. 看缓存
ls -la data/updates/harmony/           # 应有 SuenMusic-v*-release.hap + latest.json

# 2. 检查接口（需要登录）
curl -H "Authorization: Bearer $AT" \
  "http://127.0.0.1:3210/api/update/check?platform=harmony&version_name=1.6.0&version_code=0"

# 3. 断点续传
TOK=<check 返回的 downloadToken>
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" -H "Range: bytes=0-1048575" \
  "http://127.0.0.1:3210/api/update/download?platform=harmony&token=$TOK"   # 期望 206 1048576
```

## 六、故障对照

| 返回 | 含义 | 处理 |
|---|---|---|
| `update_not_configured` | `SOURCE=off` 或没配任何源 | 配 `GITHUB_REPO` 或 `SHARE_ID` |
| `update_upstream_failed` | GitHub API 失败（404 → 仓库名写错；403 → 限流，配 token） | 看 message 里的 HTTP 码 |
| `update_not_ready` | 缓存里没有产物（首次拉取未完成或 release 里没有对应扩展名） | 等轮询完成；确认 asset 名符合约定 |
| 416 | Range 起点越界 | 正常，客户端应重取完整下载 |
## 九、设计取舍记录

### 9.1 为什么"服务端拉取"而不是客户端直连

| 方案 | 问题 |
|---|---|
| 客户端直连 GitHub Releases | 国内访问 `objects.githubusercontent.com` 不稳；鸿蒙/iOS 走系统浏览器/侧签工具**发不出鉴权头** |
| 客户端解析 GitHub API | 同上，还要在客户端维护限流逻辑 |
| **服务端拉取并缓存**（现行） | 上游只被服务端访问；客户端从自己服务器下载，可鉴权、可限流、支持 Range |

### 9.2 代理实现改了两次

| 版本 | 做法 | 为什么换掉 |
|---|---|---|
| v1 | URL 前缀镜像（`gh-proxy.com/` + 原始 URL）| 用户纠正：**"我说的代理是 http 或者 socks5 代理，不是加速镜像代理"** —— 镜像 = 第三方转写，有篡改面 |
| **v2（现行）** | **undici `ProxyAgent` 网络层代理**：HTTP(S)（CONNECT 隧道），API 与下载共用一条，URL 原样 | 真正的出站代理；对 GitHub 而言请求方是代理出口 |

按更新通道**隔离** dispatcher：AI 调用、B 站取流不被更新代理牵连（代理挂了不能全站出站跟着死）。
SOCKS5 曾实现后按用户要求移除（"先删掉 socks5，只有一个填写框"）。

### 9.3 运行时设置存 DB 而不是环境变量（用户纠正）

第一版把代理放 env 是错的 —— 代理是**管理员随时想调的行为**，不是部署机密。
现在：Web 管理页（`AdminUpdateChannel.vue`）→ `app_settings` 表（键 `update_proxy`）→ 改完即生效。
env 只留部署层：PAT、缓存目录、轮询间隔。仓库地址有默认值（`sunriseqis/suenmusic`，公开仓库），
`SOURCE` 默认 `github` —— **部署时 .env 什么都不用填**。

### 9.4 调试提醒

验证代理/来源这类配置**必须先杀掉旧进程**：曾因旧服务端仍占 3210，
请求打到旧进程（默认 ugreen 源），差点得出"配置没生效"的错误结论。

## 十、待验证（滞后到收尾阶段，用户口径）

仓库尚无任何 Release（`api.github.com/repos/.../releases` 稳定 404 —— 无 Release 的仓库就是 404）。
等第一个 `SuenMusic-v*-release.hap` 出现后跑三连：

1. `check`（force）→ `available: true` + latest 版本正确
2. `download` 整包 → sha256 与源一致
3. `download` Range → 206 + 字节数正确

