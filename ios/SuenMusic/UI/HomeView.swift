import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var player: PlaybackService

    var body: some View {
        List {
            if let phrase = app.home?.welcomePhrase, !phrase.isEmpty {
                Section { Text(phrase).font(.headline) }
            }
            if let songs = app.home?.newSongs, !songs.isEmpty {
                Section("新歌首发") {
                    ForEach(Array(songs.enumerated()), id: \.element.id) { idx, track in
                        TrackRow(track: track, isCurrent: player.currentTrack?.id == track.id) {
                            Task { await player.play(tracks: songs, startingAt: idx) }
                        }
                    }
                }
            }
            if let lists = app.home?.toplists, !lists.isEmpty {
                Section("榜单") {
                    ForEach(lists) { l in
                        HStack {
                            Text(l.name)
                            Spacer()
                            if let f = l.updateFrequency { Text(f).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            if app.loadingHome {
                Section { ProgressView() }
            }
        }
        .navigationTitle("首页")
        .refreshable { await app.loadHome() }
        .overlay {
            if app.home == nil, app.loadingHome { ProgressView("加载中…") }
        }
    }
}

struct TrackRow: View {
    let track: Track
    let isCurrent: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                AsyncImage(url: URL(string: track.al.picUrl)) { img in
                    img.resizable()
                } placeholder: {
                    Color.gray.opacity(0.2)
                }
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 6))

                VStack(alignment: .leading, spacing: 2) {
                    Text(track.name)
                        .lineLimit(1)
                        .foregroundStyle(isCurrent ? .orange : .primary)
                    Text(track.artistLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }
        }
        .buttonStyle(.plain)
    }
}
