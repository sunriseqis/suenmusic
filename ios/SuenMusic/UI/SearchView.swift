import SwiftUI

/**
 * 搜索页 —— **对齐鸿蒙端 `pages/SearchPage.ets`**。
 *
 * 与 hw 相同：`NeuInput` 搜索条 + 右贴图标钮（回车即搜）+ 四分片 `NeuTabs`
 * （单曲/专辑/歌手/歌单，类型序同 hw `SLICE_TYPES`）+ 分片级翻页 + 最近搜索
 * （本地，最多 10 条，键 `recent_search` 同 hw）+ `TrackRow` 结果行 + 空态/骨架。
 * 计数文案同 hw `countLabel`：上游还有下一页时标 `N+`（服务端没有总数字段，不假装知道）。
 *
 * **本批限制**：只有「单曲」分片可播放；专辑/歌手/歌单卡片的详情走 `CollectionRoute`。
 */
struct SearchView: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    @State private var keyword = ""
    @State private var submitted = ""
    @State private var slice = 0
    @State private var searching = false
    @State private var loadingMore = false
    @State private var page = 1
    @State private var songs: [Track] = []
    @State private var albums: [Album] = []
    @State private var artists: [TrackArtist] = []
    @State private var playlists: [PlaylistCard] = []
    @State private var hasMore = [false, false, false, false]
    /// 单曲分片已收藏的曲目 id（hw `songRows[].fav`，一次 `/api/favorites/check` 批量取）
    @State private var favIds: Set<String> = []
    @State private var err = ""
    @State private var recent: [String] = []

    /// 类型序与 hw `SLICE_TYPES` 一致
    private let sliceTypes = ["song", "album", "artist", "playlist"]
    /// 标签与 hw `NeuTabs({ labels: ['单曲','专辑','歌手','歌单'] })` 一致
    private let sliceLabels = ["单曲", "专辑", "歌手", "歌单"]
    /// 与 hw `RECENT_MAX` 同值
    private let recentMax = 10
    private let recentKey = "recent_search"

    private var p: Palette { Palette(scheme) }

    var body: some View {
        VStack(spacing: 0) {
            searchBar
            NeuTabs(titles: sliceLabels, selection: $slice)
                .padding(.horizontal, Dim.s4)
                .padding(.top, Dim.s4)
            content
        }
        .background(p.bg)
        .navigationDestination(for: CollectionRoute.self) { route in
            CollectionView(route: route)
        }
        .onChange(of: slice) { _, _ in
            guard !submitted.isEmpty else { return }
            Task { await doSearch(page: 1) }
        }
        .onChange(of: keyword) { _, value in
            // 清空搜索框 = 回到最近搜索（hw 的「未搜索」态）
            guard value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            submitted = ""
            clearResults()
        }
        .onAppear { loadRecent() }
    }

    // MARK: - 搜索条（NeuInput + 琥珀图标钮并排，gap s3 同 hw）

    private var searchBar: some View {
        HStack(spacing: Dim.s3) {
            NeuInput($keyword, placeholder: "歌名、歌手、专辑、歌单", icon: .search) { trigger() }
            WebIconButton(.search, box: Dim.touchMin, style: .gradient) { trigger() }
                .accessibilityLabel("搜索")
        }
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s5)
    }

    // MARK: - 内容

    @ViewBuilder
    private var content: some View {
        if searching && !hasAnyResult {
            SkeletonList(withPoster: false, rows: 8)
        } else if !err.isEmpty && !hasAnyResult {
            failure
        } else if submitted.isEmpty {
            if recent.isEmpty {
                EmptyState(icon: .search, title: "搜索你想听的歌", subtitle: "搜歌曲、歌手或专辑")
            } else {
                recentBlock
            }
        } else if !hasAnyResult {
            EmptyState(icon: .search, title: Copy.searchEmptyTitle, subtitle: Copy.searchEmptySub)
        } else {
            resultList
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
                Task { await doSearch(page: 1) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, Dim.s4)
    }

    // MARK: - 最近搜索

    private var recentBlock: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("最近搜索")
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
                Spacer(minLength: 0)
                Button("清空") {
                    recent = []
                    saveRecent()
                }
                .buttonStyle(.plain)
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(minHeight: Dim.touchMin)
                .accessibilityLabel("清空最近搜索")
            }
            .padding(.horizontal, Dim.s4)
            .padding(.top, Dim.s3)
            .padding(.bottom, Dim.s1)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(recent, id: \.self) { item in
                        HStack(spacing: Dim.s2) {
                            Button {
                                keyword = item
                                trigger()
                            } label: {
                                Text(item)
                                    .font(.system(size: Dim.fsSub))
                                    .foregroundStyle(p.text1)
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .frame(height: Dim.touchMin)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Button("删除") {
                                recent.removeAll { $0 == item }
                                saveRecent()
                            }
                            .buttonStyle(.plain)
                            .font(.system(size: Dim.fsMinor))
                            .foregroundStyle(p.text2)
                            .frame(minHeight: Dim.touchMin)
                            .accessibilityLabel("删除搜索记录 \(item)")
                        }
                        .padding(.horizontal, Dim.s4)
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }

    // MARK: - 结果列表

    private var resultList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                switch slice {
                case 0:
                    blockHead("单曲", songs.count, more: hasMore[0], showPlayAll: true)
                    ForEach(Array(songs.enumerated()), id: \.element.id) { index, track in
                        TrackRow(
                            track: track,
                            index: index + 1,
                            isFav: favIds.contains(track.id),
                            showDur: true,
                            playing: isPlaying(track),
                            onTap: { Task { await playSong(at: index) } },
                            onSwipeToggle: { await toggleFav(track) }
                        )
                    }
                case 1:
                    blockHead("专辑", albums.count, more: hasMore[1], showPlayAll: false)
                    grid {
                        ForEach(albums) { album in
                            NavigationLink(value: CollectionRoute(kind: "album", id: album.id, name: album.name)) {
                                coverCell(url: album.picUrl, title: album.name, sub: album.artistLine, circle: false)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                case 2:
                    blockHead("歌手", artists.count, more: hasMore[2], showPlayAll: false)
                    grid {
                        ForEach(artists) { artist in
                            NavigationLink(value: CollectionRoute(kind: "artist", id: artist.id, name: artist.name)) {
                                coverCell(url: "", title: artist.name, sub: "", circle: true)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                default:
                    blockHead("歌单", playlists.count, more: hasMore[3], showPlayAll: false)
                    grid {
                        ForEach(playlists) { list in
                            NavigationLink(value: CollectionRoute(kind: "playlist", id: list.id, name: list.name)) {
                                coverCell(url: list.picUrl, title: list.name, sub: list.subLine, circle: false)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                footer
            }
            .padding(.bottom, Dim.s6)
        }
        .scrollIndicators(.hidden)
    }

    /// 分块头（hw `blockHead`：小标 + 计数 + 单曲分片的「播放全部」）
    private func blockHead(_ label: String, _ count: Int, more: Bool, showPlayAll: Bool) -> some View {
        HStack(spacing: Dim.s2) {
            Text("\(label) \(countLabel(count, more: more))")
                .font(.system(size: Dim.fsCaption, weight: .medium))
                .foregroundStyle(p.text2)
            Spacer(minLength: 0)
            if showPlayAll {
                WebButton("播放全部", variant: .plain, size: .sm) {
                    Task { await playSong(at: 0) }
                }
            }
        }
        .padding(.horizontal, Dim.s4)
        .padding(.vertical, Dim.s2)
    }

    /// 4 列封面网格（hw `coverRow`：一行 4 张，专辑/歌手/歌单三片共用）
    private func grid<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Dim.s3), count: 4),
                  alignment: .leading, spacing: Dim.s3) {
            content()
        }
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s1)
    }

    /// 封面卡（hw `coverCard`：1:1 封面 + 发丝线 + 顶沿内高光 + 标题两行 + 副行单行）
    private func coverCell(url: String, title: String, sub: String, circle: Bool) -> some View {
        VStack(alignment: .leading, spacing: Dim.s2) {
            Group {
                if url.isEmpty {
                    p.panel2
                } else {
                    AsyncImage(url: URL(string: url)) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                        } else {
                            p.panel2
                        }
                    }
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .clipShape(coverShape(circle))
            .overlay {
                coverShape(circle).strokeBorder(p.line, lineWidth: Dim.hairline)
            }
            .overlay(alignment: .top) {
                Rectangle().fill(p.hi).frame(height: Dim.hairline)
            }
            .clipShape(coverShape(circle))

            Text(title)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text1)
                .lineLimit(2)
            if !sub.isEmpty {
                Text(sub)
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// hw：歌手圆头像走 `radiusPill`，其余 `radiusMd`
    private func coverShape(_ circle: Bool) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: circle ? Dim.radiusPill : Dim.radiusMd, style: .continuous)
    }

    @ViewBuilder
    private var footer: some View {
        if loadingMore {
            Text("加载中…")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Dim.s3)
        } else if hasMore[slice] {
            WebButton("加载更多", variant: .ghost, size: .sm) {
                Task { await doSearch(page: page + 1) }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Dim.s2)
        } else if hasAnyResult {
            Text("没有更多了")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Dim.s3)
        }
    }

    // MARK: - 逻辑

    private var hasAnyResult: Bool {
        !songs.isEmpty || !albums.isEmpty || !artists.isEmpty || !playlists.isEmpty
    }

    /// hw `countLabel`：还有下一页就标 N+
    private func countLabel(_ n: Int, more: Bool) -> String {
        more ? "\(n)+" : "\(n)"
    }

    private func isPlaying(_ track: Track) -> Bool {
        player.playing && player.currentTrack?.id == track.id
    }

    private func describe(_ error: Error) -> String {
        guard let e = error as? ApiError else {
            return Copy.describe(status: -1, code: nil, message: error.localizedDescription)
        }
        return Copy.describe(status: e.status, code: e.code, message: e.message)
    }

    private func trigger() {
        let q = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        submitted = q
        rememberRecent(q)
        Task { await doSearch(page: 1) }
    }

    private func clearResults() {
        songs = []
        albums = []
        artists = []
        playlists = []
        favIds = []
        hasMore = [false, false, false, false]
        page = 1
        err = ""
    }

    private func doSearch(page target: Int) async {
        let q = submitted
        guard !q.isEmpty else { return }
        if target == 1 {
            searching = true
            err = ""
        } else {
            loadingMore = true
        }
        defer {
            searching = false
            loadingMore = false
        }
        do {
            let reply = try await APIClient.shared.search(keyword: q, type: sliceTypes[slice], page: target)
            if target == 1 {
                songs = reply.songs
                albums = reply.albums
                artists = reply.artists
                playlists = reply.playlists
            } else {
                songs += reply.songs
                albums += reply.albums
                artists += reply.artists
                playlists += reply.playlists
            }
            hasMore = [reply.hasMore.song, reply.hasMore.album, reply.hasMore.artist, reply.hasMore.playlist]
            page = reply.page
            await refreshFav()
        } catch {
            err = describe(error)
        }
    }

    /// 单曲分片批量取收藏标记（hw `refreshFavState`：一次 check，不逐行问）
    private func refreshFav() async {
        guard !songs.isEmpty else {
            favIds = []
            return
        }
        favIds = Set(await player.favoredIds(songs.map(\.id)))
    }

    /// 右滑收藏/取消收藏（hw `toggleFav`：失败回滚 + toast，返回是否已切换）
    private func toggleFav(_ track: Track) async -> Bool {
        guard let nowFav = await player.toggleFavorite(track) else {
            ToastCenter.shared.show("收藏操作失败，请稍后重试")
            return false
        }
        if nowFav { favIds.insert(track.id) } else { favIds.remove(track.id) }
        return true
    }

    private func playSong(at index: Int) async {
        guard songs.indices.contains(index) else { return }
        await player.play(tracks: songs, startingAt: index, origin: "搜索")
    }

    // MARK: - 最近搜索（键与 hw 相同：recent_search）

    private func loadRecent() {
        guard let data = UserDefaults.standard.data(forKey: recentKey),
              let list = try? JSONDecoder().decode([String].self, from: data) else { return }
        recent = Array(list.prefix(recentMax))
    }

    private func rememberRecent(_ q: String) {
        var list = recent.filter { $0 != q }
        list.insert(q, at: 0)
        recent = Array(list.prefix(recentMax))
        saveRecent()
    }

    private func saveRecent() {
        guard let data = try? JSONEncoder().encode(recent) else { return }
        UserDefaults.standard.set(data, forKey: recentKey)
    }
}
