import SwiftUI

/**
 * 搜索页 —— **对齐鸿蒙端 `pages/SearchPage.ets`**。
 *
 * 与 hw 相同：搜索框 + 四分片（歌曲/专辑/歌手/歌单）+ 分片级翻页 + 最近搜索（本地，最多 10 条，
 * 键 `recent_search` 同 hw）+ 空态/骨架/错误。
 * 计数文案同 hw `countLabel`：上游还有下一页时标 `N+`（服务端没有总数字段，不假装知道）。
 *
 * **本批限制**：只有「歌曲」分片可播放；专辑/歌手/歌单卡片的详情页属批⑥，暂不挂跳转。
 */
struct SearchView: View {
    @EnvironmentObject private var app: AppState
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
    @State private var err = ""
    @State private var recent: [String] = []

    private let sliceTypes = ["song", "album", "artist", "playlist"]
    private let sliceLabels = ["歌曲", "专辑", "歌手", "歌单"]
    /// 与 hw `RECENT_MAX` 同值
    private let recentMax = 10
    private let recentKey = "recent_search"

    private var p: Palette { Palette(scheme) }

    var body: some View {
        VStack(spacing: 0) {
            searchBar
            if !recent.isEmpty && submitted.isEmpty {
                recentBlock
            }
            if submitted.isEmpty {
                emptyHint
            } else {
                sliceBar
                results
            }
        }
        .background(p.bg)
        .onAppear { loadRecent() }
    }

    // MARK: - 搜索框

    private var searchBar: some View {
        HStack(spacing: Dim.s2) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: Dim.icon16))
                .foregroundStyle(p.text2)
            TextField("搜索歌曲 / 专辑 / 歌手", text: $keyword)
                .font(.system(size: Dim.fsSub))
                .foregroundStyle(p.text1)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { trigger() }
            if !keyword.isEmpty {
                Button {
                    keyword = ""
                    submitted = ""
                    clearResults()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: Dim.icon16))
                        .foregroundStyle(p.text2)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清空搜索框")
            }
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
        .padding(.top, Dim.s3)
    }

    // MARK: - 最近搜索

    private var recentBlock: some View {
        VStack(alignment: .leading, spacing: Dim.s2) {
            HStack {
                Text("最近搜索")
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
                Spacer()
                Button("清空") {
                    recent = []
                    saveRecent()
                }
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .accessibilityLabel("清空最近搜索")
            }
            ForEach(recent, id: \.self) { item in
                HStack(spacing: Dim.s2) {
                    Button {
                        keyword = item
                        trigger()
                    } label: {
                        Text(item)
                            .font(.system(size: Dim.fsBody))
                            .foregroundStyle(p.text1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(height: Dim.touchMin)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Button("删除") {
                        recent.removeAll { $0 == item }
                        saveRecent()
                    }
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(p.text2)
                    .accessibilityLabel("删除搜索记录 \(item)")
                }
            }
        }
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s3)
    }

    // MARK: - 分片

    private var sliceBar: some View {
        HStack(spacing: Dim.s2) {
            ForEach(0..<sliceLabels.count, id: \.self) { i in
                Button {
                    if slice != i {
                        slice = i
                        Task { await doSearch(page: 1) }
                    }
                } label: {
                    Text("\(sliceLabels[i]) \(countLabel(count(i), more: hasMore[i]))")
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(slice == i ? p.onAccent : p.text2)
                        .padding(.horizontal, Dim.s3)
                        .frame(height: Dim.segH)
                        .background(slice == i ? p.accent : p.panel2)
                        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusTab, style: .continuous))
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s3)
    }

    // MARK: - 结果

    @ViewBuilder
    private var results: some View {
        if searching && !hasAnyResult {
            SkeletonList(withPoster: false, rows: 8)
        } else if !err.isEmpty {
            VStack(spacing: Dim.s3) {
                Text(err)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.danger)
                Button("重试") { Task { await doSearch(page: 1) } }
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.accentText)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, Dim.s5)
        } else if !hasAnyResult && !searching {
            Text("没有找到「\(submitted)」")
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .padding(.top, Dim.s5)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if slice == 0 {
                        ForEach(Array(songs.enumerated()), id: \.element.id) { index, track in
                            songRow(track, index: index)
                        }
                    } else {
                        grid
                    }
                    footer
                }
                .padding(.bottom, Dim.s6)
            }
            .scrollIndicators(.hidden)
        }
    }

    private var grid: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: Dim.s3), count: 4)
        return LazyVGrid(columns: columns, spacing: Dim.s3) {
            switch slice {
            case 1:
                ForEach(albums) { album in
                    coverCell(url: album.picUrl, title: album.name, sub: album.artistLine, circle: false)
                }
            case 2:
                ForEach(artists) { artist in
                    coverCell(url: "", title: artist.name, sub: "", circle: true)
                }
            default:
                ForEach(playlists) { list in
                    coverCell(url: list.picUrl, title: list.name, sub: list.subLine, circle: false)
                }
            }
        }
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s3)
    }

    private func coverCell(url: String, title: String, sub: String, circle: Bool) -> some View {
        VStack(alignment: .leading, spacing: Dim.s1) {
            Group {
                if circle {
                    Circle().fill(p.panel2)
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
            .clipShape(circle
                ? AnyShape(Circle())
                : AnyShape(RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous)))
            .overlay(
                Group {
                    if circle {
                        Circle().stroke(p.line, lineWidth: Dim.hairline)
                    } else {
                        RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous)
                            .stroke(p.line, lineWidth: Dim.hairline)
                    }
                }
            )
            Text(title)
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text1)
                .lineLimit(2)
            if !sub.isEmpty {
                Text(sub)
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
            }
        }
    }

    private func songRow(_ track: Track, index: Int) -> some View {
        Button {
            Task { await player.play(tracks: songs, startingAt: index, origin: "搜索") }
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
            .padding(.horizontal, Dim.s4)
            .frame(height: Dim.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(track.name) \(track.artistLine)")
    }

    @ViewBuilder
    private var footer: some View {
        if loadingMore {
            Text("加载中…")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Dim.s4)
        } else if hasMore[slice] {
            Button("加载更多") {
                Task { await doSearch(page: page + 1) }
            }
            .font(.system(size: Dim.fsBody))
            .foregroundStyle(p.accentText)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Dim.s4)
        } else if hasAnyResult {
            Text("没有更多了")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Dim.s4)
        }
    }

    private var emptyHint: some View {
        Text("输入关键词开始搜索")
            .font(.system(size: Dim.fsBody))
            .foregroundStyle(p.text2)
            .frame(maxWidth: .infinity)
            .padding(.top, Dim.s6)
    }

    // MARK: - 逻辑

    private func count(_ i: Int) -> Int {
        switch i {
        case 0: return songs.count
        case 1: return albums.count
        case 2: return artists.count
        default: return playlists.count
        }
    }

    private var hasAnyResult: Bool {
        !songs.isEmpty || !albums.isEmpty || !artists.isEmpty || !playlists.isEmpty
    }

    /// hw `countLabel`：还有下一页就标 N+
    private func countLabel(_ n: Int, more: Bool) -> String {
        more ? "\(n)+" : "\(n)"
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
        } catch {
            err = (error as? ApiError)?.message ?? error.localizedDescription
        }
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
