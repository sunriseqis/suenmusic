import SwiftUI

/// 播放页内部浮层层键（hw `K_PLAYER_SHEET`）：同一时刻只允许一个。
/// 视觉层级从顶到底：dislike > more > queue > lyrics > 播放页本身。
enum PlayerSheet: Equatable {
    case none, lyrics, queue, more, anchor, dislike
}

/// 可指定字形色的图标键。
///
/// `WebIconButton` 的字形色由 style 定死（plain = text1），而播放页有多处
/// 「透明底 + 特定字形色」的键（模式 / 红心 / 不喜欢 / 图钉 / 搜索）。
/// 做法与 TrackRow 等页面既有写法一致：WebIcon + foregroundStyle，盒尺沿用同一张表。
struct GlyphKey: View {
    private let name: WebIconName
    private let box: CGFloat
    private let color: Color
    private let action: () -> Void

    init(_ name: WebIconName, box: CGFloat = Dim.touchMin, color: Color,
         action: @escaping () -> Void) {
        self.name = name
        self.box = box
        self.color = color
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            WebIcon(name, size: glyph)
                .foregroundStyle(color)
        }
        .buttonStyle(GlyphKeyStyle(box: box))
    }

    /// 与 WebButton 键壳同表：≤28 → 15，≤36 → 18，其余 → 21
    private var glyph: CGFloat {
        if box <= Dim.btnSm { return Dim.iconSm }
        if box <= Dim.btnMd { return Dim.icon18 }
        return Dim.iconLg
    }
}

private struct GlyphKeyStyle: ButtonStyle {
    let box: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: box, height: box)
            .background(
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .fill(configuration.isPressed ? DesignTokens.panel2 : Color.clear)
            )
            .contentShape(Rectangle())
            .animation(.easeOut(duration: Motion.fast), value: configuration.isPressed)
    }
}

/// 播放页内联尺寸（hw 播放页里内联、Dim 中没有对应档位的值）
private enum PlayerSpec {
    /// 播放键盒尺：hw 播放页内联 60（Dim.btnPlayCircle = 64，本页不用它）
    static let playKey: CGFloat = 60
    /// eyebrow 最大宽占页面比例（hw `constraintSize({ maxWidth: '60%' })`）
    static let eyebrowRatio: CGFloat = 0.6
    /// 进度条步长（hw `Slider({ step: 1000 })`，毫秒）
    static let seekStep: Double = 1000
    /// 环境光晕透明度（hw `.opacity(0.15)`）
    static let glowOpacity: Double = 0.15
    /// 歌词 peek 非当前行透明度（hw `.opacity(0.5)`）
    static let peekDimOpacity: Double = 0.5
}

/**
 * 全屏播放页 —— **逐条对齐鸿蒙端 `pages/PlayerPage.ets`**。
 *
 * 结构：环境光晕 → 顶栏三件（收起 / eyebrow / 更多）→ 封面 + 曲名行 + 推荐理由卡
 *      → 进度条 + 时间 → 五键排（模式 / 上一首 / 播放 / 下一首 / 队列）→ 歌词 peek。
 *
 * 浮层层键：none / lyrics / queue / more / anchor / dislike，**同一时刻最多一个**；
 * 切歌自动收起 dislike / more / anchor，lyrics 与 queue 跨曲保留（内容跟新曲刷新）。
 *
 * hw 源码零 Swipe / Pan：**没有滑动切歌，也没有下拉收起**，收起只有左上 chevron-down
 * （sheet 自带的交互式下滑一并禁用）。
 *
 * 失败呈现规格（用户 2026-10-23 定稿）：连播失败页面不留报错，手动点播无音源只在
 * eyebrow 显示「无音源」；页面**没有**错误横幅、没有重试/跳过按钮，修音源走「更多 → 修正音源」。
 */
