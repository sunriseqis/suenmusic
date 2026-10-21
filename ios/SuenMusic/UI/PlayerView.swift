import SwiftUI

struct PlayerView: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                if let track = player.currentTrack {
                    AsyncImage(url: URL(string: track.al.picUrl)) { img in
                        img.resizable().scaledToFit()
                    } placeholder: { Color.gray.opacity(0.2) }
                    .frame(maxWidth: 320, maxHeight: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                    VStack(spacing: 6) {
                        Text(track.name).font(.title3).lineLimit(2)
                        Text(track.artistLine).foregroundStyle(.secondary)
                        Text(player.source == "netease" ? "网易云音源" : "B 站音源")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                Slider(
                    value: Binding(
                        get: { Double(player.positionMs) },
                        set: { player.seek(to: Int($0)) }
                    ),
                    in: 0...Double(max(player.durationMs, 1))
                )
                HStack {
                    Text(mmss(player.positionMs))
                    Spacer()
                    Text(mmss(player.durationMs))
                }
                .font(.caption2)
                .foregroundStyle(.secondary)

                HStack(spacing: 44) {
                    Button { player.prev() } label: { Image(systemName: "backward.fill").font(.title2) }
                    Button { player.toggle() } label: {
                        Image(systemName: player.playing ? "pause.circle.fill" : "play.circle.fill")
                            .font(.system(size: 64))
                    }
                    Button { player.next() } label: { Image(systemName: "forward.fill").font(.title2) }
                }
                if let err = player.errorMessage {
                    Text(err).font(.caption).foregroundStyle(.red)
                }
                Spacer()
            }
            .padding()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    private func mmss(_ ms: Int) -> String {
        let s = max(0, ms) / 1000
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
