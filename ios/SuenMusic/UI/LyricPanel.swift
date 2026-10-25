import SwiftUI

/**
 * 歌词面板 —— **对齐鸿蒙端 `pages/LyricView.ets`**（含 PlayerPage 的 lyricSheet 头）。
 *
 * 状态机：idle / loading / ready / empty / error 五态；
 * 行点击 seek；当前行 18 Medium accent、其它 15 text2；
 * 翻译行当前 15、其它 12（译文与原文行按 300ms 容差双指针对齐，见 `LyricParser.aligned`）。
 *
 * 头（第 ⑦ 条，web LyricsPanel 同款）：eyebrow 左对齐撑满 + chevron-down 收起钮靠右，
 * 整条头也吃点击（歌词层盖住 tab 栏时不再只能点小钮）。
 */
struct LyricPanel: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    private let title: String
    private let onClose: () -> Void

    /// idle | loading | ready | empty | error
    private enum Status { case idle, loading, ready, empty, error }

    @State private var status: Status = .idle
    @State private var lines: [LyricLine] = []
    /// 设置页「显示歌词翻译」开关（与 hw 同键，默认开）。关掉后不渲染译文行，行数据仍保留，切换即刻生效。
    @AppStorage("lyric_translation") private var showTranslation = true
    @State private var trans: [String] = []
    @State private var activeIndex = -1
    @State private var errText = ""
    /// 正在加载的曲目（切歌时用它丢弃过期结果）
    @State private var loadingId = ""

    private var p: Palette { Palette(scheme) }

    init(title: String, onClose: @escaping () -> Void) {
        self.title = title
        self.onClose = onClose
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            content
        }
        // 全屏 = 占满父容器给的安全区（调用方是播放页的全屏 GeometryReader）：
        // 顶部/底部避让由容器承担，这里只补自己的呼吸留白，不再自己 ignoresSafeArea，
        // 否则会把内容顶到刘海/指示条区域之外。
        .padding(.horizontal, Dim.s5)
        .padding(.top, Dim.s3)
        .padding(.bottom, Dim.s4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(p.bg)
        .frameLog("lyrics")
        .task(id: player.currentTrack?.id) { await load() }
        .onChange(of: player.positionMs) { _, _ in syncActive() }
    }

    // MARK: - 头

    private var header: some View {
        HStack(spacing: 0) {
            Text(title.isEmpty ? "歌词" : "歌词 · \(title)")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
                .tracking(Dim.s0)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            WebIconButton(.chevronDown, box: Dim.touchMin, style: .plain, action: onClose)
                .accessibilityLabel("收起歌词")
        }
        .padding(.bottom, Dim.s2)
        .contentShape(Rectangle())
        .onTapGesture(perform: onClose)
        .accessibilityLabel("收起歌词")
    }

    // MARK: - 主体

    @ViewBuilder
    private var content: some View {
        switch status {
        case .idle:
            VStack {
                Text("暂无播放中的曲目")
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loading:
            VStack {
                ProgressView()
                    .frame(width: Dim.iconXl, height: Dim.iconXl)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            EmptyState(title: Copy.lyricEmpty)
        case .error:
            VStack(spacing: Dim.s2) {
                Text(errText)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.danger)
                WebButton("重试", variant: .plain, size: .sm) {
                    Task { await load() }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            readyList
        }
    }

    private var readyList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    // 上下留白：让第一行 / 最后一行也能滚到中间（hw `lyricPadTop/Bottom`）
                    Color.clear.frame(height: Dim.lyricPadTop)
                    ForEach(lines.indices, id: \.self) { index in
                        row(index, lines[index])
                            .id(index)
                    }
                    Color.clear.frame(height: Dim.lyricPadBottom)
                }
            }
            .scrollIndicators(.hidden)
            .onAppear {
                if activeIndex >= 0 { proxy.scrollTo(activeIndex, anchor: .center) }
            }
            .onChange(of: activeIndex) { _, value in
                guard value >= 0 else { return }
                withAnimation(Motion.curve) {
                    proxy.scrollTo(value, anchor: .center)
                }
            }
        }
    }

    private func row(_ index: Int, _ line: LyricLine) -> some View {
        let active = index == activeIndex
        return VStack(spacing: 0) {
            Text(line.text)
                .font(.system(size: active ? Dim.fsHeadline : Dim.fsTitle,
                              weight: active ? .medium : .regular))
                .foregroundStyle(active ? p.accent : p.text2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            if showTranslation, index < trans.count, !trans[index].isEmpty {
                Text(trans[index])
                    .font(.system(size: active ? Dim.fsTitle : Dim.fsMinor))
                    .foregroundStyle(p.text2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Dim.s0)
            }
        }
        .padding(.vertical, Dim.s2)
        .contentShape(Rectangle())
        .onTapGesture {
            // 点歌词跳转（对齐 web / hw 行为）
            player.seek(to: max(0, line.atMs))
        }
    }

    // MARK: - 加载

    private func load() async {
        guard let id = player.currentTrack?.id, !id.isEmpty else {
            loadingId = ""
            status = .idle
            lines = []
            trans = []
            activeIndex = -1
            return
        }
        if let cached = LyricStore.shared.cached(id) {
            apply(cached)
            return
        }
        loadingId = id
        status = .loading
        errText = ""
        let doc = await LyricStore.shared.doc(for: id)
        // 期间切歌了 → 丢弃这次结果，别把上一首的歌词盖到新曲目上
        guard loadingId == id, player.currentTrack?.id == id else { return }
        guard let doc else {
            status = .error
            errText = "歌词加载失败"
            return
        }
        apply(doc)
    }

    private func apply(_ doc: LyricDoc) {
        lines = doc.lines
        trans = doc.trans
        guard !lines.isEmpty else {
            status = .empty
            activeIndex = -1
            return
        }
        status = .ready
        activeIndex = LyricParser.activeIndex(atMs: player.positionMs, in: lines)
    }

    private func syncActive() {
        guard status == .ready, !lines.isEmpty else { return }
        let next = LyricParser.activeIndex(atMs: player.positionMs, in: lines)
        if next != activeIndex { activeIndex = next }
    }
}
