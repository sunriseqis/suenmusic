# 品牌图标母版

橙色底白色波浪的品牌标记源文件。**改图标从这里改**，改完再同步到各端：

| 文件 | 用途 |
|---|---|
| `ic_launcher_foreground.svg` | Android 自适应图标前景（波浪） |
| `ic_launcher_background.svg` | Android 自适应图标背景（橙底） |
| `ic_launcher_monochrome.svg` | Android 13+ 单色图标（取色后纯白） |
| `wordmark-dark.svg` / `wordmark-light.svg` | 带字标的横版标识 |
| `ic_launcher_{48,72,96,144,192,512}.png` | 渲染产物，供文档 / 安卓 / fnOS 用 |

母版大图在 `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`
（iOS 商店要求 1024 无Alpha，因此它是唯一的大尺寸 PNG 母版；fnOS 的
`fn/ICON.PNG` / `fn/ICON_256.PNG` 由它 LANCZOS 重采样生成）。

> 这套文件原先只存在于旧仓 `suenmusic-server/docs/icon/`（从 `android-icon/`
> 移入），本仓此前只有渲染产物。2026-10-20 复制进来，保证品牌资产自包含。
