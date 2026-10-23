# 2026-10-23 联调通道：SSH 到 Windows 宿主机 + 模拟器验证（配置项，不含口令）

**用途**：以后「编译 → 推包 → 装机 → 数值取证」全程可由 Lead 侧一条龙完成，不再依赖用户手动下载/安装。

> ⚠️ **口令不入库**：本仓库是公开仓库，SSH 口令/令牌一律**不写进 docs**。
> 口令由用户在会话里给出、只在本轮执行时使用；如需长期无人值守，改成公钥认证
> （Lead 侧公钥 `dsh-lead@suenmusic`，宿主机侧落到 `C:\ProgramData\ssh\administrators_authorized_keys`）。

## 一、通道参数（非敏感部分）

| 项 | 值 |
|---|---|
| 宿主机（windows，跑 DevEco + 模拟器） | `192.168.89.206`（主机名 DESKTOP-VGVMBV1） |
| SSH 用户 / 端口 | `rootwin` / 22（2026-10-23 已开启，之前只有 SMB 139/445） |
| 宿主机项目路径 | `E:\suenmusic`（同仓 git clone，可 `git pull` 同步） |
| DevEco 安装位置 | `C:\Program Files\Huawei\DevEco Studio` |
| 模拟器 | Mate 90 Pro（虚拟机），用户随时可启动；未签名 HAP 可直接装（虚拟机不校验签名） |
| Lead 侧（本机） | `192.168.89.10`，仓库 `/home/suenmusic` |

## 二、标准联调流程（通了 SSH 之后）

1. 本机编译：`cd hw && DEVECO_CLI_CLT_PATH=/opt/clt/command-line-tools devecocli build --modules entry@default`
2. 推包：`scp output/SuenMusic-*.hap rootwin@192.168.89.206:E:/suenmusic/output/`
3. 装机：宿主机上用 DevEco 自带 hdc（通常在
   `C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`，或
   `...\tools\...` 下，装前先 `hdc list targets` 确认模拟器在线）
   `hdc install -r <路径>`；拉起 `hdc shell aa start -a EntryAbility -b com.suenmusic.app`
4. **数值取证**（替代截图，解决 Lead 无法识图）：
   `hdc shell uitest dumpLayout -p /data/local/tmp/l.json` → `hdc file recv` 拉回 → 按 JSON 里的
   bounds 量尺寸/位置。注意 T11 教训：**dump 树含被盖住的隐藏层**，判「当前在哪页」仍需人确认，
   判尺寸/对齐不会错。
5. 日志：`hdc shell hilog -x | grep SuenMusic`（或 `hdc hilog`）

## 三、备选通道（SSH 未通时）

- Lead 侧 HTTP 静态服务：`python3 -m http.server 8899 --bind 0.0.0.0`（工作目录 `output/`）→
  宿主机浏览器打开 `http://192.168.89.10:8899/<hap>` 下载后本地 `hdc install`。
- SMB（139/445 一直开着）也可作为传包通道（需共享凭据）。

## 四、待办

- [ ] 长期方案：宿主机启用公钥认证（免口令），把 Lead 公钥写进 `administrators_authorized_keys` + 修 ACL。
- [ ] 首轮验证：装最新包 → 复测（音源行 / 自绘 dislike 弹窗 / 自绘 toast 位置 / 迷你条横线 / 锚定页两个图标键 / 缓存行内用量 / 提示漂移）。