# 品牌图标母版

品牌标记：**实心折角 S（MarkBold）**，段 0 染琥珀。2026-10-20 定稿，
取代此前的「橙底白色音浪」。

## 改字形只改一个地方

```
web/src/components/brand/MarkBold.vue     字形路径 P1~P4（唯一来源）
        ↓  改完重跑
scripts/gen-brand-icons.py                全端图标 + 启动图 + 本文档目录的母版
```

配色固定（图标不跟随主题）：

```
底板 #17181B   蚀刻边 #2A2C30   字 #E9E7E2   段0 琥珀 #E8A33D
```

## 脚本产物

| 位置 | 内容 |
|---|---|
| `web/public/` | favicon.svg / favicon-16/32/192/512.png / apple-touch-icon.png / favicon.ico |
| `ios/App/App/Assets.xcassets/AppIcon.appiconset/` | AppIcon-1024.png |
| `android/app/src/main/res/` | adaptive（背景色 + vector 前景 + monochrome）+ 各密度 mipmap PNG |
| `ios/…/Splash.imageset/`、`android/…/drawable*/splash.png` | 启动图：深色底 + 居中标记 |
| `fn/` | ICON.PNG(64) / ICON_256.PNG(256) / app/ui/images/icon_*.png |
| `docs/icon/`（本目录） | 母版 SVG + 渲染 PNG，供文档与外部使用 |

原生工程里的 `ios/App/App/public/` 与 `android/app/src/main/assets/public/`
是 web/public 的副本（`cap sync` 会刷新），favicon 已同步。

## 字标

「SuenMusic」字标不用自绘 SVG，**直接用 Gunstop 字体排**
（`web/public/fonts/Gunstop.ttf`，Drizy Studio Demo，21KB，仅 114 字形）——
它本身是切角工业风，与 MarkBold 同语言。应用内入口是
`components/brand/WordMark.vue`（文本排版 + drop-shadow 拟物）。
自绘折角字标生成器（`web/scripts/gen-wordmark-angular.py`）保留未删。

## 应用内

侧边栏与登录页的品牌锁定走 `components/brand/BrandLockup.vue` →
`MarkBold`（bare 模式，不画底板，段 0 琥珀）+ `WordMark`。
主题变量 `--mark-plate / --mark-frame / --mark-glyph / --mark-accent`
定义在 `web/src/styles/tokens.css` 的两套主题里。

## 历史

- 2026-09-12 旧标「橙底音浪」定稿（LogoMark.vue / wordmark-*.svg）
- 2026-10-17 哑光硬件重构，用户提供两版 S：MarkS（细线+蚀刻外框）、
  MarkBold（实心折角）；16:46 确认段 0 染琥珀
- 2026-10-20 确认采用 MarkBold，全端图标与启动图重生成
