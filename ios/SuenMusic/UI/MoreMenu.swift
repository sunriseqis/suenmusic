import SwiftUI

/**
 * 更多菜单（hw PlayerPage `moreSheet`，web more-menu 同款）：
 * 音源（只读）/ 歌手 / 专辑 / 修正音源。
 *
 * hw 没有收藏、分享、下载、定时、音质这些项 —— 这里一个都不加。
 * 位置：右上角锚定（top = 安全区 + 44，右 12），宽 210。
 */
struct MoreMenu: View {
    @Environment(\.colorScheme) private var scheme

    private let sourceLabel: String
    private let artistName: String
    private let albumName: String
    private let hasArtist: Bool
    private let hasAlbum: Bool
    private let topInset: CGFloat
    private let onClose: () -> Void
    private let onArtist: () -> Void
    private let onAlbum: () -> Void
    private let onAnchor: () -> Void

    private var p: Palette { Palette(scheme) }

    init(sourceLabel: String, artistName: String, albumName: String,
         hasArtist: Bool, hasAlbum: Bool, topInset: CGFloat,
         onClose: @escaping () -> Void, onArtist: @escaping () -> Void,
         onAlbum: @escaping () -> Void, onAnchor: @escaping () -> Void) {
        self.sourceLabel = sourceLabel
        self.artistName = artistName
        self.albumName = albumName
        self.hasArtist = hasArtist
        self.hasAlbum = hasAlbum
        self.topInset = topInset
        self.onClose = onClose
        self.onArtist = onArtist
        self.onAlbum = onAlbum
        self.onAnchor = onAnchor
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            p.scrim
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture(perform: onClose)

            card
                .padding(.top, topInset + Dim.touchMin)
                .padding(.trailing, Dim.s3)
        }
    }

    private var card: some View {
        VStack(spacing: 0) {
            sourceRow
            if hasArtist || hasAlbum {
                divider
            }
            if hasArtist {
                entryRow(title: "歌手", value: artistName, a11y: "查看歌手", action: onArtist)
            }
            if hasAlbum {
                if hasArtist { divider }
                entryRow(title: "专辑", value: albumName, a11y: "查看专辑", action: onAlbum)
            }
            divider
            anchorRow
        }
        .frame(width: Dim.popW)
        .padding(Dim.s2)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous).fill(p.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
    }

    private var sourceRow: some View {
        HStack(spacing: Dim.s2) {
            Text("音源")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
            Spacer(minLength: 0)
            Text(sourceLabel)
                .font(.system(size: Dim.fsSub))
                .foregroundStyle(p.text1)
        }
        .padding(.horizontal, Dim.s2)
        .padding(.vertical, Dim.s1)
        .accessibilityLabel("音源：\(sourceLabel)")
    }

    private func entryRow(title: String, value: String, a11y: String,
                          action: @escaping () -> Void) -> some View {
        HStack(spacing: Dim.s2) {
            Text(title)
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
            Spacer(minLength: Dim.s2)
            Text(value)
                .font(.system(size: Dim.fsSub))
                .foregroundStyle(p.text1)
                .lineLimit(1)
                .truncationMode(.tail)
                .multilineTextAlignment(.trailing)
        }
        .padding(Dim.s2)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .accessibilityLabel(a11y)
    }

    private var anchorRow: some View {
        HStack(spacing: Dim.s2) {
            Text("修正音源")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
            Spacer(minLength: 0)
            Text("›")
                .font(.system(size: Dim.fsSub))
                .foregroundStyle(p.text2)
        }
        .padding(Dim.s2)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(perform: onAnchor)
        .accessibilityLabel("修正音源")
    }

    private var divider: some View {
        Rectangle()
            .fill(p.line)
            .frame(height: Dim.hairline)
            .padding(.vertical, Dim.s1)
    }
}
