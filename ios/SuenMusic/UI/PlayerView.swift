import SwiftUI

/**
 * 播放页 —— **对齐鸿蒙端 `pages/PlayerPage.ets`** 的核心呈现口径。
 *
 * 顶栏三件里本批只做两件：收起（chevron-down，44 触控区）+ 居中 eyebrow；
 * 「更多」菜单与歌词面板待后续批次（歌词视图还没建，先不放死按钮）。
 *
 * **失败呈现规格（用户 2026-10-23 定稿，两端必须一致）**：
 *   · 列表连播失败 → 页面**不显示任何报错**（只发系统通知 + 自动跳过）；
 *   · 手动点这首歌失败 → **不跳、不弹任何按钮**，只在 eyebrow 显示「无音源」。
 * 所以这里**没有**错误横幅、没有重试/跳过按钮 —— 修音源入口在「更多 → 修正音源」（待批）。
 */
struct PlayerView: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    private var p: Palette { Palette(scheme) }

    var body: some View {
        VStack(spacing: 0) {
            header
            cover
            meta
            progress
            controls
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Dim.s5)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(p.bg)
    }

    // MARK: - 顶栏（收起 / eyebrow）

    private var header: some View {
        HStack(spacing: 0) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: Dim.iconMd))
                    .foregroundStyle(p.text1)
                    .frame(width: Dim.touchMin, height: Dim.touchMin)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("收起播放页")

            Spacer(minLength: Dim.s2)

            Text(player.eyebrowText)
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(player.noSource ? p.danger : p.text2)
                .lineLimit(1)
                .truncationMode(.tail)
                .accessibilityLabel(player.eyebrowText)

            Spacer(minLength: Dim.s2)
            // 右占位与左侧收起键等宽，保证 eyebrow 真正居中
            Color.clear.frame(width: Dim.touchMin, height: Dim.touchMin)
        }
        .padding(.top, Dim.s1)
        .padding(.bottom, Dim.s2)
    }

    // MARK: - 封面（含环境光晕）

    private var cover: some View {
        ZStack {
            if let track = player.currentTrack {
                AsyncImage(url: URL(string: track.al.picUrl)) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill().blur(radius: Dim.glowBlur * Dim.posterRatio)
                    } else {
                        Color.clear
                    }
                }
                .opacity(0.35)

                AsyncImage(url: URL(string: track.al.picUrl)) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        p.panel2
                    }
                }
                .frame(width: Dim.coverXl, height: Dim.coverXl)
                .clipShape(RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous)
                        .stroke(p.line, lineWidth: Dim.hairline)
                )
            }
        }
        .frame(height: Dim.coverXl)
        .frame(maxWidth: .infinity)
        .padding(.top, Dim.s4)
    }

    // MARK: - 曲名 / 歌手 · 专辑 / 音源

    private var meta: some View {
        VStack(spacing: Dim.s1) {
            Text(player.currentTrack?.name ?? "暂无歌曲播放")
                .font(.system(size: Dim.fsHero, weight: .semibold))
                .foregroundStyle(p.text1)
                .lineLimit(2)
                .multilineTextAlignment(.center)

            Text(subtitleLine)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text2)
                .lineLimit(1)
                .truncationMode(.tail)

            Text("音源：" + player.sourceLabel)
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
                .accessibilityLabel("音源：" + player.sourceLabel)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Dim.s4)
    }

    /// 「歌手 · 专辑」（艺术家为空时只留专辑，与 hw 同口径）
    private var subtitleLine: String {
        guard let track = player.currentTrack else { return "" }
        let artist = track.artistLine
        let album = track.al.name
        return album.isEmpty ? artist : "\(artist) · \(album)"
    }

    // MARK: - 进度

    private var progress: some View {
        VStack(spacing: Dim.s1) {
            Slider(
                value: Binding(
                    get: { Double(min(player.positionMs, max(player.durationMs, 1))) },
                    set: { player.seek(to: Int($0)) }
                ),
                in: 0...Double(max(player.durationMs, 1))
            )
            .tint(p.accent)
            .accessibilityLabel("播放进度")

            HStack {
                Text(Self.mmss(player.positionMs))
                Spacer()
                Text(Self.mmss(player.durationMs))
            }
            .font(.system(size: Dim.fsCaption))
            .foregroundStyle(p.text2)
        }
        .padding(.top, Dim.s5)
    }

    // MARK: - 三键（主键圆形 64）

    private var controls: some View {
        HStack(spacing: Dim.s6) {
            Button {
                player.prev()
            } label: {
                Image(systemName: "backward.fill")
                    .font(.system(size: Dim.iconLg))
                    .foregroundStyle(p.text1)
                    .frame(width: Dim.touchMin, height: Dim.touchMin)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("上一首")

            Button {
                player.toggle()
            } label: {
                Image(systemName: player.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: Dim.iconXl))
                    .foregroundStyle(p.onAccent)
                    .frame(width: Dim.btnPlayCircle, height: Dim.btnPlayCircle)
                    .background(p.accent)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(player.playing ? "暂停" : "播放")

            Button {
                player.next()
            } label: {
                Image(systemName: "forward.fill")
                    .font(.system(size: Dim.iconLg))
                    .foregroundStyle(p.text1)
                    .frame(width: Dim.touchMin, height: Dim.touchMin)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("下一首")
        }
        .padding(.top, Dim.s6)
    }

    private static func mmss(_ ms: Int) -> String {
        let total = max(0, ms) / 1000
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
