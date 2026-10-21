# 飞牛 fnOS 套件：构建与运维

> 打包实现：`scripts/build-fn.mjs`；套件本体：`fn/`；控制脚本：`fn/cmd/main`。
> 相关记忆：`docs/memory/2026-10-21-审计批次D实施记录.md`、
> `docs/memory/2026-10-20-飞牛fnOS套件工程与fpk构建交付.md`。

---

## 一、构建

```bash
npm run fn:build        # → output/suenmusic-v<版本>.fpk
```

打包时会：

1. **强制重新安装生产依赖**：`npm ci --omit=dev` 到 `fn/app/server/`，装完再校验
   `node_modules` 里没有 `typescript` / `@types`（有就拒绝出包）。
   不要改成"有 node_modules 就拷"——构建机装了 devDependencies 时会一起进包。
2. **检查前端产物是否陈旧**：`web/dist` 比 `web/src`（含 `index.html` / `vite.config.ts` /
   `package.json`）旧时强制重新 `npm run build`。只判"存在"会让新包静默带上旧前端。
3. 删除 `node_modules/.bin`：里面的软链会被 fnpack 改写成构建机绝对路径，
   fnOS 安装时 `stat` 到死链会报「设置目录权限失败」（历史踩坑）。
4. 硬校验 `fn/` 下没有软链。
5. 统一权限：目录 755 / 文件 644 / `cmd/*` 755。

产物不进库（`fn/app/{bin,server,web}` 与 `fn/*.fpk` 均在 `.gitignore` 内）。

## 二、运行时布局

官方约定见 [应用框架](https://developer.fnnas.com/docs/core-concepts/framework/)：
安装后是 `/var/apps/{appname}`，其中 `target` → `@appcenter`、`etc` → `@appconf`、
`var` → `@appdata`、`home` → `@apphome`。**路径一律走 `TRIM_*` 环境变量，不要硬编码。**

| 路径 | 内容 | 生命周期 |
|---|---|---|
| `${TRIM_APPDEST}` | 包安装目录（`server/` `web/dist/` `bin/node` `cmd/`） | 升级时**整体替换** |
| `${TRIM_PKGVAR}/data/` | `suenmusic.db`、`jwt.secret` | 升级/卸载后**保留**（私有） |
| `${TRIM_PKGETC}/.env` | 用户配置（**配置属于 etc，不是 var**） | 保留 |
| `${TRIM_PKGETC}/env.example` | 首次启动自动写出的配置模板 | 保留 |
| `${TRIM_DATA_SHARE_PATHS}` | 备份输出目录（`suenmusic/backup` 共享目录） | 保留，**文件管理器可见** |
| `${TRIM_PKGVAR}/info.log` | 运行日志（>8MB 自动轮转为 `info.log.1`） | 保留 |
| `${TRIM_PKGVAR}/app.pid` | 守护进程 `pid starttime` | 运行时 |
| `${TRIM_PKGVAR}/app.child.pid` | 服务进程 pid | 运行时 |

### 为什么数据库不放共享目录

`config/resource` 声明了 `data-share: suenmusic/backup`，**只把备份放进去**：

- 共享目录在文件管理器里可见、可拷走、可外部导入导出 —— 备份正是要这个能力；
- 数据库本体留在 `var`（`@appdata`）私有区 —— 用户在文件管理器里误删/误改 SQLite
  是永久性损坏，而备份文件坏了重跑一次就行。

启动日志第一行会打出四个目录，装完先看这一行就能确认落点：
`安装目录=… 数据目录=… 配置目录=… 备份目录=…`

## 三、启停与状态

```bash
fn/cmd/main start     # 拉起守护进程（内部 __supervise 模式）
fn/cmd/main stop      # 置停止标志 → TERM 守护 → 补收子进程 → 校验端口释放
fn/cmd/main status    # PID（含启动时间校验）或端口任一命中即视为运行中，退出码 0/3
```

- **守护**：服务进程崩溃/OOM 后 5 秒自动重启（`checkport = true` 以前会让应用中心
  以为服务还活着，实际早已退出）。
- **PID 校验**：PID 文件记录 `pid + starttime`（`/proc/<pid>/stat` 第 22 字段），
  PID 被复用时不误杀。
- **升级**：`upgrade_init` 先 `stop`（并等端口真正释放），`upgrade_callback` 再 `start`
  并打一次 `/api/health` 把版本号记进 `info.log`。以前两个回调都是裸 `exit 0`，
  结果升级后跑的还是旧进程。

## 四、密钥与数据库

- `SUENMUSIC_JWT_SECRET` 由 `fn/cmd/main` 首次启动时生成并写入
  `${TRIM_PKGVAR}/data/jwt.secret`（600），之后每次复用。
  **不落盘的后果**：每次重启/升级都换密钥 → 访问令牌与 6 小时流令牌全废，
  原生端被迫重登、正在播的歌会中断。
- 数据库固定落在 `${TRIM_PKGVAR}/data/suenmusic.db`，升级不会覆盖。

## 五、备份

- 共享目录（文件管理器可见）：`suenmusic/backup/`，由 `config/resource` 的
  `data-share` 声明，`main` 用 `TRIM_DATA_SHARE_PATHS` 取到并导出为
  `SUENMUSIC_BACKUP_DIR`；取不到时退回 `${TRIM_PKGVAR}/data/backups`（私有）。
- 手动备份：`npm run db-backup`（`SUENMUSIC_BACKUP_KEEP` 默认保留 14 份）。
- 手动备份时**同样要显式指 DB 与备份目录**（见下一节），否则会备份到包安装目录里的空库。

## 六、⚠️ 命令行运维必须显式指定数据库

在套件目录里直接跑 CLI（建号、备份、打标等）时，**必须把 `SUENMUSIC_DB` 指到
持久化目录**，否则会按默认相对路径在包安装目录里新建一个空库 ——
看起来"命令执行成功"，实际上数据写进了升级时会被整体替换的地方：

```bash
cd "${TRIM_APPDEST}/server"
export SUENMUSIC_DB="${TRIM_PKGVAR}/data/suenmusic.db"
"${TRIM_APPDEST}/bin/node" --experimental-strip-types \
  --disable-warning=ExperimentalWarning src/scripts/user-add.ts <用户名> <口令>
```

备份同理（`src/scripts/db-backup.ts`）。Web 面板里的「备份/恢复」不受影响
（服务端进程自己带着正确的 `SUENMUSIC_DB`）。

## 七、网络与端口

- `SUENMUSIC_HOST=0.0.0.0`：套件内没有反代，必须绑全地址，否则手机端连不上
  （而 `checkport` 探 `127.0.0.1` 仍然通，问题很隐蔽）。
- `SUENMUSIC_TRUST_PROXY=false`：直连形态，不能采信 `X-Forwarded-For`，
  否则登录节流可被伪造 IP 绕过。
- 端口 3210，与 `fn/manifest` 的 `service_port` 保持一致。
