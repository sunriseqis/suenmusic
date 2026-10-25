import SwiftUI

/**
 * 「不喜欢」两选弹窗（**自绘哑光风格**，hw `common/DislikeDialog.ets` 同款）。
 *
 * 结构与页面其余浮层同体系：scrim 背板 + panel 卡片 + 发丝线描边；
 * 两个选项各带说明副行，无歌手信息时「这位歌手」置灰。
 *
 * 只负责选范围；落地动作（toast / 移出推荐 / 队列摘除）由页面回调承担。
 */
struct DislikeDialog: View {
    @Environment(\.colorScheme) private var scheme

    private let trackName: String
    private let artistName: String
    private let onTrack: () -> Void
    private let onArtist: () -> Void
    private let onCancel: () -> Void

    /// 卡片宽占**可用宽度**（安全区内父容器宽度）的比例（hw `width('86%')`）
    private static let cardRatio: CGFloat = 0.86
    /// 无歌手信息时「这位歌手」的置灰透明度（hw `.opacity(0.5)`）
    private static let disabledOpacity: Double = 0.5

    private var p: Palette { Palette(scheme) }

    init(trackName: String, artistName: String,
         onTrack: @escaping () -> Void, onArtist: @escaping () -> Void,
         onCancel: @escaping () -> Void) {
        self.trackName = trackName
        self.artistName = artistName
        self.onTrack = onTrack
        self.onArtist = onArtist
        self.onCancel = onCancel
    }

    private var hasArtist: Bool { !artistName.isEmpty }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                p.scrim
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onCancel)
                card.frame(width: proxy.size.width * Self.cardRatio)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var card: some View {
        VStack(spacing: Dim.s2) {
            Text("不喜欢")
                .font(.system(size: Dim.fsTitle, weight: .medium))
                .foregroundStyle(p.text1)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(trackName.isEmpty ? "" : "《\(trackName)》")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
                .lineLimit(2)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, Dim.s1)

            optionRow(icon: .dislikeSong, title: "不喜欢这首歌",
                      sub: "后续不再推荐这首歌", enabled: true,
                      a11y: "不喜欢这首歌", action: onTrack)
            optionRow(icon: .dislikeArtist, title: "不喜欢这位歌手",
                      sub: hasArtist ? "后续不再推荐歌手「\(artistName)」" : "这首歌没有歌手信息",
                      enabled: hasArtist, a11y: "不喜欢这位歌手") {
                if hasArtist { onArtist() }
            }

            Text("取消")
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .frame(height: Dim.touchMin)
                .contentShape(Rectangle())
                .onTapGesture(perform: onCancel)
                .accessibilityLabel("取消")
        }
        .padding(Dim.s4)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous).fill(p.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
    }

    private func optionRow(icon: WebIconName, title: String, sub: String,
                           enabled: Bool, a11y: String,
                           action: @escaping () -> Void) -> some View {
        HStack(spacing: Dim.s3) {
            WebIcon(icon, size: Dim.icon13)
                .foregroundStyle(enabled ? p.danger : p.text2)
            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(title)
                    .font(.system(size: Dim.fsBody, weight: .medium))
                    .foregroundStyle(p.text1)
                Text(sub)
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Dim.s3)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous).fill(p.panel2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
        .opacity(enabled ? 1 : Self.disabledOpacity)
        .contentShape(Rectangle())
        .onTapGesture {
            if enabled { action() }
        }
        .accessibilityLabel(a11y)
    }
}