struct PlayerView: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    /// 当前浮层层键（唯一写入方）
    @State private var sheet: PlayerSheet = .none
    /// 拖动进度条期间不能用播放位置驱动滑块（松手才 seek，对齐 hw `dragging`/`dragPos`）
    @State private var dragging = false
    @State private var slide: Double = 0
    /// 歌词 peek（当前行 ±1）
    @State private var peekLines: [LyricLine] = []
    @State private var peekActive = -1
    /// 红心（切歌 / 收藏切换后异步刷新）
    @State private var favored = false
    /// 该曲已有锚点（更多菜单的「音源」兜底 + 锚定弹窗回显/解除）
    @State private var anchorInfo: AnchorInfo?
    /// 集合页（歌手 / 专辑）
    @State private var path: [CollectionRoute] = []

    private var p: Palette { Palette(scheme) }
    private var track: Track? { player.currentTrack }

    var body: some View {
        NavigationStack(path: $path) {
            // 播放页是沉浸式全屏：自己读避让区并按 hw 的口径补 padding（不靠系统的默认留白）
            GeometryReader { proxy in
                ZStack {
                    ambient
                    page(topInset: proxy.safeAreaInsets.top, bottomInset: proxy.safeAreaInsets.bottom)
                    layers(topInset: proxy.safeAreaInsets.top, bottomInset: proxy.safeAreaInsets.bottom)
                }
            }
            .ignoresSafeArea()
            .background(p.bg)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: CollectionRoute.self) { route in
                CollectionView(route: route)
            }
        }
        // hw 没有下拉收起：只认左上 chevron-down
        .interactiveDismissDisabled()
        .task(id: track?.id) { await syncTrackState() }
        .onChange(of: track?.id) { _, _ in
            // 切歌自动收起 dislike / more / anchor；lyrics 与 queue 跨曲保留（hw onTrackChanged）
            if sheet == .dislike || sheet == .more || sheet == .anchor { closeSheet() }
            refreshPeek()
        }
        .onChange(of: player.positionMs) { _, _ in
            if !dragging { slide = Double(clampedPosition) }
            refreshPeek()
        }
        .onChange(of: player.durationMs) { _, _ in
            if !dragging { slide = Double(clampedPosition) }
        }
        .onAppear { slide = Double(clampedPosition) }
    }

    // MARK: - 可见数据

    private var clampedPosition: Int {
        min(player.positionMs, max(player.durationMs, 1))
    }

    /// 副行：歌手 · 专辑（hw `subLine` 同口径）
    private var subLine: String {
        let artist = track?.artistLine ?? ""
        let album = track?.al.name ?? ""
        return album.isEmpty ? artist : "\(artist) · \(album)"
    }

    private var firstArtistName: String {
        guard let first = track?.ar.first else { return "" }
        return first.name
    }

    /// 「音源」行文案（hw `sourceLabel`）：bilibili / 网易云 / 未匹配；
    /// 解析还没回来但已手动锚定时兜底成 bilibili（锚点必然是 B 站）
    private var sourceText: String {
        let label = player.sourceLabel
        if label == "未匹配", anchorInfo != nil { return "bilibili" }
        return label
    }

    /// 播放模式图标（hw `modeIconName` 的 iOS 子集）
    private var modeIcon: WebIconName {
        switch player.playMode {
        case "all": return .modeLoop
        case "one": return .modeRepeatOne
        default: return .modeOrder
        }
    }

    private var modeActive: Bool { player.playMode != "off" }

    // MARK: - 页面主层

    private func page(topInset: CGFloat, bottomInset: CGFloat) -> some View {
        VStack(spacing: 0) {
            header
            coverArea
            foot
        }
        .padding(.horizontal, Dim.s5)
        .padding(.top, topInset + Dim.s3)
        .padding(.bottom, bottomInset + Dim.s4)
    }

    /// 环境光晕（web `.ambient`）：封面铺满 + 模糊 + 0.15 透明度，主层浮在其上
    @ViewBuilder
    private var ambient: some View {
        if let url = coverURL {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    Color.clear
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .blur(radius: Dim.glowBlur)
            .opacity(PlayerSpec.glowOpacity)
            .clipped()
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }

    private var coverURL: URL? {
        guard let raw = track?.al.picUrl, !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    // MARK: - 顶栏（收起 / eyebrow / 更多）

    private var header: some View {
        ZStack {
            HStack(spacing: 0) {
                WebIconButton(.chevronDown, box: Dim.touchMin, style: .plain) { dismiss() }
                    .accessibilityLabel("收起播放页")
                Spacer(minLength: 0)
                WebIconButton(.dots, box: Dim.btnMd, style: .plain) { openSheet(.more) }
                    .accessibilityLabel("更多")
            }
            Text(player.eyebrowText)
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(player.noSource ? p.danger : p.text2)
                .lineLimit(1)
                .truncationMode(.tail)
                .containerRelativeFrame(.horizontal, alignment: .center) { length, _ in
                    length * PlayerSpec.eyebrowRatio
                }
                .accessibilityLabel(player.eyebrowText)
        }
        .padding(.top, Dim.s1)
        .padding(.bottom, Dim.s2)
    }

    // MARK: - 封面 + 曲名行 + 推荐理由卡

    private var coverArea: some View {
        VStack(spacing: Dim.s4) {
            coverImage
            titleRow
            if let reco = player.currentRecoReason, !reco.isEmpty {
                recoCard(reco)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var coverImage: some View {
        // 有推荐理由时封面收缩让位（hw `has-reco`）
        let side = (player.currentRecoReason?.isEmpty == false) ? Dim.coverReco : Dim.coverXl
        return AsyncImage(url: coverURL) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                p.panel2
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous))
    }

    private var titleRow: some View {
        HStack(spacing: Dim.s2) {
            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(track?.name ?? "暂无歌曲播放")
                    .font(.system(size: Dim.fsHero, weight: .medium))
                    .foregroundStyle(p.text1)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(subLine)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            GlyphKey(favored ? .heartFilled : .heart, box: Dim.btnMd,
                     color: favored ? p.accent : p.text2) {
                Task { await toggleFav() }
            }
            .accessibilityLabel(favored ? "取消收藏" : "收藏")
        }
        .frame(maxWidth: .infinity)
    }

    /// 专属推荐理由卡（web `m-info-card`）：标签 + 不喜欢入口 + 理由正文。
    /// 不喜欢键留在标题行里（36 键壳把行撑到 36，文字垂直居中天然带出上留白），
    /// 卡片 top padding 取 0 —— 否则顶部空隙会比底部大一截（hw 用户反馈原话）。
    private func recoCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: Dim.s2) {
            HStack(spacing: 0) {
                Text("专属推荐理由")
                    .font(.system(size: Dim.fsCaption, weight: .medium))
                    .foregroundStyle(p.text2)
                Spacer(minLength: 0)
                GlyphKey(.dislikeSong, box: Dim.btnMd,
                         color: sheet == .dislike ? p.danger : p.text2) {
                    openSheet(sheet == .dislike ? .none : .dislike)
                }
                .accessibilityLabel("不喜欢")
            }
            .frame(height: Dim.btnMd)
            Text(text)
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, Dim.s3)
        .padding(.trailing, Dim.s3)
        .padding(.bottom, Dim.s3)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous).fill(p.panel2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
    }

    // MARK: - 底部（进度 + 五键 + 歌词 peek）

    private var foot: some View {
        VStack(spacing: Dim.s2) {
            progress
            timeRow
            controls
            peek
        }
        .padding(.vertical, Dim.s2)
    }

    private var progress: some View {
        Slider(value: $slide, in: 0...Double(max(player.durationMs, 1)),
               step: PlayerSpec.seekStep) { editing in
            dragging = editing
            if !editing { player.seek(to: Int(slide)) }
        }
        .tint(p.accent)
        .accessibilityLabel("播放进度")
    }

    private var timeRow: some View {
        HStack {
            Text(Self.mmss(dragging ? Int(slide) : player.positionMs))
            Spacer(minLength: 0)
            Text(Self.mmss(player.durationMs))
        }
        .font(.system(size: Dim.fsCaption))
        .foregroundStyle(p.text2)
    }

    private var controls: some View {
        HStack(spacing: 0) {
            GlyphKey(modeIcon, box: Dim.btnMd, color: modeActive ? p.accent : p.text2) {
                player.cycleMode()
                ToastCenter.shared.show("播放模式：\(player.playModeLabel)")
            }
            .accessibilityLabel("播放模式：\(player.playModeLabel)")

            Spacer(minLength: 0)

            HStack(spacing: Dim.s4) {
                WebIconButton(.prev, box: Dim.touchMin, style: .plain) { player.prev() }
                    .accessibilityLabel("上一首")
                WebIconButton(player.playing ? .pause : .play,
                              box: PlayerSpec.playKey, style: .gradient) { player.toggle() }
                    .accessibilityLabel(player.playing ? "暂停" : "播放")
                WebIconButton(.next, box: Dim.touchMin, style: .plain) { player.next() }
                    .accessibilityLabel("下一首")
            }

            Spacer(minLength: 0)

            WebIconButton(.list, box: Dim.btnMd, style: .plain) { openSheet(.queue) }
                .accessibilityLabel("播放队列")
        }
    }

    /// 歌词 peek（web `lyric-wrap`）：当前行 ±1，整块可点开歌词面板
    private var peek: some View {
        VStack(spacing: Dim.s1) {
            ForEach(peekLines.indices, id: \.self) { index in
                Text(peekLines[index].text)
                    .font(.system(size: index == peekActive ? Dim.fsBody : Dim.fsMinor,
                                  weight: index == peekActive ? .medium : .regular))
                    .foregroundStyle(index == peekActive ? p.accent : p.text2)
                    .opacity(index == peekActive ? 1 : PlayerSpec.peekDimOpacity)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Dim.peekH)
        .contentShape(Rectangle())
        .onTapGesture { openSheet(.lyrics) }
        .accessibilityLabel("展开歌词")
    }

    // MARK: - 浮层

    @ViewBuilder
    private func layers(topInset: CGFloat, bottomInset: CGFloat) -> some View {
        switch sheet {
        case .lyrics:
            LyricPanel(title: track?.name ?? "", topInset: topInset, bottomInset: bottomInset,
                       onClose: { closeSheet() })
                .transition(.move(edge: .bottom))
        case .queue:
            QueueSheet(bottomInset: bottomInset, onClose: { closeSheet() })
                .transition(.move(edge: .bottom))
        case .more:
            MoreMenu(sourceLabel: sourceText, artistName: firstArtistName,
                     albumName: track?.al.name ?? "",
                     hasArtist: !firstArtistName.isEmpty && !(track?.ar.first?.id.isEmpty ?? true),
                     hasAlbum: !(track?.al.id.isEmpty ?? true),
                     topInset: topInset,
                     onClose: { closeSheet() },
                     onArtist: { openCollection(kind: "artist") },
                     onAlbum: { openCollection(kind: "album") },
                     onAnchor: { openSheet(.anchor) })
                .transition(.opacity)
        case .anchor:
            AnchorSheet(anchorInfo: $anchorInfo, onClose: { closeSheet() })
                .transition(.opacity)
        case .dislike:
            DislikeDialog(trackName: track?.name ?? "", artistName: firstArtistName,
                          onTrack: { Task { await dislikeTrack() } },
                          onArtist: { Task { await dislikeArtist() } },
                          onCancel: { closeSheet() })
                .transition(.opacity)
        case .none:
            EmptyView()
        }
    }

    private func openSheet(_ next: PlayerSheet) {
        withAnimation(Motion.curve) { sheet = next }
    }

    private func closeSheet() {
        withAnimation(Motion.curve) { sheet = .none }
    }

    private func openCollection(kind: String) {
        guard let track else { return }
        let route: CollectionRoute
        if kind == "artist" {
            guard let first = track.ar.first, !first.id.isEmpty else { return }
            route = CollectionRoute(kind: "artist", id: first.id, name: first.name)
        } else {
            guard !track.al.id.isEmpty else { return }
            route = CollectionRoute(kind: "album", id: track.al.id, name: track.al.name)
        }
        closeSheet()
        path.append(route)
    }

    // MARK: - 曲目相关副作用

    /// 切歌：预热歌词 peek、刷新红心、回显锚点
    private func syncTrackState() async {
        refreshPeek()
        guard let id = track?.id, !id.isEmpty else {
            favored = false
            anchorInfo = nil
            return
        }
        _ = await LyricStore.shared.doc(for: id)   // 预热缓存：peek 只读缓存
        guard track?.id == id else { return }
        refreshPeek()
        favored = await player.isFavored(id)
        anchorInfo = try? await APIClient.shared.trackAnchor(id)
    }

    private func refreshPeek() {
        guard let id = track?.id else {
            peekLines = []
            peekActive = -1
            return
        }
        let peek = LyricStore.shared.peek(id, positionMs: player.positionMs)
        peekLines = peek.lines
        peekActive = peek.active
    }

    private func toggleFav() async {
        guard let track else { return }
        let was = favored
        favored = !was   // 先动视觉，失败再回滚（hw 同口径）
        guard let next = await player.toggleFavorite(track) else {
            favored = was
            ToastCenter.shared.show("收藏操作失败，请稍后重试")
            return
        }
        favored = next
    }

    // MARK: - 不喜欢（两级；落地动作只在页面里）

    /// 歌手从队列里摘：先把同 mid 的其它曲目从尾往头删（前面的下标不失效），
    /// 最后才摘当前曲（摘它才触发切歌）。
    private func removeArtistFromQueue(mid: String, currentId: String) async {
        guard !mid.isEmpty else { return }
        let snapshot = player.queueSnapshot
        var targets: [Int] = []
        for (index, item) in snapshot.enumerated() {
            if item.id == currentId { continue }
            if item.ar.first?.id == mid { targets.append(index) }
        }
        for index in targets.sorted(by: >) {
            await player.removeAt(index)
        }
        let rest = player.queueSnapshot
        for (index, item) in rest.enumerated() where item.id == currentId {
            await player.removeAt(index)
            break
        }
    }

    private func dislikeTrack() async {
        guard let track else { return }
        closeSheet()
        do {
            try await APIClient.shared.addDislike(type: "track", id: track.id, name: track.name)
        } catch {
            ToastCenter.shared.show((error as? ApiError)?.message ?? "操作失败，请稍后重试")
            return
        }
        ToastCenter.shared.show("已将《\(track.name)》移出推荐，后续将减少同类推荐")
        let index = player.currentIndex
        if index >= 0 { await player.removeAt(index) }
        NotificationCenter.default.post(name: PlaybackService.dailyRefreshNeeded, object: nil)
    }

    private func dislikeArtist() async {
        guard let track, let first = track.ar.first else {
            ToastCenter.shared.show("该歌曲无歌手信息")
            return
        }
        let mid = first.id
        guard !mid.isEmpty else {
            ToastCenter.shared.show("该歌曲无歌手信息")
            return
        }
        closeSheet()
        do {
            try await APIClient.shared.addDislike(type: "artist", id: mid, name: first.name)
        } catch {
            ToastCenter.shared.show((error as? ApiError)?.message ?? "操作失败，请稍后重试")
            return
        }
        ToastCenter.shared.show("已屏蔽歌手「\(first.name)」，后续将不再推荐")
        await removeArtistFromQueue(mid: mid, currentId: track.id)
        NotificationCenter.default.post(name: PlaybackService.dailyRefreshNeeded, object: nil)
    }

    private static func mmss(_ ms: Int) -> String {
        let total = max(0, ms) / 1000
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
