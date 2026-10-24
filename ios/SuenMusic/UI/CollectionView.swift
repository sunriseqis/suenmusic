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
 * 集合页 —— **对齐鸿蒙端 `pages/CollectionPage.ets`** 的骨架：
 * 头部（封面 + 标题 + 副行 + 「播放全部」）+ 曲目列表（点击进队列）。
 *
 * 四种来源：
 *   · album    → `GET /api/albums/:id`（`notice` 有值就展示）
 *   · toplist  → `GET /api/toplist/:id`（`topInfo.updateFrequency` 作副行）
 *   · artist   → `GET /api/artists/:id/songs`（只做热门歌曲列表；「专辑/相似歌手」两个 tab 待后续批次）
 *   · playlist → `GET /api/qq/playlist/:tid`
 *
 * 本批只做"能看能播"的最小闭环，歌手页的专辑网格/相似歌手与歌单页的描述折叠留后续。
 */
struct CollectionView: View {
    let route: CollectionRoute

    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    @State private var coverUrl = ""
    @State private var title = ""
    @State private var subtitle = ""
    @State private var notice = ""
    @State private var tracks: [Track] = []
    @State private var loading = false
    @State private var err = ""

    private var p: Palette { Palette(scheme) }

    var body: some View {
        Group {
            if loading && tracks.isEmpty {
                SkeletonList(withPoster: true, rows: 8)
            } else if !err.isEmpty && tracks.isEmpty {
                VStack(spacing: Dim.s3) {
                    Text(err)
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.danger)
                    Button("重试") { Task { await load() } }
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.accentText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                content
            }
        }
        .background(p.bg)
        .navigationTitle(title.isEmpty ? route.name : title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                if !notice.isEmpty {
                    Text(notice)
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(p.text2)
                        .padding(.horizontal, Dim.s4)
                        .padding(.top, Dim.s2)
                }
                if tracks.isEmpty {
                    Text("这里还没有曲目")
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.text2)
                        .frame(maxWidth: .infinity)
                        .padding(.top, Dim.s6)
                } else {
                    HStack {
                        Text("\(tracks.count) 首")
                            .font(.system(size: Dim.fsCaption))
                            .foregroundStyle(p.text2)
                        Spacer()
                        Button("播放全部") {
                            Task { await player.play(tracks: tracks, startingAt: 0, origin: originLabel) }
                        }
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.accentText)
                        .accessibilityLabel("播放全部")
                    }
                    .padding(.horizontal, Dim.s4)
                    .padding(.top, Dim.s3)

                    ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                        Button {
                            Task { await player.play(tracks: tracks, startingAt: index, origin: originLabel) }
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
                }
            }
            .padding(.bottom, Dim.s6)
        }
        .scrollIndicators(.hidden)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Dim.s3) {
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
            .frame(width: Dim.coverXl * 0.4 + 40, height: Dim.coverXl * 0.4 + 40)
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .stroke(p.line, lineWidth: Dim.hairline)
            )

            VStack(alignment: .leading, spacing: Dim.s1) {
                Text(title.isEmpty ? route.name : title)
                    .font(.system(size: Dim.fsHeadline, weight: .semibold))
                    .foregroundStyle(p.text1)
                    .lineLimit(3)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: Dim.fsMinor))
                        .foregroundStyle(p.text2)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s3)
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

    private func load() async {
        loading = true
        err = ""
        do {
            switch route.kind {
            case "album":
                let r = try await APIClient.shared.albumDetail(id: route.id)
                coverUrl = r.album.picUrl
                title = r.album.name
                subtitle = r.album.artistLine
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
            case "playlist":
                let r = try await APIClient.shared.qqPlaylistDetail(id: route.id)
                coverUrl = r.playlist.picUrl
                title = r.playlist.name
                let creator = r.playlist.creator?.nickname ?? ""
                let count = r.playlist.trackCount ?? r.tracks.count
                subtitle = creator.isEmpty ? "\(count) 首" : "\(creator) · \(count) 首"
                tracks = r.tracks
            default:
                err = "未知的集合类型：\(route.kind)"
            }
        } catch {
            err = (error as? ApiError)?.message ?? error.localizedDescription
        }
        loading = false
    }
}
