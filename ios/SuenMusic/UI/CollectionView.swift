import SwiftUI

/// 集合页路由（四种来源共用一套页面；hw `openCollection(kind,id,name)` 同语义）
///
/// `id` 就是集合本身的 id（专辑/歌手/歌单/榜单），可满足 Identifiable；
/// Hashable 让它能直接做 `NavigationLink(value:)` 的载荷。
struct CollectionRoute: Hashable, Identifiable {
    /// album / artist / playlist / toplist
    let kind: String
    let id: String
    let name: String
}

/**
 * 集合页 —— **对齐鸿蒙端 `pages/CollectionPage.ets`**（移动断点形态）：
 * 顶部返回键 + 居中封面/种类/标题/副行 + 「播放全部」+ `TrackRow` 曲目列表。
 *
 * 四种来源（数据加载与 hw 同接口）：
 *   · album    → `GET /api/albums/:id`（`notice` 有值就展示）
 *   · toplist  → `GET /api/toplist/:id`（`topInfo.updateFrequency` 作副行）
 *   · artist   → `GET /api/artists/:id/songs`（只做热门歌曲列表；「专辑/相似歌手」留后续）
 *   · playlist → `GET /api/qq/playlist/:tid`
 *
 * 视觉（S4 统一）：加载态 `SkeletonList(withPoster: true)`，空态 `EmptyState`（文案同 hw
 * `emptyTitle/emptyHint`，notice 优先），列表一律 `TrackRow`（右滑收藏接现有接口）。
 */
struct CollectionView: View {
    let route: CollectionRoute

    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    @State private var coverUrl = ""
    @State private var title = ""
    @State private var subtitle = ""
    @State private var notice = ""
    @State private var tracks: [Track] = []
    /// 专辑头部的主歌手（hw `album.artists`）：有 id 就能继续下钻到歌手页
    @State private var artists: [TrackArtist] = []
    /// 歌手页的专辑网格（hw `albumGrid`）：点专辑再进专辑页
    @State private var albums: [Album] = []
    /// 本集合里已收藏的曲目 id（一次 `/api/favorites/check` 批量取，hw `hasFav` 同语义）
    @State private var favIds: Set<String> = []
    @State private var loading = false
    @State private var err = ""

    private var p: Palette { Palette(scheme) }

    /// hw `HEAD_ART = 148`（Dim 没有 148 档，用令牌拼出同值）
    private let headArt = Dim.coverSm * 3 + Dim.s4
    /// hw `ALBUM_GRID_COLS`（歌手页专辑网格列数）
    private let albumGridCols = 4
    /// hw `BATCH_SIZE`（歌手页首批专辑数）
    private let albumBatch = 8

    var body: some View {
        VStack(spacing: 0) {
            topBar
            content
        }
        .background(p.bg)
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        // 下钻链路（hw openCollection 全局信号）：本页自己也能再进集合 —— 从搜索/首页以外的入口
        // 进来时同样成立；栈里连续 push 同一个 CollectionView，返回键 dismiss 一层即可。
        .navigationDestination(for: CollectionRoute.self) { route in
            CollectionView(route: route)
        }
        .task {
            await load()
            await refreshFav()
        }
    }

    // MARK: - 顶部返回键（hw backButton：panel 底 + 发丝描边 + 圆形）

    private var topBar: some View {
        HStack(spacing: 0) {
            WebIconButton(.chevronLeft, box: Dim.btnBar, style: .chrome) { dismiss() }
                .accessibilityLabel("返回")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Dim.s3)
        .padding(.top, Dim.s2)
    }

    // MARK: - 内容

