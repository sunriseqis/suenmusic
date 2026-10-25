import SwiftUI

/**
 * 公共曲目行（hw `TrackItem` 的 iOS 等价物）：序号 / 封面 / 曲名 / 歌手 / 在播高亮 / 右滑收藏。
 *
 * 单行 `Dim.rowHeight`（56）—— **不是** web 的三行布局；数值逐项对齐
 * `hw/entry/src/main/ets/pages/TrackItem.ets`。点歌统一由父级传 `onTap`（本组件不碰播放状态机）。
 * 右滑过阈值回调 `onSwipeToggle`：普通页 = 切换收藏并弹回；收藏页传
 * `swipeRemoveOnUnfavorite`，先滑出 360、动画走完再回调（父级随后剪行）；回调返回
 * false 或抛错则弹回 0。
 */
struct TrackRow: View {
    /// 阻尼起点之后的位移放大系数（hw SWIPE_DAMP_FACTOR）
    private static let dampFactor: CGFloat = 0.25
    /// 在播薄染浓度（hw CUR_TINT，= web color-mix(accent 7%, panel)）
    private static let playingTint: Double = 0.07

    private let track: Track
    private let index: Int
    private let coverSize: CGFloat
    private let isFav: Bool
    private let markFav: Bool
    private let swipeRemoveOnUnfavorite: Bool
    private let dislikeable: Bool
    private let showDur: Bool
    private let playing: Bool
    private let onTap: () -> Void
    private let onSwipeToggle: (() async -> Bool)?
    private let onDislike: (() -> Void)?

    /// 右滑实时位移（已阻尼）
    @State private var swipeX: CGFloat = 0
    /// 已过阈值、行正在滑出（收藏页随后由父级剪行）
    @State private var vanishing = false
    /// 最近一次手势结束时刻：其后 `Motion.clickGuard` 内的点击一律吞掉
    @State private var lastSwipeEnd = Date.distantPast

    init(track: Track, index: Int, coverSize: CGFloat = Dim.coverBar,
         isFav: Bool, markFav: Bool = true, swipeRemoveOnUnfavorite: Bool = false,
         dislikeable: Bool = false, showDur: Bool = true, playing: Bool = false,
         onTap: @escaping () -> Void,
         onSwipeToggle: (() async -> Bool)? = nil,
         onDislike: (() -> Void)? = nil) {
        self.track = track
        self.index = index
        self.coverSize = coverSize
        self.isFav = isFav
        self.markFav = markFav
        self.swipeRemoveOnUnfavorite = swipeRemoveOnUnfavorite
        self.dislikeable = dislikeable
        self.showDur = showDur
        self.playing = playing
        self.onTap = onTap
        self.onSwipeToggle = onSwipeToggle
        self.onDislike = onDislike
    }

    var body: some View {
        ZStack(alignment: .leading) {
            swipeAction
            content
                .background(DesignTokens.bg) // 必须不透明：下面就是动作区
                .overlay {
                    // 在播薄染层：铺满整行且盖在内容之上，**必须不吃点击**
                    //（hw 曾因它挡住行尾按钮）
                    if playing {
                        DesignTokens.accent
                            .opacity(Self.playingTint)
                            .allowsHitTesting(false)
                    }
                }
                .overlay(alignment: .leading) {
                    // 左沿 2pt 在播条（hw 里这条在薄染层之上）
                    if playing { Rectangle().fill(DesignTokens.accent).frame(width: Dim.s0) }
                }
                .overlay(alignment: .bottom) {
                    Rectangle().fill(DesignTokens.line).frame(height: Dim.hairline)
                }
                .offset(x: swipeX)
        }
        .frame(height: Dim.rowHeight)
        // hw 的行是**直角**：只有底沿一条发丝线（TrackItem.ets:260-271 的 border 只设 left/bottom，
        // 外层只 clip(true)，没有 borderRadius）；圆角只属于右滑动作区。
        // 之前这里套了 radiusMd，列表看起来就是「每行一个圆角卡片」（用户实测 web/hw 都没有）。
        .clipped()
        .contentShape(Rectangle())
        .onTapGesture { handleTap() }
        // 右滑收藏改由调用方的 `List` + `.swipeActions` 提供（方向仲裁由系统做）。
    }

    // MARK: - 底层右滑动作区

    private var actionInk: Color {
        isFav ? DesignTokens.swipeFavInk : DesignTokens.swipeInk
    }

