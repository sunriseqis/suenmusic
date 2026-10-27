# 更新通道（GitHub 源 → 服务端缓存 → 客户端/套件更新）

> 代码：
> - `server/src/services/github-update.ts`（Release 轮询拉取与缓存）
> - `server/src/services/deploy-mode.ts`（Docker / fnOS 部署环境判定）
> - `server/src/routes/update.ts`（更新与下载 HTTP 路由）
> - `web/src/components/AdminUpdateChannel.vue`（Web 管理端界面）

## 一、架构设计：为什么是"服务端拉取、客户端连服务端"

| 方案 | 问题 |
|---|---|
| 客户端直连 GitHub Releases | 国内访问 `objects.githubusercontent.com` 极不稳定；鸿蒙与 iOS 客户端走系统浏览器/侧签工具，**发不出鉴权头** |
| 客户端自己解析 GitHub API | 在各端重复维护 API 查询逻辑、面临未认证 60 次/小时严格限流 |
| **服务端拉取并缓存（现行方案）** | 上游 GitHub 仅由服务端请求；服务端统一下载至本地缓存，手机端和 Web 端直接连自己家庭局域网服务器下载，支持 Range 断点续传、出站代理统一配置 |

---

## 二、部署方式区分策略（2026-10-27 裁定）

服务端根据运行环境自动识别部署模式（`deployMode`）：

| 部署形态 | 识别特征 | 服务端行为 | Web 端交互 |
|---|---|---|---|
| **飞牛原生套件 (`fnos`)** | `SUENMUSIC_DEPLOY_ENV=fnos` 或存在 `TRIM_APPDEST` / `TRIM_PKGVAR` | 自动从 GitHub Release 轮询拉取 `suenmusic-vX.Y.Z.fpk` 缓存到本地 | 提示新版本与文件体积，提供**「下载飞牛套件更新包 (.fpk)」**按钮；引导在飞牛应用中心「手动安装」上传覆盖升级 |
| **Docker 容器 (`docker`)** | `SUENMUSIC_DEPLOY_ENV=docker` 或存在 `/.dockerenv`（非 fnOS 默认） | **不下载** `.fpk` 文件（杜绝无意义磁盘与带宽浪费）；仅轻量比对 Release Tag 版本号 | **仅提示更新**并显示最新版本号；展示 Docker 更新命令（`docker compose pull && docker compose up -d`）与容器面板操作指引，**不显示下载按钮** |

> **注意**：移动双端（HarmonyOS `.hap` 与 iOS `.ipa`）的产物拉取不受部署模式影响；无论服务端以 Docker 还是 fnOS 套件部署，双端移动客户端均正常通过服务端拉取更新。

---

## 三、配置项

### 3.1 环境变量（部署层）

发行产物统一发布在公开仓库 `sunriseqis/suenapp`，未认证即可通过 API 轮询（60次/小时）。

```ini
SUENMUSIC_UPDATE_GITHUB_REPO=sunriseqis/suenapp   # 发行资产公开仓库
SUENMUSIC_UPDATE_GITHUB_TOKEN=                    # 可选：配置 PAT 提额到 5000/小时
SUENMUSIC_UPDATE_GITHUB_API_BASE=                 # 可选：GitHub API 国内反代基地址
SUENMUSIC_UPDATE_CACHE_DIR=./data/updates         # 持久化缓存目录（Docker 需挂卷，fnOS 指到 @appdata）
SUENMUSIC_UPDATE_POLL_MINUTES=30                  # 轮询间隔（分钟，0 = 仅手动点击时核对）
SUENMUSIC_DEPLOY_ENV=                             # 可选：docker / fnos，缺省按环境自动探测
```

### 3.2 Web 管理端（设置 → 高级 → 更新通道）