    @ViewBuilder
    private var content: some View {
        if loading && tracks.isEmpty {
            // hw SkeletonList 默认 withPoster: false（集合页没有首页那种两卡海报区）
            SkeletonList(withPoster: false, rows: 8)
        } else if !err.isEmpty && tracks.isEmpty {
            failure
        } else {
            // List + swipeActions：右滑收藏由系统仲裁方向（等价 hw PanGesture(direction:.horizontal)）
            List {
                header.listRowChrome()
                actions.listRowChrome()
                if !notice.isEmpty {
                    Text(notice)
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(p.text2)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, Dim.s4)
                        .padding(.top, Dim.s1)
                        .listRowChrome()
                }
                if tracks.isEmpty {
                    EmptyState(icon: .list, title: emptyTitle, subtitle: emptyHint)
                        .frame(minHeight: Dim.coverXl)
                        .listRowChrome()
                } else {
                    ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                        TrackRow(
                            track: track,
                            index: index + 1,
                            isFav: favIds.contains(track.id),
                            showDur: true,
                            playing: isPlaying(track),
                            onTap: { Task { await play(at: index) } },
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
                    }
                }
                if route.kind == "artist" && !albums.isEmpty {
                    albumSection.listRowChrome()
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .scrollIndicators(.hidden)
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
                Task { await load() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, Dim.s4)
    }

    /// 头部（hw ≤767px 移动断点：居中列布局）
    private var header: some View {
        VStack(spacing: Dim.s2) {
            Group {
                if coverUrl.isEmpty {
                    p.panel2
                } else {
                    AsyncImage(url: URL(string: coverUrl)) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                        } else {
                            p.panel2
                        }
                    }
                }
            }
            .frame(width: headArt, height: headArt)
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .strokeBorder(p.line, lineWidth: Dim.hairline)
            }

            Text(kindLabel)
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
            Text(title.isEmpty ? route.name : title)
                .font(.system(size: Dim.fsDisplay, weight: .bold))
                .foregroundStyle(p.text1)
                .multilineTextAlignment(.center)
                .lineLimit(2)
            subtitleLine
            if route.kind != "artist" && !tracks.isEmpty {
                Text("\(tracks.count) 首")
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s2)
    }

    /// 副行：专辑页把主歌手做成可继续下钻的链路（hw 任意页都能再进集合），
    /// 其余种类（榜单/歌单/歌手）保持纯文本，不假装有入口。
    @ViewBuilder
    private var subtitleLine: some View {
        if route.kind == "album" && !artists.isEmpty {
            HStack(spacing: Dim.s1) {
                ForEach(Array(artists.enumerated()), id: \.element.id) { index, artist in
                    if index > 0 {
                        Text("/")
                            .font(.system(size: Dim.fsBody))
                            .foregroundStyle(p.text2)
                    }
                    NavigationLink(value: CollectionRoute(kind: "artist", id: artist.id, name: artist.name)) {
                        Text(artist.name)
                            .font(.system(size: Dim.fsBody))
                            .foregroundStyle(p.accentText)
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("歌手 \(artist.name)")
                }
            }
        } else if !subtitle.isEmpty {
            Text(subtitle)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text2)
                .lineLimit(1)
        }
    }

    /// 播放全部（hw playAllButton：accent 底 + 深字）
    @ViewBuilder
    private var actions: some View {
        if !loading && !tracks.isEmpty {
            HStack(spacing: Dim.s3) {
                WebButton("播放全部", variant: .primary, size: .md) {
                    Task { await player.play(tracks: tracks, startingAt: 0, origin: originLabel) }
                }
                .accessibilityLabel("播放全部")
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Dim.s2)
        }
    }

