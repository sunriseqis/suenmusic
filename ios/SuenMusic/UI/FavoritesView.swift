import SwiftUI

/**
 * 收藏（「收藏」tab）—— **对齐鸿蒙端 `pages/FavoritesPage.ets`**。
 *
 * 同 hw：游标分页（`nextCursor` 为空即到底）+ 收藏内**本地**过滤（歌名/歌手/专辑，忽略大小写）+
 * 取消收藏（本地立即剪枝、总数 -1）+ 点击播放（收藏列表即队列）+ 下拉刷新。
 * 头部：有 AI 摘要就显示摘要，否则「收藏曲目」+ 总数小字。
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

    private var p: Palette { Palette(scheme) }

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

    var body: some View {
        VStack(spacing: 0) {
            header
            searchField
            list
        }
        .background(p.bg)
        .task { if items.isEmpty { await load(reset: true) } }
    }

    // MARK: - 头部

    private var header: some View {
        VStack(alignment: .leading, spacing: Dim.s1) {
            Text(summary.isEmpty ? "收藏曲目" : summary)
                .font(.system(size: Dim.fsBrand, weight: .bold))
                .foregroundStyle(p.text1)
                .lineLimit(2)
            Text("\(total) 首")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s3)
    }

    private var searchField: some View {
        HStack(spacing: Dim.s2) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: Dim.icon16))
                .foregroundStyle(p.text2)
            TextField("在收藏中搜索", text: $keyword)
                .font(.system(size: Dim.fsSub))
                .foregroundStyle(p.text1)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, Dim.s3)
        .frame(height: Dim.inputH)
        .background(p.panel2)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s2)
    }

    // MARK: - 列表

    @ViewBuilder
    private var list: some View {
        if loading && items.isEmpty {
            SkeletonList(withPoster: false, rows: 8)
        } else if !err.isEmpty && items.isEmpty {
            VStack(spacing: Dim.s3) {
                Text(err)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.danger)
                Button("重试") { Task { await load(reset: true) } }
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.accentText)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if items.isEmpty {
            Text("还没有收藏，右滑或点心收藏喜欢的歌")
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .padding(.top, Dim.s6)
        } else if visible.isEmpty {
            VStack(spacing: Dim.s3) {
                Text("收藏里没有匹配「\(keyword)」的曲目")
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
                Button("清除搜索") { keyword = "" }
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.accentText)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, Dim.s5)
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(shownTracks.enumerated()), id: \.element.id) { index, track in
                        row(track, index: index)
                    }
                    if keyword.isEmpty {
                        footer
                    }
                }
                .padding(.bottom, Dim.s6)
            }
            .scrollIndicators(.hidden)
            .refreshable { await load(reset: true) }
        }
    }

    private func row(_ track: Track, index: Int) -> some View {
        HStack(spacing: Dim.s3) {
            Button {
                Task { await player.play(tracks: shownTracks, startingAt: index, origin: "收藏") }
            } label: {
                HStack(spacing: Dim.s3) {
                    Text(String(format: "%02d", index + 1))
                        .font(.system(size: Dim.fsMinor))
                        .foregroundStyle(p.text2)
                        .frame(width: Dim.seqW, alignment: .leading)
                    Text(track.name)
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.text1)
                        .lineLimit(1)
                    Spacer(minLength: Dim.s2)
                    Text(track.artistLine)
                        .font(.system(size: Dim.fsMinor))
                        .foregroundStyle(p.text2)
                        .lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(track.name) \(track.artistLine)")

            Button {
                Task { await unfavorite(track) }
            } label: {
                Image(systemName: "heart.fill")
                    .font(.system(size: Dim.icon16))
                    .foregroundStyle(p.accent)
                    .frame(width: Dim.btnMd, height: Dim.btnMd)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("取消收藏 \(track.name)")
        }
        .padding(.horizontal, Dim.s4)
        .frame(height: Dim.rowHeight)
    }

    @ViewBuilder
    private var footer: some View {
        if loadingMore {
            Text("加载中…")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Dim.s4)
        } else if nextCursor != nil {
            Button("加载更多") { Task { await load(reset: false) } }
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.accentText)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Dim.s4)
        } else {
            Text("没有更多了")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Dim.s4)
        }
    }

    // MARK: - 逻辑

    private func load(reset: Bool) async {
        if reset {
            loading = true
            err = ""
        } else {
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
                items += reply.items
            }
            total = reply.total
            nextCursor = reply.nextCursor
        } catch {
            err = (error as? ApiError)?.message ?? error.localizedDescription
        }
    }

    /// 取消收藏：本地立即剪枝 + 总数 -1（hw 同：删完立刻消失，失败再回滚提示）
    private func unfavorite(_ track: Track) async {
        let snapshot = items
        let oldTotal = total
        items.removeAll { $0.trackId == track.id }
        total = max(0, total - 1)
        do {
            try await APIClient.shared.removeFavorite(trackId: track.id)
        } catch {
            items = snapshot
            total = oldTotal
            err = (error as? ApiError)?.message ?? error.localizedDescription
        }
    }
}
