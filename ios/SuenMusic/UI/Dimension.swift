/**
 * 尺寸 / 间距 / 字号 / 动效常量 —— **与鸿蒙端 `common/Dimension.ets` 逐值同源**。
 *
 * 规则同 hw：页面里 padding/margin/cornerRadius/font 一律走 `Dim`，禁止裸数字（0 除外）；
 * 动效时长/曲线走 `Motion`（统一 200ms，快动效 100ms，禁止 > 300ms）。
 * 颜色只走 `DesignTokens`（经 `Palette` 按深浅取），本文件不出现颜色。
 */

import SwiftUI

enum Dim {
    // ---- 间距（4 的倍数节奏） ----
    static let s0: CGFloat = 2
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 24
    static let s6: CGFloat = 32

    // ---- 圆角 ----
    static let radiusSm: CGFloat = 6
    static let radiusRow: CGFloat = 8
    static let radiusMd: CGFloat = 12
    static let radiusPill: CGFloat = 14
    static let radiusLg: CGFloat = 16
    static let radiusAvatar: CGFloat = 22
    static let radiusTab: CGFloat = 9

    // ---- 字号 ----
    static let fsCaption: CGFloat = 11
    static let fsMinor: CGFloat = 12
    static let fsBody: CGFloat = 13
    static let fsSub: CGFloat = 14
    static let fsTitle: CGFloat = 15
    static let fsSection: CGFloat = 16
    static let fsHeadline: CGFloat = 18
    static let fsDisplay: CGFloat = 20
    static let fsHero: CGFloat = 24
    static let fsBrand: CGFloat = 28

    // ---- 行高 / 可点区域 ----
    static let rowHeight: CGFloat = 56
    static let touchMin: CGFloat = 44
    static let inputH: CGFloat = 40
    static let segH: CGFloat = 32

    // ---- 封面 / 图标 ----
    static let coverSm: CGFloat = 44
    static let coverBar: CGFloat = 40
    static let coverXl: CGFloat = 280
    static let coverReco: CGFloat = 194
    static let coverMini: CGFloat = 42
    static let icon12: CGFloat = 12
    static let icon13: CGFloat = 13
    static let icon14: CGFloat = 14
    static let icon16: CGFloat = 16
    static let icon18: CGFloat = 18
    static let iconSm: CGFloat = 15
    static let iconMd: CGFloat = 20
    static let iconLg: CGFloat = 22
    static let iconXl: CGFloat = 28

    // ---- 控件 ----
    static let btnSm: CGFloat = 28
    static let btnMd: CGFloat = 36
    static let btnBar: CGFloat = 40
    static let btnPlayW: CGFloat = 96
    static let btnPlayCircle: CGFloat = 64
    static let glowBlur: CGFloat = 60
    static let peekH: CGFloat = 58
    static let seqW: CGFloat = 26
    static let popW: CGFloat = 210
    static let miniProgressH: CGFloat = 2
    static let tabIndicatorW: CGFloat = 12
    static let tabIndicatorH: CGFloat = 2

    // ---- 哑光质感 ----
    static let hairline: CGFloat = 1
    static let posterRatio: CGFloat = 0.62
    static let posterScrimRatio: CGFloat = 0.5
    static let dot: CGFloat = 6

    // ---- 弹层 ----
    static let gripW: CGFloat = 36
    static let gripH: CGFloat = 3
    static let fieldLabelW: CGFloat = 60
    static let sheetListMax: CGFloat = 320
    static let serverListMax: CGFloat = 330

    // ---- 歌词上下留白 ----
    static let lyricPadTop: CGFloat = 120
    static let lyricPadBottom: CGFloat = 160

    // ---- 曲目行 TrackRow / 在播竖条（与 hw TrackItem.ets 逐值同源） ----
    /// 行尾时长列宽（hw DUR_W）
    static let durW: CGFloat = 46
    /// 在播竖条：条宽 / 容器高 / 三根高度（hw bar width 2、BAR_BOX、BAR_H_*）
    static let barW: CGFloat = 2
    static let barBox: CGFloat = 14
    static let barTall: CGFloat = 14
    static let barMid: CGFloat = 8
    static let barShort: CGFloat = 6
    /// 右滑手势：起步门槛 / 阻尼起点 / 触发阈值 / 滑出距离（hw SWIPE_*）
    static let swipeGate: CGFloat = 8
    static let swipeDampAt: CGFloat = 150
    static let swipeThreshold: CGFloat = 85
    static let swipeOut: CGFloat = 360
    /// 迷你播放条滑动切歌阈值（hw NativeRoot MINI_SWIPE_TH = 60px）
    static let miniSwipeTh: CGFloat = 60
    /// 迷你播放条拖拽位移上限（hw NativeRoot MINI_DRAG_CLAMP = ±80px）
    static let miniDragClamp: CGFloat = 80

    // ---- 自绘底部 Tab 栏（与 hw NativeRoot tabCell / tabSlider 同源） ----
    /// Tab 格按压下沉量（hw tabCell `translate({ y: 1 })`，与 Btn.pressDrop 同值）
    static let tabPressSink: CGFloat = 1
}

enum Motion {
    /// 交互动效统一时长（秒）：200ms
    static let standard: Double = 0.2
    /// 快动效：100ms
    static let fast: Double = 0.1
    /// 按钮按压缩放
    static let pressScale: CGFloat = 0.96
    /// Tab 切换内容轻微上移量
    static let tabLift: CGFloat = 8
    /// 全局统一曲线（hw 只允许 EaseOut / Friction）
    static let curve: Animation = .easeOut(duration: standard)
    /// 在播竖条一次单程（hw BOUNCE_MS = 1000ms，alternating 往返）
    static let barsBounce: Double = 1.0
    /// 竖条相位差 0 / 160ms / 320ms
    static let barsDelayMid: Double = 0.16
    static let barsDelayShort: Double = 0.32
    /// 手势结束后吞掉合成点击的时间窗（hw CLICK_GUARD_MS）
    static let clickGuard: Double = 0.35
    /// 播放页进出场时长：160ms（hw 的 200ms 是按它的渲染节奏定的，iOS 上 200ms 显慢）
    static let sheet: Double = 0.16
}
