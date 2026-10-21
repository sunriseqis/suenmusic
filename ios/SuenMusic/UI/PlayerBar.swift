import SwiftUI

struct PlayerBar: View {
    @EnvironmentObject private var player: PlaybackService
    let onExpand: () -> Void

    var body: some View {
        if let track = player.currentTrack {
            HStack(spacing: 10) {
                AsyncImage(url: URL(string: track.al.picUrl)) { img in
                    img.resizable()
                } placeholder: { Color.gray.opacity(0.2) }
                .frame(width: 40, height: 40)
                .clipShape(RoundedRectangle(cornerRadius: 6))

                VStack(alignment: .leading, spacing: 2) {
                    Text(track.name).font(.subheadline).lineLimit(1)
                    Text(track.artistLine).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Button { player.toggle() } label: {
                    Image(systemName: player.playing ? "pause.fill" : "play.fill")
                        .font(.title3)
                }
                Button { player.next() } label: {
                    Image(systemName: "forward.fill")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
            .onTapGesture(perform: onExpand)
            .background(.ultraThinMaterial)
        }
    }
}
