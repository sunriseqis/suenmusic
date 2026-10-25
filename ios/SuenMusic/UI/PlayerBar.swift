import SwiftUI

/**
 * 迷你播放条 —— 结构/交互对齐 hw `pages/NativeRoot.ets` 的 `playerBar()`。
 *
 * - 封面 + 曲名/歌手 + 红心 + 播放暂停 + 下一首；整条顶部内嵌 2pt 进度条
 * - 整条点击 → 展开播放页（onExpand，调用点不变）
 * - 水平拖拽切歌：|dx| ≥ Dim.miniSwipeTh 触发（左滑下一首 / 右滑上一首），
 *   位移钳制 ±Dim.miniDragClamp，松手回弹 Motion.curve
 * - 手势结束 Motion.clickGuard 内的合成点击被吞掉，不展开播放页（hw MINI_CLICK_GUARD_MS）
 *
 * 颜色只走 Palette，尺寸只走 Dim，动效只走 Motion（零裸色零裸数值）。
 */
struct PlayerBar: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme
    /// 点击条身展开播放页（RootView 调用点签名不变）
    let onExpand: () -> Void

    /// 当前曲收藏态（切歌后异步刷新，hw refreshBarFav 同口径）
    @State private var favored = false
    /// 拖拽实时位移（钳制 ±Dim.miniDragClamp，hw `miniDragX`）
    @State private var dragX: CGFloat = 0
    /// 最近一次手势结束时刻：吞掉手势后的合成点击，防误开播放页
    @State private var lastSwipeEndAt = Date.distantPast

    private var p: Palette { Palette(scheme) }

    /// 进度条比例 0...1（hw barProgressPct：总时长未知时 0，超界钳到两端）
    private var progress: CGFloat {
        guard player.durationMs > 0 else { return 0 }
        let ratio = CGFloat(player.positionMs) / CGFloat(player.durationMs)
        return min(1, max(0, ratio))
    }

    var body: some View {
        if let track = player.currentTrack {
            VStack(spacing: 0) {
                mainRow(track)
                // hw NativeRoot.ets:433 注释「底部内嵌进度条」—— 按 hw 放底部，不放顶部
                progressBar
            }
            .background(p.panel)
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous)
                    .strokeBorder(p.line, lineWidth: Dim.hairline)
            }
            .offset(x: dragX)
            .contentShape(Rectangle())
            .onTapGesture(perform: expand)
            // 用 simultaneous 而不是 .gesture：后者会让点击**等拖拽识别失败**后才触发，
            // 观感就是「点完要等一小下才展开」（用户实测“不跟手”）。
            .simultaneousGesture(swipe)
            .task(id: track.id) { await refreshFav(track.id) }
            .padding(.horizontal, Dim.s3)
            .padding(.top, Dim.s2)
        }
    }

    // MARK: - 顶部内嵌进度条（底 line + accent 填充）

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                p.line
                p.accent.frame(width: geo.size.width * progress)
            }
        }
        .frame(height: Dim.miniProgressH)
    }

    // MARK: - 主行：封面 / 曲名+歌手 / 红心 / 播放暂停 / 下一首

    private func mainRow(_ track: Track) -> some View {
        HStack(spacing: Dim.s3) {
            cover(track)

            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(track.name)
                    .font(.system(size: Dim.fsSub, weight: .medium))
                    .foregroundStyle(p.text1)
                    .lineLimit(1)
                // 对齐 hw：手动点播到没有音源的曲目时，第二行显示「无音源」
                //（np_error 同口径），曲名不换、也不弹任何按钮。
                Text(player.noSource ? PlaybackService.noSourceLabel : track.artistLine)
                    .font(.system(size: Dim.fsCaption))   // hw NativeRoot.ets:399 用 fsCaption
                    .foregroundStyle(player.noSource ? p.danger : p.text2)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            // hw 迷你条只有 红心 + 播放/暂停（L408-425：「播放键必须留在条上」），没有下一首键
            heartButton(track)
            playPauseButton
        }
        .padding(.horizontal, Dim.s3)
        .padding(.vertical, Dim.s2)
    }

    private func cover(_ track: Track) -> some View {
        AsyncImage(url: URL(string: track.al.picUrl)) { img in
            img.resizable().scaledToFill()
        } placeholder: {
            Rectangle().fill(p.panel2)
        }
        .frame(width: Dim.coverMini, height: Dim.coverMini)   // hw coverMini = 42
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous))
    }

    // MARK: - 键（hw：红心 fav-on 点亮 accent，播放键必须留在条上）

    private func heartButton(_ track: Track) -> some View {
        Button {
            Task { await toggleFav(track) }
        } label: {
            Image(systemName: favored ? "heart.fill" : "heart")
                .font(.system(size: Dim.iconSm))   // hw：boxSize 28 → 字形 15
                .foregroundStyle(favored ? p.accent : p.text2)
                .frame(width: Dim.btnSm, height: Dim.btnSm)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(favored ? "取消收藏" : "收藏")
    }

    private var playPauseButton: some View {
        Button { player.toggle() } label: {
            Image(systemName: player.playing ? "pause.fill" : "play.fill")
                .font(.system(size: Dim.icon18))   // hw：boxSize 36 → 字形 18
                .foregroundStyle(p.text1)
                .frame(width: Dim.btnMd, height: Dim.btnMd)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(player.playing ? "暂停" : "播放")
    }

    // MARK: - 左右滑切歌（hw PanGesture 同口径）

    private var swipe: some Gesture {
        DragGesture(minimumDistance: Dim.s3)
            .onChanged { value in
                // hw PanDirection.Horizontal：只有水平分量参与位移
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                dragX = min(max(value.translation.width, -Dim.miniDragClamp), Dim.miniDragClamp)
            }
            .onEnded { value in
                let dx = value.translation.width
                let horizontal = abs(dx) > abs(value.translation.height)
                // hw snapMiniBack 用 Motion.fast(100ms)，不是 200ms
                withAnimation(.easeOut(duration: Motion.fast)) { dragX = 0 }
                guard horizontal else { return }
                lastSwipeEndAt = Date()
                guard abs(dx) >= Dim.miniSwipeTh else { return }
                if dx < 0 {
                    player.next()
                } else {
                    player.prev()
                }
            }
    }

    // MARK: - 点击展开（滑动刚结束的合成点击不展开，hw swiped 旗标同语义）

    private func expand() {
        guard Date().timeIntervalSince(lastSwipeEndAt) >= Motion.clickGuard else { return }
        onExpand()
    }

    // MARK: - 收藏（先动视觉，失败回滚 + 轻提示，hw toggleBarFav 同口径）

    private func refreshFav(_ id: String) async {
        guard !id.isEmpty else {
            favored = false
            return
        }
        favored = await player.isFavored(id)
    }

    private func toggleFav(_ track: Track) async {
        let was = favored
        favored = !was
        guard let next = await player.toggleFavorite(track) else {
            favored = was
            ToastCenter.shared.show("收藏操作失败，请稍后重试")
            return
        }
        favored = next
    }
}
