# 开发循环：live reload

## 为什么不能"就在浏览器里调"

直连链路（QQ 搜索、B站解析、取流）跑在**原生 HTTP**（CapacitorHttp）上：

- 上游不回 CORS 头，浏览器 `fetch` 必被拦
- `Referer` / `Cookie` 是 fetch 的禁止头，浏览器发不出去

所以浏览器只能调 UI 和纯本地逻辑，搜索/播放一定失败。
但每改一行就 `build → cap sync → gradle → install` 要一分多钟，也不现实。

## 解法：让 WebView 指到 Vite dev server

一次性构建（约 1 分钟）：

```bash
cd web
SUEN_LIVE_URL=http://<本机局域网IP>:5273 npx cap sync android
cd ../android
./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
```

之后只要保持 dev server 在跑：

```bash
cd web
SUENMUSIC_WEB_HOST=0.0.0.0 npm run dev
```

改代码 → HMR 自动刷新，**仍然是原生环境**（`Capacitor.isNativePlatform()` 为 true，
`SuenAudio` / `CapacitorHttp` 全部可用）。

## 三个必须知道的限制

1. **页面源变了**：从 `http://localhost` 变成 dev server 地址。
   WebView 的 localStorage / IndexedDB **按 origin 隔离** ——
   用 live reload 看到的是另一套（空的）本地数据。
   验证"红心/续播持久化"要用不带 `SUEN_LIVE_URL` 的正式包。

2. **只省 web 的循环**：改了 Java / 插件 / `capacitor.config` 仍然要重新 `cap sync` + 编译。

3. **出正式包要清掉这个变量**：
   ```bash
   cd web && npx cap sync android   # 不带 SUEN_LIVE_URL
   ```
   否则 APK 会一直去连开发机，装到别的手机上直接白屏。

## 取本机 IP

```bash
ip -4 addr show | grep -oP 'inet \K[\d.]+' | grep -v 127.0.0.1
```

（这台机器是 `192.168.89.11`；别照抄，会和别的环境对不上。）
