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
    /// 封面逐级收缩比例（自适应可用高度的阶梯，从 1.0 到 0.20）。
    ///
    /// 主列（顶栏 / 封面 / 曲名 / 推荐卡 / 进度 / 五键 / 歌词 peek）是一整块，
    /// 高度不够时**只缩封面**：按这个序列取第一个能完整放进可视区的封面尺寸。
    /// hw 在小屏上同样是收缩封面，绝不溢出；比例只作用于封面，其余元素尺寸不变。
    static let coverShrink: [CGFloat] = [1.0, 0.86, 0.72, 0.58, 0.44, 0.30, 0.20]
    /// 封面可占可用高度的比例（超出就按它收缩，保证顶栏与底部区不被挤出屏）
    static let coverHeightRatio: CGFloat = 0.46
    /// 封面相对 hw 基准 280 的放大幅度上限（大屏才生效；402×874 上约 1.15 倍）
    static let coverGrowMax: CGFloat = 1.2
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
    /// 收起动作由**调用方**给（RootView 用 showPlayer=false）。
    ///
    /// 不能用 `@Environment(\.dismiss)`：播放页现在不是 present 出来的模态（hw 是全屏浮层），
    /// overlay 里的 dismiss 是空操作 —— 用户实测「收起按钮失效」就是这个原因。
    let onClose: () -> Void

    /// 当前浮层层键（唯一写入方）
    @State private var sheet: PlayerSheet = .none
    /// 拖动进度条期间不能用播放位置驱动滑块（松手才 seek，对齐 hw `dragging`/`dragPos`）
    @State private var dragging = false
    @State private var slide: Double = 0

    /// 默认空实现（无参便利构造见下方 extension）
    /// 歌词 peek（当前行 ±1）
    @State private var peekLines: [LyricLine] = []
    @State private var peekActive = -1
    /// 红心（切歌 / 收藏切换后异步刷新）
    @State private var favored = false
    /// 该曲已有锚点（更多菜单的「音源」兜底 + 锚定弹窗回显/解除）
    @State private var anchorInfo: AnchorInfo?
    /// 集合页（歌手 / 专辑）
    @State private var path: [CollectionRoute] = []
    /// 入场淡入（hw translate(y:100%)→0 的 200ms EaseOut；位移由 fullScreenCover 自带的底部滑入承担，
    /// 这里只补透明度 —— 纯视觉属性，不参与任何测量/布局）
    @State private var entered = false

    private var p: Palette { Palette(scheme) }
    private var track: Track? { player.currentTrack }

    var body: some View {
        NavigationStack(path: $path) {
            // 沉浸式全屏：底色与封面光晕铺到屏幕边缘；**布局层一律留在安全区内**，
            // 由 GeometryReader 把真实可用尺寸交给主列与四个内部浮层（谁也不许溢出）。
            // 页面外层由 RootView 的 fullScreenCover 全屏呈现，不再被 sheet 的 detent 裁切。
            ZStack {
                p.bg.ignoresSafeArea()
                ambient
                GeometryReader { proxy in
                    ZStack {
                        page(width: proxy.size.width, height: proxy.size.height)
                        layers
                    }
                }
            }
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
        .onAppear {
            slide = Double(clampedPosition)
            withAnimation(Motion.curve) { entered = true }
            #if DEBUG
            // 自动化验收钩子：SUEN_SHEET=lyrics|queue|more|anchor|dislike 时直接打开对应浮层，
            // 供 OCR 截图核对（模拟器无法脚本化点击）。默认不生效。
            switch DebugHooks.string("SUEN_SHEET") ?? "" {
            case "lyrics": openSheet(.lyrics)
            case "queue": openSheet(.queue)
            case "more": openSheet(.more)
            case "anchor": openSheet(.anchor)
            case "dislike": openSheet(.dislike)
            default: break
            }
            #endif
        }
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

    /// 主列：整块按**实际可用高度**铺 —— 顶栏 + 封面 + 曲名行 + 推荐卡 + 进度 + 五键 + 歌词 peek。
    ///
    /// 做法：ViewThatFits 从「封面上限」开始按 PlayerSpec.coverShrink 逐级收缩，
    /// 取第一个能完整放进可视高度的版本。候选列里没有可无限拉伸的元素（不存在
    /// maxHeight: .infinity），所以「放得下」= 真的放得下，不会出现内容被裁掉一半；
    /// 横向左右各留 Dim.s5，封面宽度也计入了这个上限。
    private func page(width: CGFloat, height: CGFloat) -> some View {
        // 封面吃「可用高度的一部分」而不是死守 hw 的 280：
        // 之前固定 280 + 整列垂直居中，剩下的 ~160pt 空白均分在上下，观感就是「页面没撑满」（用户实测）。
        // 现在 cap 同时受宽度与高度约束，底栏/顶栏贴边、封面吸收剩余空间。
        // 封面尺寸**只按可用空间算**，不照抄 hw 的 280：
        //   280 是 hw 在它那档分辨率上的取值；iOS 的屏幕高度跨度更大（SE 667pt → Pro Max 956pt），
        //   写死就会两头出问题：小屏内容被挤爆 / 大屏上下留一大片空白（用户两次反馈的就是后者）。
        //   规则：封面 = min(横向可用宽, 可用高 × 0.46)，有推荐理由卡时让位到 194（hw 同语义）。
        //   下限由 ViewThatFits 的收缩阶梯兜住（小屏自动降档，永不溢出）。
        let hCap = height * PlayerSpec.coverHeightRatio
        let cap = hasReco ? min(width - Dim.s5 * 2, Dim.coverReco)
                          : min(width - Dim.s5 * 2, hCap)
        return ViewThatFits(in: .vertical) {
            column(side: cap * PlayerSpec.coverShrink[0], width: width)
            column(side: cap * PlayerSpec.coverShrink[1], width: width)
            column(side: cap * PlayerSpec.coverShrink[2], width: width)
            column(side: cap * PlayerSpec.coverShrink[3], width: width)
            column(side: cap * PlayerSpec.coverShrink[4], width: width)
            column(side: cap * PlayerSpec.coverShrink[5], width: width)
            column(side: cap * PlayerSpec.coverShrink[6], width: width)
        }
        .padding(.horizontal, Dim.s5)
        .padding(.vertical, Dim.s3)
        // 贴满可用高度：顶栏夹在上、底部区压在下，中间封面块吸收剩余空间（不再整列居中留白）
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .opacity(entered ? 1 : 0)
    }

    /// 单个「封面尺寸」版本的主列（ViewThatFits 的候选）
    private func column(side: CGFloat, width: CGFloat) -> some View {
        VStack(spacing: 0) {
            header(eyebrowWidth: width * PlayerSpec.eyebrowRatio)
            VStack(spacing: Dim.s4) {
                coverImage(side: side)
                titleRow
                if let reco = player.currentRecoReason, !reco.isEmpty {
                    recoCard(reco)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.vertical, Dim.s4)
            foot
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    /// 有推荐理由卡时封面让位（hw has-reco：280 → 194）
    private var hasReco: Bool {
        !(player.currentRecoReason ?? "").isEmpty
    }

    /// 环境光晕（web `.ambient`）：封面铺满 + 模糊 + 0.15 透明度，主层浮在其上
    private var ambient: some View {
        // 尺寸由 Color.clear 决定（= 安全区可用尺寸），封面只放在 overlay 里铺满：
        // 直接给 AsyncImage 加 frame + scaledToFill 时，它按「填满高度」报出 778×778 的理想尺寸，
        // 会把整页（ZStack → GeometryReader → 浮层）一起撑成正方形，右侧内容被挤到屏幕外。
        Color.clear
            .overlay {
                if let url = coverURL {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                        } else {
                            Color.clear
                        }
                    }
                }
            }
            .blur(radius: Dim.glowBlur)
            .opacity(PlayerSpec.glowOpacity)
            .clipped()
            .ignoresSafeArea()
            .allowsHitTesting(false)
    }

    private var coverURL: URL? {
        guard let raw = track?.al.picUrl, !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    // MARK: - 顶栏（收起 / eyebrow / 更多）

    /// eyebrow 最大宽 = 页面宽 × 0.6（hw constraintSize maxWidth 60%）。
    /// 宽度由调用方按实测页面宽度传入，不用 containerRelativeFrame —— 后者要在布局时
    /// 回问容器尺寸，和「容器尺寸由子视图决定」容易形成回路。
    private func header(eyebrowWidth: CGFloat) -> some View {
        ZStack {
            HStack(spacing: 0) {
                WebIconButton(.chevronDown, box: Dim.touchMin, style: .plain) { onClose() }
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
                .frame(maxWidth: eyebrowWidth)
                .accessibilityLabel(player.eyebrowText)
        }
        .padding(.top, Dim.s1)
        .padding(.bottom, Dim.s2)
    }

    // MARK: - 封面 + 曲名行 + 推荐理由卡

    /// 封面：边长由调用方给（上限 280 / 有推荐卡 194；高度不足时按 PlayerSpec.coverShrink 收缩）
    private func coverImage(side: CGFloat) -> some View {
        AsyncImage(url: coverURL) { phase in
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

    /// 进度条上界：时长未知（0）时**不能**给 0...1 —— 那会让 step(1000) 大于区间，
    /// SwiftUI 的 Slider 前置断言直接 SIGILL 崩溃（2026-10-25 实测崩溃报告：
    /// Slider.init → Normalizing.init(min:max:stride) 断言失败，进程 EXC_BAD_INSTRUCTION）。
    /// 所以上界至少取一个步长，且步长不超过区间。
    private var seekUpperBound: Double {
        Double(max(player.durationMs, Int(PlayerSpec.seekStep)))
    }

    private var seekStepActual: Double {
        min(PlayerSpec.seekStep, seekUpperBound)
    }

    /// 时长短于这个门槛就不渲染 Slider。
    ///
    /// 踩过两次：SwiftUI 的 `Slider(value:in:step:)` 在 `step >= 区间长度` 时会在
    /// `Normalizing.init(min:max:stride)` 里 precondition 失败 → SIGILL 崩溃。
    /// 第一次修成「上界至少一个步长」仍在区间==步长（0...1000, step 1000）时崩。
    /// 最终方案：**区间必须严格大于步长**才渲染，时长未知/过短时用静态轨道占位。
    private static let sliderMinSpanMs: Int = 2000

    private var progress: some View {
        Group {
            if player.durationMs >= Self.sliderMinSpanMs {
                Slider(value: Binding(get: { min(max(slide, 0), seekUpperBound) },
                                      set: { slide = $0 }),
                       in: 0...seekUpperBound,
                       step: PlayerSpec.seekStep) { editing in
                    dragging = editing
                    if !editing { player.seek(to: Int(min(max(slide, 0), seekUpperBound))) }
                }
                .tint(p.accent)
            } else {
                // 时长未知：静态凹陷轨道占位（视觉不跳，也不崩）
                Capsule()
                    .fill(p.line)
                    .frame(height: Dim.hairline * 2)
            }
        }
        .frame(height: Dim.touchMin / 2)
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

    /// 四个（含 dislike 共五个）内部浮层都画在**安全区之内**：主列拿到的 proxy.size 就是
    /// 可用尺寸，浮层各自用自己的 GeometryReader 按它算比例（70% / 92% / 86% / 80%），
    /// 超出部分由内部 ScrollView 滚动，不再依赖 sheet 的高度、也不会跑到屏幕外。
    @ViewBuilder
    private var layers: some View {
        switch sheet {
        case .lyrics:
            LyricPanel(title: track?.name ?? "", onClose: { closeSheet() })
                .transition(.move(edge: .bottom))
                // 歌词页是整页浮层：滑入时要盖住下面的播放页主体（含 peek 歌词）
                .zIndex(2)
        case .queue:
            QueueSheet(onClose: { closeSheet() })
                .transition(.move(edge: .bottom))
        case .more:
            MoreMenu(sourceLabel: sourceText, artistName: firstArtistName,
                     albumName: track?.al.name ?? "",
                     hasArtist: !firstArtistName.isEmpty && !(track?.ar.first?.id.isEmpty ?? true),
                     hasAlbum: !(track?.al.id.isEmpty ?? true),
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