    /// 歌手页「专辑」网格（hw albumGrid：4 列 + 点卡片进专辑页）。补充内容，拿不到就整节不出现。
    private var albumSection: some View {
        VStack(alignment: .leading, spacing: Dim.s3) {
            Text("专辑")
                .font(.system(size: Dim.fsHeadline, weight: .bold))
                .foregroundStyle(p.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Dim.s2), count: albumGridCols),
                      alignment: .leading, spacing: Dim.s3) {
                ForEach(albums) { album in
                    NavigationLink(value: CollectionRoute(kind: "album", id: album.id, name: album.name)) {
                        coverCell(album)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s4)
    }

    /// 封面卡（hw coverCard：1:1 封面 + 发丝线 + 顶沿内高光 + 标题两行 + 副行单行）
    private func coverCell(_ album: Album) -> some View {
        VStack(alignment: .leading, spacing: Dim.s2) {
            Group {
                if album.picUrl.isEmpty {
                    p.panel2
                } else {
                    AsyncImage(url: URL(string: album.picUrl)) { phase in
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
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .strokeBorder(p.line, lineWidth: Dim.hairline)
            }
            .overlay(alignment: .top) {
                Rectangle().fill(p.hi).frame(height: Dim.hairline)
            }
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))

            Text(album.name)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text1)
                .lineLimit(2)
            if !album.artistLine.isEmpty {
                Text(album.artistLine)
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - 文案（对齐 hw kindLabel / emptyTitle / emptyHint）

    private var kindLabel: String {
        switch route.kind {
        case "toplist": return "排行榜"
        case "playlist": return "歌单"
        case "artist": return "歌手"
        default: return "专辑"
        }
    }

    private var emptyTitle: String {
        route.kind == "album" ? "这张专辑暂不可播放" : "这里还没有曲目"
    }

    private var emptyHint: String {
        if !notice.isEmpty { return notice }
        switch route.kind {
        case "album": return "上游没有返回曲目，可能是尚未发行或曲目正在调整。"
        case "playlist": return "上游返回了空列表，这个歌单可能已下架。"
        case "toplist": return "暂时取不到榜单曲目，稍后重试。"
        default: return "没有检索到这位歌手的曲目。"
        }
    }

    private var originLabel: String {
        switch route.kind {
        case "album": return "专辑"
        case "artist": return "歌手"
        case "playlist": return "歌单"
        case "toplist": return "榜单"
        default: return route.kind
        }
    }

    // MARK: - 逻辑

    private func isPlaying(_ track: Track) -> Bool {
        player.playing && player.currentTrack?.id == track.id
    }

    private func describe(_ error: Error) -> String {
        guard let e = error as? ApiError else {
            return Copy.describe(status: -1, code: nil, message: error.localizedDescription)
        }
        return Copy.describe(status: e.status, code: e.code, message: e.message)
    }

    private func play(at index: Int) async {
        guard tracks.indices.contains(index) else { return }
        await player.play(tracks: tracks, startingAt: index, origin: originLabel)
    }

    /// 右滑收藏/取消收藏（hw toggleFav：失败回滚 + toast）
    private func toggleFav(_ track: Track) async -> Bool {
        guard let nowFav = await player.toggleFavorite(track) else {
            ToastCenter.shared.show("收藏操作失败，请稍后重试")
            return false
        }
        if nowFav { favIds.insert(track.id) } else { favIds.remove(track.id) }
        return true
    }

    private func refreshFav() async {
        guard !tracks.isEmpty else {
            favIds = []
            return
        }
        favIds = Set(await player.favoredIds(tracks.map(\.id)))
    }

    private func load() async {
        loading = true
        err = ""
        artists = []
        albums = []
        do {
            switch route.kind {
            case "album":
                let r = try await APIClient.shared.albumDetail(id: route.id)
                coverUrl = r.album.picUrl
                title = r.album.name
                subtitle = r.album.artistLine
                // 头部主歌手带 id：做成可下钻链路（专辑 → 歌手）
                artists = r.album.artists ?? []
                notice = r.notice ?? ""
                tracks = r.songs
            case "toplist":
                let r = try await APIClient.shared.toplistDetail(id: route.id)
                coverUrl = r.topInfo?.picUrl ?? ""
                title = r.topInfo?.name ?? route.name
                subtitle = r.topInfo?.updateFrequency ?? ""
                tracks = r.tracks
            case "artist":
                let r = try await APIClient.shared.artistSongs(id: route.id, name: route.name)
                title = r.name.isEmpty ? route.name : r.name
                subtitle = "热门歌曲"
                tracks = r.songs
                // 专辑是补充内容：独立请求、独立兜错，拿不到就整节不出现（hw loadArtistAlbums 同口径）
                await loadArtistAlbums()
            case "playlist":
                let r = try await APIClient.shared.qqPlaylistDetail(id: route.id)
                coverUrl = r.playlist.picUrl
                title = r.playlist.name
                let creator = r.playlist.creator?.nickname ?? ""
                let count = r.playlist.trackCount ?? r.tracks.count
                subtitle = creator.isEmpty ? "\(count) 首" : "\(creator) · \(count) 首"
                tracks = r.tracks
            default:
                err = describe(ApiError(status: -1, code: "unknown_kind", message: "未知的集合类型：\(route.kind)"))
            }
        } catch {
            err = describe(error)
        }
        loading = false
    }

    /// 歌手页专辑（`/api/artists/:id/albums`）。Net/ 没有这个封装，用公共 `get` + 页内私有结构直连；
    /// 响应里还有 degraded/hasMore，本批只取首批封面墙，多余字段不影响解码。
    private func loadArtistAlbums() async {
        struct Wire: Decodable {
            let name: String
            let albums: [Album]
        }
        do {
            let reply: Wire = try await APIClient.shared.get(
                "/api/artists/" + route.id + "/albums",
                query: [
                    "name": title.isEmpty ? route.name : title,
                    "limit": String(albumBatch),
                    "page": "1",
                ]
            )
            albums = reply.albums
        } catch {
            albums = []
        }
    }
}


