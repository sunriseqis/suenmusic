import SwiftUI

/**
 * 首页（发现）—— **逐区块对齐鸿蒙端 `pages/HomePage.ets`**（hw 又是对齐移动版 Web `Home.vue` ≤767px）。
 *
 * 信息层级（顺序不可变）：
 *   欢迎区（昵称大字 + AI 欢迎语单行） → 新碟首发（1:1 海报横滑，一屏 2 张）
 *   → 新歌首发（最多 8 行） → 巅峰榜（两列封面卡）
 *
 * 质感口径同 hw：色差分层（bg/panel/panel2）+ 发丝线描边 + 顶沿内高光，**禁外阴影**。
 */
struct HomeView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    @State private var err = ""
    @State private var refreshing = false

    /// 新歌列表展示行数（hw `NEW_SONG_ROWS = 8`）
    private let newSongRows = 8

    private var p: Palette { Palette(scheme) }

    var body: some View {
        Group {
            if let home = app.home {
                content(home)
            } else if !err.isEmpty {
                errorState
            } else {
                SkeletonList(withPoster: true)
            }
        }
        .background(p.bg)
        .task {
            if app.home == nil { await app.loadHome() }
            if app.home == nil, let message = app.errorMessage { err = message }
        }
    }

    // MARK: - 主体

    private func content(_ home: HomeData) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                welcome(home)
                if !home.newAlbums.isEmpty {
                    sectionTitle("新碟首发")
                    posterRail(home.newAlbums)
                }
                if !home.newSongs.isEmpty {
                    sectionTitle("新歌首发")
                    songList(home.newSongs)
                }
                if !home.toplists.isEmpty {
                    sectionTitle("巅峰榜")
                    toplistGrid(home.toplists)
                }
            }
            .padding(.bottom, Dim.s6)
        }
        .scrollIndicators(.hidden)
        .refreshable { await refresh() }
        .navigationDestination(for: CollectionRoute.self) { route in
            CollectionView(route: route)
        }
    }

    // MARK: - 欢迎区

    @ViewBuilder
    private func welcome(_ home: HomeData) -> some View {
        if let phrase = home.welcomePhrase, !phrase.isEmpty {
            let display = app.user?.displayName ?? ""
            let name = display.isEmpty ? (app.user?.username ?? "") : display
            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(name)
                    .font(.system(size: Dim.fsBrand, weight: .bold))
                    .foregroundStyle(p.text1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(phrase)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Dim.s4)
            .padding(.top, Dim.s3)
            .padding(.bottom, Dim.s1)
        }
    }

    // MARK: - 区块标题

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: Dim.fsSection, weight: .semibold))
            .foregroundStyle(p.text1)
            .padding(.horizontal, Dim.s4)
            .padding(.top, Dim.s4)
            .padding(.bottom, Dim.s2)
    }

    // MARK: - 新碟海报横滑（一屏 2 张 1:1）

    private func posterRail(_ albums: [Album]) -> some View {
        GeometryReader { proxy in
            let cardWidth = (proxy.size.width - Dim.s4 * 2 - Dim.s4) / 2
            ScrollView(.horizontal) {
                LazyHStack(spacing: Dim.s4) {
                    ForEach(albums) { album in
                        NavigationLink(value: CollectionRoute(kind: "album", id: album.id, name: album.name)) {
                            posterCard(album)
                        }
                        .buttonStyle(.plain)
                        .frame(width: cardWidth)
                    }
                }
                .padding(.horizontal, Dim.s4)
            }
            .scrollIndicators(.hidden)
        }
        .frame(height: ((UIScreen.main.bounds.width - Dim.s4 * 3) / 2) + Dim.s2)
    }

    private func posterCard(_ album: Album) -> some View {
        ZStack(alignment: .bottomLeading) {
            AsyncImage(url: URL(string: album.picUrl)) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    p.panel2
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(1, contentMode: .fill)
            .clipped()

            VStack { Rectangle().fill(p.hi).frame(height: Dim.hairline); Spacer() }

            if let badge = Self.releaseBadge(album.publishTime), !badge.isEmpty {
                VStack {
                    HStack {
                        Text(badge)
                            .font(.system(size: Dim.fsCaption))
                            .foregroundStyle(.white)
                            .padding(.horizontal, Dim.s1)
                            .padding(.vertical, Dim.hairline)
                            .background(p.dateChip)
                            .clipShape(RoundedRectangle(cornerRadius: Dim.s0, style: .continuous))
                        Spacer()
                    }
                    .padding(Dim.s3)
                    Spacer()
                }
            }

            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(album.name)
                    .font(.system(size: Dim.fsBody, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                Text(album.artistLine)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(.white.opacity(0.82))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, Dim.s5)
            .padding(.horizontal, Dim.s3)
            .padding(.bottom, Dim.s3)
            .background(
                LinearGradient(colors: [p.posterScrim, p.posterScrimMid, .clear],
                               startPoint: .bottom, endPoint: .top)
            )
        }
        .aspectRatio(1, contentMode: .fit)
        .background(p.panel2)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
    }

    // MARK: - 新歌首发（最多 8 行）

    private func songList(_ songs: [Track]) -> some View {
        let shown = Array(songs.prefix(newSongRows))
        return VStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, track in
                songRow(track, index: index + 1, all: songs, startAt: index)
                if index < shown.count - 1 {
                    Rectangle()
                        .fill(p.line)
                        .frame(height: Dim.hairline)
                        .padding(.leading, Dim.s4 + Dim.coverSm + Dim.s3)
                }
            }
        }
    }

    private func songRow(_ track: Track, index: Int, all: [Track], startAt: Int) -> some View {
        Button {
            Task { await player.play(tracks: all, startingAt: startAt, origin: "首页") }
        } label: {
            HStack(spacing: Dim.s3) {
                Text(String(format: "%02d", index))
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
        .accessibilityLabel("\(index) \(track.name) \(track.artistLine)")
    }

    // MARK: - 巅峰榜（两列）

    private func toplistGrid(_ lists: [Toplist]) -> some View {
        let columns = [GridItem(.flexible(), spacing: Dim.s4), GridItem(.flexible(), spacing: Dim.s4)]
        return LazyVGrid(columns: columns, spacing: Dim.s4) {
            ForEach(lists) { list in
                NavigationLink(value: CollectionRoute(kind: "toplist", id: list.id, name: list.name)) {
                    toplistCard(list)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, Dim.s4)
    }

    private func toplistCard(_ list: Toplist) -> some View {
        VStack(alignment: .leading, spacing: Dim.s2) {
            ZStack(alignment: .bottomTrailing) {
                AsyncImage(url: URL(string: list.picUrl)) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        p.panel2
                    }
                }
                .frame(maxWidth: .infinity)
                .aspectRatio(1, contentMode: .fill)
                .clipped()
                VStack { Rectangle().fill(p.hi).frame(height: Dim.hairline); Spacer() }
                Text("榜")
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.badgeInk)
                    .padding(.horizontal, Dim.s1)
                    .padding(.vertical, Dim.hairline)
                    .background(p.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Dim.s0, style: .continuous))
                    .padding(Dim.s1)
            }
            .aspectRatio(1, contentMode: .fit)
            .background(p.panel2)
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .stroke(p.line, lineWidth: Dim.hairline)
            )

            Text(list.name)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text1)
                .lineLimit(2)
            if let freq = list.updateFrequency, !freq.isEmpty {
                Text(freq)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
            }
        }
    }

    // MARK: - 错误态

    private var errorState: some View {
        VStack(spacing: Dim.s3) {
            Text(err)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.danger)
            Button("重试") {
                Task { await refresh() }
            }
            .font(.system(size: Dim.fsBody))
            .foregroundStyle(p.accentText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, Dim.s5)
    }

    // MARK: - 动作

    private func refresh() async {
        refreshing = true
        err = ""
        await app.loadHome()
        if app.home == nil, let message = app.errorMessage { err = message }
        refreshing = false
    }

    /// 发行日 → 「09-11」角标（hw `releaseBadge` 同口径；解析不出返回 nil 不占位）
    private static func releaseBadge(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let parts = raw.split(separator: "-")
        guard parts.count >= 3 else { return nil }
        let month = String(parts[1])
        let day = String(parts[2].prefix(2))
        return month.count == 1 ? "0" + month + "-" + day : month + "-" + day
    }
}