* 仅 Web 面板管理员可见（Cookie 会话鉴权 + CSRF 保护）。
* **版本状态**：展示当前运行版本（如 `v2.0.0`）及环境标签（`飞牛套件` / `Docker 容器`），提供「检查更新」按钮。
* **出站代理**：支持直连与标准 HTTP 代理（支持认证凭据，如 `http://user:pass@127.0.0.1:7890`）。
  * 代理基于 undici `ProxyAgent`，API 请求与产物二进制下载均走统一出站代理。
  * 保存时严格校验：直连模式下代理地址必须清空，HTTP 代理必须携带合法 URL。

---

## 四、产物命名约定

```
Release tag  = v2.0.0                      # 或各端前缀如 hw-v2.0.0
Asset 文件名 = suenmusic-2.0.0.hap        # 鸿蒙端
              suenmusic-2.0.0.ipa        # iOS 端
              suenmusic-2.0.0.fpk        # 飞牛原生套件
```

* 服务端按文件名后缀映射平台（`.hap` → `harmony`，`.ipa` → `ios`，`.fpk` → `fnos`）。
* 版本比对规则：按 Semver 进行版本名称比对；最新产物下载后，历史旧版本产物自动清理，仅保留最新一份。

---

## 五、HTTP 接口体系

### 1. 服务端自身版本检查（Web 端使用）
```http
GET /api/admin/server-update?force=1
```
* **鉴权**：Web 管理员 Cookie 会话。
* **返回**：
  ```json
  {
    "available": true,
    "currentVersion": "2.0.0",
    "latestVersion": "2.1.0",
    "deployMode": "fnos",
    "artifact": {
      "fileName": "suenmusic-2.1.0.fpk",
      "size": 62029898,
      "downloadToken": "<短期令牌>",
      "downloadPath": "/api/update/download"
    }
  }
  ```
  *(注：Docker 部署模式下 `artifact` 为 `null`)*。
* **兼容保障**：Web 端在遭遇未重启的老版服务端（404）时，会自动降级调用 `/api/update/check?platform=fnos`，保证 UI 不报错。

### 2. 客户端更新检查（移动双端与外部调用）
```http
GET /api/update/check?platform=harmony&version_name=2.0.0&version_code=2000000
```
* **鉴权**：登录用户 Bearer Token。
* 默认读本地缓存 `latest.json`，带 `force=1` 时向上游 GitHub 核对。

### 3. 产物二进制下载（支持断点续传）
```http
GET /api/update/download?platform=fnos&token=<downloadToken>
```
* **鉴权**：支持 `token` URL 参数（短期免登令牌，提供给系统浏览器或安装器），或标准 `Authorization: Bearer`。
* **断点续传**：支持 HTTP `Range: bytes=start-end`，返回 `206 Partial Content`；起点越界返回 `416`。

---

## 六、CI/CD 构建与发行流程

* **公开仓库**：产物统一汇聚于 `sunriseqis/suenapp` 的 Releases。
* **鸿蒙端构建**：`.github/workflows/build-harmony.yml`
  * 产出 `suenmusic-vX.Y.Z.hap`。
* **飞牛套件构建**：`.github/workflows/build-fnos.yml`
  * 打包自包含 Node 运行时与 Web SPA 静态资源，产出 `suenmusic-vX.Y.Z.fpk`。
* **发布说明合并**：通过 `scripts/prepare-release-notes.mjs` 增量合并各端 Release 说明，防止多次多端构建时说明文本重复追加。

---

## 七、运维自检与常见问题排查

### 1. 验证接口与缓存
```bash
# 查看本地缓存目录
ls -la data/updates/fnos/
ls -la data/updates/harmony/

# 检查健康与版本
curl http://127.0.0.1:3210/api/health
```

### 2. 路由提示 404 / 接口不存在
* **原因**：本地后台以 `systemd` 或守护进程驻留时，修改 TypeScript 源码并不会自动重载进程。
* **排查与解决**：
  ```bash
  systemctl restart suenmusic
  ```
