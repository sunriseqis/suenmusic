import SwiftUI

/**
 * 搜索页 —— **对齐鸿蒙端 `pages/SearchPage.ets`**。
 *
 * 与 hw 相同：`NeuInput` 搜索条 + 右贴图标钮（回车即搜）+ 四分片 `NeuTabs`
 * （单曲/专辑/歌手/歌单，类型序同 hw `SLICE_TYPES`）+ 分片级翻页 + 最近搜索
 * （本地，最多 10 条，键 `recent_search` 同 hw）+ `TrackRow` 结果行 + 空态/骨架。
 * 计数文案同 hw `countLabel`：上游还有下一页时标 `N+`（服务端没有总数字段，不假装知道）。
 *
 * 限流（hw SearchPage.ets:71,79,197,206,231-240）：服务端 HTTP 200 + `degraded` 非空且结果为空
 * 时显示服务端人话，并记下冷却截止时刻 —— 冷却期内直接复用提示、不再打服务端。
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
    /// 服务端随 HTTP 200 带回的限流人话（hw degradedText）：空结果 + degraded 是上游限流，不是「没找到」
    @State private var degradedText = ""
    /// 客户端冷却截止时刻（epoch ms，来自 degraded.retryAfterMs）：期间不再发请求（hw cooldownUntil）
    @State private var cooldownUntil: Double = 0
    @State private var recent: [String] = []

    /// 类型序与 hw `SLICE_TYPES` 一致
    private let sliceTypes = ["song", "album", "artist", "playlist"]
    /// 标签与 hw `NeuTabs({ labels: ['单曲','专辑','歌手','歌单'] })` 一致
    private let sliceLabels = ["单曲", "专辑", "歌手", "歌单"]
    /// 与 hw `RECENT_MAX` 同值
    private let recentMax = 10
    private let recentKey = "recent_search"
    /// /api/search 每页条数。
    ///
    /// 从 30 提到 50：服务端 `limit` 上限就是 50，**仍是一次上游请求**（qq search 无缓存，
    /// 多拉几页就是多打几次 QQ）。搜索结果即队列，所以这直接决定「点歌后队列有多长」。
    private let pageLimit = 50
    /// 当前播放队列对应的搜索关键词（翻页续接时校验，避免串改别的来源队列）
    @State private var queueQuery: String = ""
    /// 冷却期内复用的提示（hw SearchPage.ets:197 同文案，N = 剩余秒数向上取整）
    private static let rateLimitedFmt = "QQ 音乐搜索被限流，请在 %d 秒后重试"
    /// 服务端没给 message 时的兜底（hw SearchPage.ets:236）
    private static let rateLimitedFallback = "QQ 音乐搜索被限流，请稍后重试"

    private var p: Palette { Palette(scheme) }

    var body: some View {
        // DEBUG 自动化钩子：模拟器没有触摸输入，用启动参数把集合页直接摆上来，
        // 才能逐跳验收 C（歌手页专辑网格 → 专辑页歌手链接）。Release 下恒为 nil。
        if let injected = Self.debugCollectionRoute() {
            CollectionView(route: injected)
        } else {
            searchBody
        }
    }

    private var searchBody: some View {
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
        .onReceive(NotificationCenter.default.publisher(for: PlaybackService.favoritesChanged)) { note in
            guard let id = note.userInfo?["id"] as? String, let fav = note.userInfo?["fav"] as? Bool else { return }
            if fav { favIds.insert(id) } else { favIds.remove(id) }
        }
        .onAppear {
            loadRecent()
            debugAutoSearch()
        }
    }

    // MARK: - 搜索条（NeuInput + 琥珀图标钮并排，gap s3 同 hw）

    private var searchBar: some View {
        HStack(spacing: Dim.s3) {
            NeuInput($keyword, clearable: true, placeholder: "歌名、歌手、专辑、歌单", icon: .search) { trigger() }
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
        } else if !degradedText.isEmpty && !hasAnyResult {
            rateLimited
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

    /// 上游限流（hw SearchPage build 的 degradedText 分支）：提示而非「没找到」
    private var rateLimited: some View {
        VStack(spacing: Dim.s2) {
            Text(degradedText)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.accent)
                .multilineTextAlignment(.center)
            Text("上游限流是临时的，稍等一下再试，不是搜索坏了")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, Dim.s6)
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
        Group {
            if slice == 0 { songList } else { otherSlices }
        }
    }

    /// 单曲分片：`List` + `.swipeActions`（右滑收藏的方向仲裁交给系统，滚动不受影响）
    private var songList: some View {
        List {
            blockHead("单曲", songs.count, more: hasMore[0], showPlayAll: true)
                .listRowChrome()
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
                .listRowChrome()
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    let on = favIds.contains(track.id)
                    Button { Task { await toggleFav(track) } } label: {
                        Label(on ? "取消收藏" : "收藏", systemImage: on ? "heart.slash" : "heart")
                    }
                    .tint(on ? DesignTokens.swipeFavBg : DesignTokens.accentText)
                }
                .id("\(track.id)|\(favIds.contains(track.id))")   // 收藏态进身份：强制重建 UIKit 行的 swipe 配置
            }
            footer.listRowChrome()
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollIndicators(.hidden)
    }

    /// 专辑 / 歌手 / 歌单分片：仍是普通滚动列表（卡片网格，没有右滑语义）
    private var otherSlices: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                switch slice {
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
        degradedText = ""
    }

    private func doSearch(page target: Int) async {
        let q = submitted
        guard !q.isEmpty else { return }
        // 冷却窗口内不打服务端（hw SearchPage.ets:181-199）：首屏搜索直接把剩余秒数复用成提示，
        // 翻页请求直接拦下、不动现有结果。
        let now = Self.nowMs
        if now < cooldownUntil {
            if target == 1 {
                clearResults()
                searching = false
                loadingMore = false
                let sec = Int(((cooldownUntil - now) / 1000).rounded(.up))
                degradedText = String(format: Self.rateLimitedFmt, sec)
                #if DEBUG
                NSLog("[Search] 提示条文案=%@", degradedText)
                NSLog("[Search] 冷却中：剩余 %d 秒，跳过请求（不打服务端）", sec)
                #endif
            }
            return
        }
        if target == 1 {
            searching = true
            err = ""
        } else {
            loadingMore = true
        }
        degradedText = ""
        defer {
            searching = false
            loadingMore = false
        }
        do {
            // 直连 /api/search：Net/Models.swift 的 SearchReply.degraded 还是 Bool?，对不上服务端
            // 现在的对象形态（{code,message,retryAfterMs}），复用它会整包解码失败。
            let reply: SearchWireReply = try await APIClient.shared.get("/api/search", query: [
                "q": q,
                "type": sliceTypes[slice],
                "page": String(target),
                "limit": String(pageLimit),
            ])
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
                // 翻页续接队列（0 额外上游请求：这一页本来就要拉）。
                // 只有当「正在播放的队列就是这个关键词搜出来的」才续，否则会串改别的来源队列。
                if slice == 0, player.origin == "搜索", queueQuery == normalizedQuery(q) {
                    player.appendToQueue(reply.songs, origin: "搜索")
                }
            }
            hasMore = [reply.hasMore.song, reply.hasMore.album, reply.hasMore.artist, reply.hasMore.playlist]
            page = reply.page
            // 空结果 + degraded = QQ 上游限流（code 2001，hw SearchPage.ets:231-240）：
            // 显示服务端给的人话 + 记下冷却窗做节流。有结果时不打扰用户。
            let total = reply.songs.count + reply.albums.count + reply.artists.count + reply.playlists.count
            #if DEBUG
            NSLog("[Search] 响应 type=%@ page=%d 条数=%d degradedCode=%@ retryAfter=%@",
                  sliceTypes[slice], target, total,
                  String(describing: reply.degraded?.code),
                  String(describing: reply.degraded?.retryAfterMs))
            #endif
            if let degraded = reply.degraded, degraded.code != nil, total == 0 {
                let message = degraded.message ?? ""
                degradedText = message.isEmpty ? Self.rateLimitedFallback : message
                if let ms = degraded.retryAfterMs, ms > 0 {
                    cooldownUntil = Self.nowMs + ms
                }
            }
            await refreshFav()
        } catch {
            err = describe(error)
        }
    }

    /// 当前时刻（epoch ms）
    private static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

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
        let wasFav = favIds.contains(track.id)
        if wasFav { favIds.remove(track.id) } else { favIds.insert(track.id) }   // 乐观翻转
        guard let nowFav = await player.toggleFavorite(track, currentlyFavored: wasFav) else {
            if wasFav { favIds.insert(track.id) } else { favIds.remove(track.id) }
            ToastCenter.shared.show("收藏操作失败，请稍后重试")
            return false
        }
        if nowFav { favIds.insert(track.id) } else { favIds.remove(track.id) }
        return true
    }

    /// 关键词归一化（去首尾空白 + 小写）：比较「这条队列是不是同一个搜索」用
    private func normalizedQuery(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func playSong(at index: Int) async {
        guard songs.indices.contains(index) else { return }
        // 记下这次队列对应的关键词，翻页时用它判断能不能续接
        queueQuery = normalizedQuery(keyword)
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

    // MARK: - 无触摸自动化（DEBUG）：模拟器不能打字，用启动参数注入关键词
    //
    //   xcrun simctl launch booted com.suenmusic.app -SUEN_TAB search -SUEN_SEARCH 周杰伦
    //   -SUEN_SEARCH_REPEAT 1：在冷却窗内再提交一次，用来验收「冷却期不发请求、直接复用提示」
    private func debugAutoSearch() {
        guard let injected = DebugHooks.string("SUEN_SEARCH"), !injected.isEmpty else { return }
        #if DEBUG
        NSLog("[Auto] 注入搜索关键词=%@", injected)
        #endif
        keyword = injected
        trigger()
        let repeatCount = DebugHooks.int("SUEN_SEARCH_REPEAT") ?? 0
        guard repeatCount > 0 else { return }
        // 间隔 1 秒（复用 1s 的动效令牌，不引入新裸数值）：够第一次响应落地、冷却生效
        Task { @MainActor in
            for _ in 0..<repeatCount {
                try? await Task.sleep(for: .seconds(Motion.barsBounce))
                trigger()
            }
        }
    }

    /// `-SUEN_COLLECTION artist:qq_ar_xxx:段艺璇` → 直接渲染该集合页（仅自动化验收用）
    private static func debugCollectionRoute() -> CollectionRoute? {
        guard let spec = DebugHooks.string("SUEN_COLLECTION"), !spec.isEmpty else { return nil }
        let parts = spec.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return CollectionRoute(kind: parts[0], id: parts[1], name: parts[2])
    }
}

/// `/api/search` 的 `degraded`（hw `SearchDegraded`）：QQ 上游限流（code 2001）时随 HTTP 200 带回。
///
/// 服务端**恒返回这个对象**（未限流时是 `{slices:[], code:null}`），所以不能按「可选布尔」理解。
private struct SearchDegradedWire: Decodable {
    let code: Int?
    let message: String?
    let retryAfterMs: Double?
}

/// `/api/search` 直连解码的响应体（只声明本页用到的字段）。
///
/// 为什么不复用 `Net/Models.swift` 的 `SearchReply`：它的 `degraded` 还是 `Bool?`，拿对象解码会
/// 抛 typeMismatch 把**整个响应**废掉（连正常搜索结果都拿不到）。`Net/` 不在本任务范围内，
/// 因此按约定在页面内私有直连；其余字段仍复用 Net/ 的公共模型，不重复定义契约。
private struct SearchWireReply: Decodable {
    let songs: [Track]
    let albums: [Album]
    let artists: [TrackArtist]
    let playlists: [PlaylistCard]
    let hasMore: SearchHasMore
    let page: Int
    let degraded: SearchDegradedWire?
}