    private var swipeAction: some View {
        HStack(spacing: Dim.s1) {
            WebIcon(isFav ? .heartFilled : .heart, size: Dim.iconSm)
                .foregroundStyle(actionInk)
            Text(isFav ? "取消收藏" : "收藏")
                .font(.system(size: Dim.fsBody, weight: .medium))
                .foregroundStyle(actionInk)
        }
        .padding(.leading, Dim.s5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(isFav ? DesignTokens.swipeFavBg : DesignTokens.accentText)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd))
    }

    // MARK: - 上层行内容

    private var content: some View {
        HStack(spacing: Dim.s2) {
            indexColumn
            cover
            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(track.name)
                    .font(.system(size: Dim.fsSub, weight: playing ? .medium : .regular))
                    .foregroundStyle(playing ? DesignTokens.accentText : DesignTokens.text1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(track.artistLine)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(DesignTokens.text2)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.horizontal, Dim.s2)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var indexColumn: some View {
        // hw：index < 0 不显示序号列
        if index >= 0 {
            if playing {
                PlayingBars().frame(width: Dim.seqW)
            } else {
                Text(String(index))
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(isFav && markFav ? DesignTokens.accent : DesignTokens.text2)
                    .frame(width: Dim.seqW, alignment: .center)
            }
        }
    }

    private var cover: some View {
        AsyncImage(url: URL(string: track.al.picUrl)) { phase in
            if let img = phase.image {
                img.resizable().scaledToFill()
            } else {
                // picUrl 为空或加载失败：音符占位（hw 用 app_icon 兜底）
                ZStack {
                    DesignTokens.panel2
                    Image(systemName: "music.note")
                        .font(.system(size: Dim.fsTitle))
                        .foregroundStyle(DesignTokens.text2)
                }
            }
        }
        .frame(width: coverSize, height: coverSize)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusSm))
    }

    @ViewBuilder
    private var trailing: some View {
        if dislikeable {
            dislikeButton
        } else if showDur {
            Text(Self.durationText(track.dt))
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(DesignTokens.text2)
                .frame(width: Dim.durW, alignment: .trailing)
        }
    }

    /// 行尾「不喜欢」：按下染 accent，默认 text2；按钮自带命中区，点击不冒泡切歌。
    /// 图标与播放页统一用「斜杠爱心」（用户 2026-10-25 指定），字形保持 hw 的 16pt。
    private var dislikeButton: some View {
        Button { onDislike?() } label: {
            WebIcon(.heartSlash, size: Dim.icon16)
        }
        .buttonStyle(DislikeButtonStyle(active: DesignTokens.accent, idle: DesignTokens.text2))
        .padding(.horizontal, Dim.s2) // 内边距在框内，命中区 minWidth 44（hw 同序）
        .frame(minWidth: Dim.touchMin, maxHeight: .infinity)
        .accessibilityLabel("不喜欢")
    }

    // MARK: - 手势状态机

    /// 只认右滑：左滑位移归 0、不消耗；竖直占优让位给列表滚动
    ///（等价 hw `PanDirection.Horizontal` 的手势仲裁）。
    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: Dim.swipeGate)
            .onChanged { value in
                guard !vanishing else { return }
                let dx = value.translation.width
                let dy = value.translation.height
                guard abs(dx) > abs(dy) else { return }
                guard dx > 0 else {
                    swipeX = 0
                    return
                }
                swipeX = dx > Dim.swipeDampAt
                    ? Dim.swipeDampAt + (dx - Dim.swipeDampAt) * Self.dampFactor
                    : dx
            }
            .onEnded { _ in endSwipe() }
    }

    private func endSwipe() {
        // DragGesture 没有 cancel 回调：滑到左向时 swipeX 已被上面的 guard 归 0，
        // 过不了阈值 → 只弹回、绝不当作已触发，等价 hw 的 onActionCancel 语义。
        lastSwipeEnd = Date()
        guard !vanishing else { return }
        guard swipeX >= Dim.swipeThreshold else {
            animateSwipe(to: 0)
            return
        }
        if swipeRemoveOnUnfavorite && isFav {
            // 收藏页：先滑出去，动画走完再让父级改状态剪行（顺序反了看不到滑出）
            vanishing = true
            animateSwipe(to: Dim.swipeOut)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(Motion.standard))
                guard let toggle = onSwipeToggle else {
                    vanishBack()
                    return
                }
                let removed = (try? await toggle()) ?? false
                if !removed { vanishBack() }
            }
            return
        }
        // 普通页：行留在原地，弹回后由序号染色 / 动作区文案确认结果
        if let toggle = onSwipeToggle {
            Task { @MainActor in _ = await toggle() }
        }
        animateSwipe(to: 0)
    }

    private func vanishBack() {
        vanishing = false
        animateSwipe(to: 0)
    }

    private func animateSwipe(to x: CGFloat) {
        withAnimation(Motion.curve) { swipeX = x }
    }

    private func handleTap() {
        // 手势刚结束的合成点击一律吞掉，避免滑完就误触切歌
        if Date().timeIntervalSince(lastSwipeEnd) < Motion.clickGuard { return }
        onTap()
    }

    // MARK: - 时长文案

    /// hw `formatDuration` 同口径：m:ss，≥1 小时 h:mm:ss，向下取整秒，非法值 0:00
    private static func durationText(_ ms: Int) -> String {
        guard ms > 0 else { return "0:00" }
        let total = ms / 1000
        let sec = total % 60
        let min = (total / 60) % 60
        let hour = total / 3600
        let pad: (Int) -> String = { $0 < 10 ? "0\($0)" : String($0) }
        return hour > 0 ? "\(hour):\(pad(min)):\(pad(sec))" : "\(min):\(pad(sec))"
    }
}

/// 按钮按下态取色（用 ButtonStyle 的 isPressed，不额外引入按压手势去和行手势抢）
private struct DislikeButtonStyle: ButtonStyle {
    let active: Color
    let idle: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(configuration.isPressed ? active : idle)
    }
}
