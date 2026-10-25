import SwiftUI

/**
 * 收藏（「收藏」tab）—— **对齐鸿蒙端 `pages/FavoritesPage.ets`**。
 *
 * 同 hw：游标分页（`nextCursor` 为空即到底）+ 收藏内**本地**过滤（歌名/歌手/专辑，忽略大小写）+
 * 取消收藏（右滑滑出后再回调，本地剪枝、总数 -1）+ 点击播放（收藏列表即队列）+ 下拉刷新。
 *
 * 视觉（S4 统一）：头部 AI 摘要两级标题 → 搜索行 `NeuInput` → `TrackRow` 列表
 * （`swipeRemoveOnUnfavorite`）→ 空态 `EmptyState` + `Copy.favEmpty*`、加载态 `SkeletonList`。
 */
struct FavoritesView: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    @State private var items: [FavoriteItem] = []
    @State private var total = 0
    @State private var summary = ""
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var loadingMore = false
    @State private var err = ""
    @State private var keyword = ""

    private let pageSize = 30
    /// hw `HEADER_DEFAULT_TITLE`：摘要拆不出主标题时的回退页名
    private let defaultTitle = "收藏曲目"

    private var p: Palette { Palette(scheme) }

    // MARK: - 派生数据

    /// 收藏内搜索：纯本地过滤，不发请求（hw 同）
    private var visible: [FavoriteItem] {
        let q = keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter { item in
            guard let t = item.track else { return false }
            return t.name.lowercased().contains(q)
                || t.artistLine.lowercased().contains(q)
                || t.al.name.lowercased().contains(q)
        }
    }

    private var shownTracks: [Track] {
        visible.compactMap(\.track)
    }

    private var reachedEnd: Bool { nextCursor == nil }

    /// 有关键词、有收藏，但全部拉完仍一条不中（hw `isNoMatch`：不拿部分数据误报）
    private var isNoMatch: Bool {
        !loading && err.isEmpty && !items.isEmpty
            && !keyword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && visible.isEmpty && reachedEnd
    }

    private func isPlaying(_ track: Track) -> Bool {
        player.playing && player.currentTrack?.id == track.id
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            content
        }
        .background(p.bg)
        .onChange(of: keyword) { _, value in
            // 关键词一非空就把剩余分页拉完，否则会拿部分数据误报「没有匹配」（hw ensureAllLoaded）
            guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            Task { await loadAll() }
        }
        .task {
            if items.isEmpty { await load(reset: true) }
            player.warm(shownTracks, limit: 10)
        }
    }

    // MARK: - 头部（AI 摘要 → 主标题 + 副题）

    private var header: some View {
        let head = aiHeader(summary.isEmpty ? "" : summary)
        return VStack(alignment: .leading, spacing: Dim.s1) {
            HStack(alignment: .bottom, spacing: Dim.s2) {
                Text(head.title)
                    .font(.system(size: Dim.fsDisplay, weight: .medium))
                    .foregroundStyle(p.text1)
                    .lineLimit(2)
                if head.title == defaultTitle && total > 0 {
                    Text("\(total) 首")
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(p.text2)
                }
            }
            if !head.sub.isEmpty {
                Text(head.sub)
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s3)
        .padding(.bottom, Dim.s1)
    }

    /// 对齐 hw `Copy.parseAiHeader`（该文件不在本任务边界内，故只做只读镜像）：
    /// 首个逗号/换行前 2~10 字作主标题、其后作副题；拆不出就整句落副题、主标题回退默认页名。
    private func aiHeader(_ raw: String) -> (title: String, sub: String) {
        var text = raw
        text = text.replacingOccurrences(of: "```[\\s\\S]*?```", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "#+\\s*", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "[*_~>]", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "[\"“”'‘’]", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return (defaultTitle, "") }
        if let range = text.rangeOfCharacter(from: CharacterSet(charactersIn: "，,\n")) {
            let head = String(text[text.startIndex..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
            let tail = String(text[range.upperBound...]).trimmingCharacters(in: .whitespaces)
            if head.range(of: "safety|system|assistant", options: [.regularExpression, .caseInsensitive]) != nil {
                return (defaultTitle, tail)
            }
            if head.count >= 2 && head.count <= 10 && !tail.isEmpty {
                return (head, tail)
            }
        }
        if text.count <= 8 { return (text, "") }
        return (defaultTitle, text)
    }

    /// 收藏内搜索行（hw `searchRow`：NeuInput + 放大镜图标，本地过滤不发请求）
    private var searchRow: some View {
        NeuInput($keyword, placeholder: "搜索歌名 / 歌手 / 专辑", icon: .search)
            .padding(.horizontal, Dim.s4)
            .padding(.vertical, Dim.s1)
    }

    // MARK: - 内容

    @ViewBuilder
    private var content: some View {
        if loading && items.isEmpty {
            SkeletonList(withPoster: false, rows: 8)
        } else if !err.isEmpty && items.isEmpty {
            failure
        } else if items.isEmpty {
            EmptyState(icon: .heart, title: Copy.favEmptyTitle, subtitle: Copy.favEmptySub)
        } else {
            searchRow
            if isNoMatch {
                EmptyState(
                    icon: .search,
                    title: "没有匹配「\(keyword.trimmingCharacters(in: .whitespacesAndNewlines))」的歌曲",
                    actionTitle: "清除搜索",
                    action: { keyword = "" }
                )
            } else {
                list
            }
        }
    }

    /// 首屏失败：给人话 + 可重试（与 hw 同结构的页面态，非瞬时提示）
    private var failure: some View {
        VStack(spacing: Dim.s3) {
            Text(err)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.danger)
                .multilineTextAlignment(.center)
            WebButton("重试", variant: .plain, size: .md) {
                Task { await load(reset: true) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, Dim.s4)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(Array(shownTracks.enumerated()), id: \.element.id) { index, track in
                    // 收藏页每行都是收藏：行内不画红心，右滑 = 取消收藏且滑出消失（hw markFav: false）
                    TrackRow(
                        track: track,
                        index: index + 1,
                        isFav: true,
                        markFav: false,
                        swipeRemoveOnUnfavorite: true,
                        showDur: true,
                        playing: isPlaying(track),
                        onTap: { Task { await play(at: index) } },
                        onSwipeToggle: { await unfavorite(track.id) }
                    )
                }
                footer
            }
            .padding(.bottom, Dim.s6)
        }
        .scrollIndicators(.hidden)
    }

    @ViewBuilder
    private var footer: some View {
        if loadingMore {
            Text("加载中…")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .padding(.vertical, Dim.s3)
        } else if !err.isEmpty {
            // 翻页失败：点一下重试（hw listFooter 同语义）
            Text(err)
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.danger)
                .padding(.vertical, Dim.s3)
                .contentShape(Rectangle())
                .onTapGesture { Task { await load(reset: false) } }
        } else if !reachedEnd {
            WebButton("加载更多", variant: .ghost, size: .sm) {
                Task { await load(reset: false) }
            }
            .padding(.vertical, Dim.s2)
        } else {
            Text("没有更多了")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .padding(.vertical, Dim.s3)
        }
    }

    // MARK: - 逻辑

    private func describe(_ error: Error) -> String {
        guard let e = error as? ApiError else {
            return Copy.describe(status: -1, code: nil, message: error.localizedDescription)
        }
        return Copy.describe(status: e.status, code: e.code, message: e.message)
    }

    private func load(reset: Bool) async {
        if reset {
            loading = true
            err = ""
        } else {
            guard !loadingMore, !reachedEnd else { return }
            loadingMore = true
        }
        defer {
            loading = false
            loadingMore = false
        }
        do {
            let reply = try await APIClient.shared.favorites(
                limit: pageSize,
                cursor: reset ? nil : nextCursor
            )
            if reset {
                items = reply.items
                summary = reply.summary ?? ""
            } else {
                let known = Set(items.map(\.trackId))
                items += reply.items.filter { !known.contains($0.trackId) }
            }
            total = reply.total
            nextCursor = reply.nextCursor
        } catch {
            err = describe(error)
        }
    }

    /// 有关键词时把剩余分页全部拉完（hw `ensureAllLoaded` 的等价物）
    private func loadAll() async {
        while !reachedEnd && err.isEmpty && !loading && !loadingMore {
            let before = items.count
            await load(reset: false)
            if items.count == before { break }
        }
    }

    private func play(at index: Int) async {
        guard shownTracks.indices.contains(index) else { return }
        await player.play(tracks: shownTracks, startingAt: index, origin: "收藏")
    }

    /// 右滑取消收藏：服务端幂等；成功后本地剪枝 + 总数 -1。
    /// 返回 false 时 `TrackRow` 会把行弹回原位（hw 同：滑出动画走完才回调）。
    private func unfavorite(_ trackId: String) async -> Bool {
        do {
            try await APIClient.shared.removeFavorite(trackId: trackId)
            items.removeAll { $0.trackId == trackId }
            total = max(0, total - 1)
            return true
        } catch {
            ToastCenter.shared.show(describe(error))
            return false
        }
    }
}
