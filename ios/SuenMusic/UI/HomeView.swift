import SwiftUI

/**
 * 首页（发现）—— **逐区块对齐鸿蒙端 pages/HomePage.ets**（hw 又是对齐移动版 Web Home.vue ≤767px）。
 *
 * 信息层级（顺序不可变，照 hw build()）：
 *   欢迎区（昵称大字 + AI 欢迎语单行） → 新碟首发（1:1 海报横滑，一屏 2 张）
 *   → 新歌首发（最多 8 行 TrackRow） → 巅峰榜（两列封面卡）
 *
 * 质感口径同 hw：色差分层（bg/panel/panel2）+ 发丝线描边 + 顶沿内高光，**禁外阴影**。
 * 曲目行一律走公共 TrackRow（hw TrackItem 的 iOS 等价物），本页不再自绘行。
 */
struct HomeView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    /// 首屏失败文案（Copy.describe 产出）：只在**完全没有数据**时占屏
    @State private var err = ""
    /// 已收藏曲目 id（右滑收藏的动作区文案 / 序号染色；拉取失败静默）
    @State private var favIds: Set<String> = []

    /// 新歌列表展示行数（hw NEW_SONG_ROWS = 8）
    private let newSongRows = 8

    /// 队列来源（hw setQueue 的 origin）
    private static let originHome = "首页"
    /// 海报压字渐变的中间停靠点（hw posterCard：posterScrimMid 停 0.52）
    private static let scrimMidStop: CGFloat = 0.52
    /// 海报副行（歌手）文字浓度（hw opacity 0.82）
    private static let artistInk: Double = 0.82
    /// 海报压字墨色（hw Color.White）：压字区自带 posterScrim 暗渐变兜底、与主题无关，
    /// 取令牌里唯一「恒为纯白」的那枚（swipeInk），页面不出现裸色
    private static let posterInk = DesignTokens.swipeInk
    /// 海报一屏张数（hw Swiper displayCount 2）
    private static let posterPerPage = 2
    /// 非 ApiError 的兜底状态码（Copy.describe 按服务端 5xx 出话术）
    private static let fallbackStatus = 500

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
            if app.home == nil {
                await load()
            } else if let songs = app.home?.newSongs {
                await refreshFavMarks(songs)
            }
            if let songs = app.home?.newSongs { player.warm(songs, limit: newSongRows) }
        }
    }

    // MARK: - 主体

    private func content(_ home: HomeData) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                offlineBanner
                welcome(home)
                if !home.newAlbums.isEmpty {
                    // hw Copy.sectionNewAlbums（iOS Copy 表暂无区块名条目，用同字面量）
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
        .navigationDestination(for: CollectionRoute.self) { route in
            CollectionView(route: route)
        }
    }

    // MARK: - 离线横幅（hw HomePage 列表首行：离线数据 · 最后更新 HH:mm）

    /// 展示的是本地快照时的横幅；在线最新数据时 `app.offlineAt` 为 0，不占位
    @ViewBuilder
    private var offlineBanner: some View {
        if app.offlineAt > 0 {
            Text("离线数据 · 最后更新 \(Self.clock(app.offlineAt))")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Dim.s4)
                .padding(.top, Dim.s2)
                .padding(.bottom, Dim.s1)
        }
    }

    // MARK: - 欢迎区（hw：昵称大字 + 每日一言，两行都坚决单行）

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
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(phrase)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Dim.s4)
            .padding(.top, Dim.s3)
            .padding(.bottom, Dim.s1)
        }
    }

    // MARK: - 区块标题（hw 小标：11px / 0.18em 字距 / 次级灰 / 中等字重）

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: Dim.fsCaption, weight: .medium))
            .tracking(Dim.s0)
            .foregroundStyle(p.text2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Dim.s4)
            .padding(.top, Dim.s4)
            .padding(.bottom, Dim.s1)
    }

    // MARK: - 新碟海报横滑（hw Swiper displayCount 2：一屏 2 张 1:1 大卡）

    private func posterRail(_ albums: [Album]) -> some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(albums) { album in
                    NavigationLink(value: CollectionRoute(kind: "album", id: album.id, name: album.name)) {
                        posterCard(album)
                    }
                    .buttonStyle(.plain)
                    .containerRelativeFrame(.horizontal, count: Self.posterPerPage, spacing: 0)
                }
            }
            .scrollTargetLayout()
            .padding(.bottom, Dim.s5)
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollIndicators(.hidden)
    }

    /// hw posterCard：封面铺满 + 左上日期角标 + 底部渐变压字；凸面板 = panel2 底 + 发丝线 + 顶沿内高光
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

            // 顶沿内高光（hw topSheen）
            VStack(spacing: 0) {
                Rectangle().fill(p.hi).frame(height: Dim.hairline)
                Spacer(minLength: 0)
            }

            // 发行日角标（hw poster-date）：左上、dateChip 底白字；解析不出就不占位
            if let badge = Self.releaseBadge(album.publishTime), !badge.isEmpty {
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        Text(badge)
                            .font(.system(size: Dim.fsCaption))
                            .foregroundStyle(Self.posterInk)
                            .padding(.horizontal, Dim.s1)
                            .padding(.vertical, Dim.hairline)
                            .background(p.dateChip)
                            .clipShape(RoundedRectangle(cornerRadius: Dim.s0, style: .continuous))
                        Spacer(minLength: 0)
                    }
                    Spacer(minLength: 0)
                }
                .padding(Dim.s3)
            }

            // 压字区（hw poster-meta）：上暗渐变 posterScrim → posterScrimMid → 透明
            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(album.name)
                    .font(.system(size: Dim.fsBody, weight: .bold))
                    .foregroundStyle(Self.posterInk)
                    .lineLimit(2)
                Text(album.artistLine)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(Self.posterInk.opacity(Self.artistInk))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, Dim.s5)
            .padding(.horizontal, Dim.s3)
            .padding(.bottom, Dim.s3)
            .background(
                LinearGradient(
                    stops: [
                        .init(color: p.posterScrim, location: 0),
                        .init(color: p.posterScrimMid, location: Self.scrimMidStop),
                        .init(color: .clear, location: 1),
                    ],
                    startPoint: .bottom,
                    endPoint: .top
                )
            )
        }
        .aspectRatio(1, contentMode: .fit)
        .background(p.panel2)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
        .padding(.horizontal, Dim.s2)
    }

    // MARK: - 新歌首发（hw：前 8 行 TrackItem；点任意一首 = 全量 newSongs 进队列）

    private func songList(_ songs: [Track]) -> some View {
        let shown = Array(songs.prefix(newSongRows))
        return VStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, track in
                TrackRow(
                    track: track,
                    index: index + 1,
                    isFav: favIds.contains(track.id),
                    showDur: true,
                    playing: player.currentTrack?.id == track.id,
                    onTap: {
                        Task {
                            await player.play(tracks: songs, startingAt: index, origin: Self.originHome)
                        }
                    },
                    onSwipeToggle: { await toggleFav(track) }
                )
            }
        }
    }

    // MARK: - 巅峰榜（hw：两列封面卡 + 「榜」角标）

    private func toplistGrid(_ lists: [Toplist]) -> some View {
        let columns = [GridItem(.flexible(), spacing: Dim.s4), GridItem(.flexible(), spacing: Dim.s4)]
        return LazyVGrid(columns: columns, spacing: Dim.s3) {
            ForEach(lists) { list in
                NavigationLink(value: CollectionRoute(kind: "toplist", id: list.id, name: list.name)) {
                    toplistCard(list)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, Dim.s4)
        .padding(.bottom, Dim.s3)
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

                VStack(spacing: 0) {
                    Rectangle().fill(p.hi).frame(height: Dim.hairline)
                    Spacer(minLength: 0)
                }

                Text("榜")   // hw Copy.badgeToplist
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

    // MARK: - 首屏失败态（空态组件 + 重试；瞬时提示另走 ToastCenter）

    private var errorState: some View {
        EmptyState(title: err, actionTitle: "重试") {
            Task { await load() }
        }
        .padding(.top, Dim.s5)
    }

    // MARK: - 数据

    private func load() async {
        err = ""
        // 首页数据的拉取/快照/离线横幅全部落在 AppState（hw HomePage 委托 AppState 的同构做法）
        await app.loadHome()
        if let home = app.home {
            await refreshFavMarks(home.newSongs)
        } else if let text = app.errorMessage {
            // 刷新失败不覆盖已有数据（hw 同口径）；只有连数据都没有时才占屏报错
            err = text
            ToastCenter.shared.show(text)
        }
    }

    // MARK: - 收藏（右滑手势的支撑，失败静默 + toast）

    private func refreshFavMarks(_ tracks: [Track]) async {
        let unknown = tracks.map(\.id).filter { !favIds.contains($0) }
        guard !unknown.isEmpty else { return }
        favIds.formUnion(await player.favoredIds(unknown))
    }

    private func setFav(_ trackId: String, _ fav: Bool) {
        if fav { favIds.insert(trackId) } else { favIds.remove(trackId) }
    }

    /// 右滑过阈值：乐观翻转 + 服务端落地，失败回滚 + Copy.describe 文案 toast
    private func toggleFav(_ track: Track) async -> Bool {
        let wasFav = favIds.contains(track.id)
        setFav(track.id, !wasFav)
        guard let next = await player.toggleFavorite(track) else {
            setFav(track.id, wasFav)
            ToastCenter.shared.show(Copy.describe(status: Self.fallbackStatus, code: nil, message: nil))
            return false
        }
        setFav(track.id, next)
        return true
    }

    // MARK: - 文案

    /// epoch ms → HH:mm（离线横幅时间；按本地时区、24 小时制）
    private static func clock(_ ms: Double) -> String {
        clockFormatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    /// 发行日 → 「09-11」角标（hw releaseBadge 同口径：正则只认年月日，解析不出返回 nil 不占位）
    private static func releaseBadge(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty,
              let range = raw.range(of: "\\d{4}-(\\d{1,2})-(\\d{1,2})", options: .regularExpression)
        else { return nil }
        let parts = raw[range].split(separator: "-")
        guard parts.count >= 3, let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
        return String(format: "%02d-%02d", month, day)
    }
}
