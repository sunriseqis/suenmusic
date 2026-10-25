import SwiftUI
import WidgetKit
import ActivityKit

/**
 * Live Activity / 灵动岛 的三种呈现（**只加入 Widget Extension target**）。
 *
 * 与 hw 桌面卡片的对位：
 *   · 锁屏卡 = hw 2×4 卡（封面 + 歌名 + 歌手 + 进度 + 三键）
 *   · 灵动岛 compact = 左封面小图 / 右播放暂停（hw 2×2 的极简形态）
 *   · 灵动岛 minimal = 只留封面
 *   · 灵动岛 expanded = 封面 + 歌名/歌手 + 进度 + 三键
 *
 * 颜色/尺寸全部走共享的 `Palette` / `Dim`（这两个文件也要加入 widget target）。
 */
struct PlaybackLockScreenView: View {
    let state: PlaybackActivityAttributes.ContentState
    @Environment(\.colorScheme) private var scheme

    private var p: Palette { Palette(scheme) }

    var body: some View {
        HStack(spacing: Dim.s3) {
            cover(size: Dim.coverSm)

            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(state.title.isEmpty ? "暂无歌曲播放" : state.title)
                    .font(.system(size: Dim.fsSub, weight: .semibold))
                    .foregroundStyle(p.text1)
                    .lineLimit(1)
                Text(state.artist)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
                progress
            }

            HStack(spacing: Dim.s3) {
                Image(systemName: "backward.fill")
                    .font(.system(size: Dim.icon14))
                    .foregroundStyle(p.text1)
                Image(systemName: state.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: Dim.icon16))
                    .foregroundStyle(p.accent)
                Image(systemName: "forward.fill")
                    .font(.system(size: Dim.icon14))
                    .foregroundStyle(p.text1)
            }
        }
        .padding(Dim.s3)
        .activityBackgroundTint(p.panel)
        .activitySystemActionForegroundColor(p.text1)
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: Dim.s0) {
            ProgressView(value: Double(min(state.positionMs, max(state.durationMs, 1))),
                         total: Double(max(state.durationMs, 1)))
                .tint(p.accent)
            HStack {
                Text(mmss(state.positionMs))
                Spacer()
                Text(mmss(state.durationMs))
            }
            .font(.system(size: Dim.fsCaption))
            .foregroundStyle(p.text2)
        }
    }

    /// ⚠️ Live Activity 扩展**不能联网取图**（AsyncImage 在渲染进程不解析），
    /// 所以封面由主 App 下好、缩成 64×64 JPEG 塞进 ContentState（base64 随状态传过来）。
    private func cover(size: CGFloat) -> some View {
        ZStack {
            p.panel2
            if let data = state.coverJPEG, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "music.note")
                    .font(.system(size: size * 0.42))
                    .foregroundStyle(p.text2)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous))
    }

    private func mmss(_ ms: Int) -> String {
        let total = max(0, ms) / 1000
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// 灵动岛 + 锁屏的 Widget 声明（widget target 的 @main 由 Package/WidgetBundle 提供）
struct PlaybackLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PlaybackActivityAttributes.self) { context in
            PlaybackLockScreenView(state: context.state)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    PlaybackIslandCover(jpeg: context.state.coverJPEG)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(context.state.title)
                            .font(.system(size: Dim.fsMinor, weight: .semibold))
                            .lineLimit(1)
                        Text(context.state.artist)
                            .font(.system(size: Dim.fsCaption))
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    PlaybackIslandControls(playing: context.state.playing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ProgressView(value: Double(min(context.state.positionMs, max(context.state.durationMs, 1))),
                                 total: Double(max(context.state.durationMs, 1)))
                        .tint(DesignTokens.accent)
                }
            } compactLeading: {
                PlaybackIslandCover(jpeg: context.state.coverJPEG)
            } compactTrailing: {
                Image(systemName: context.state.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: Dim.icon12))
                    .foregroundStyle(DesignTokens.accent)
            } minimal: {
                PlaybackIslandCover(jpeg: context.state.coverJPEG)
            }
            .keylineTint(DesignTokens.accent)
        }
    }
}


/// widget target 的入口（@main 只能有一个；主 App 是 SuenMusicApp，这里是 WidgetBundle）
@main
struct SuenWidgetsBundle: WidgetBundle {
    var body: some Widget {
        PlaybackLiveActivityWidget()
    }
}
/// 灵动岛封面：同样不联网，静态占位（见 PlaybackLockScreenView.cover 的说明）
private struct PlaybackIslandCover: View {
    /// 主 App 塞进状态的 64×64 封面小图
    let jpeg: Data?

    var body: some View {
        ZStack {
            DesignTokens.panel2
            if let jpeg, let image = UIImage(data: jpeg) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "music.note")
                    .font(.system(size: Dim.icon12))
                    .foregroundStyle(DesignTokens.text2)
            }
        }
        .frame(width: Dim.iconXl, height: Dim.iconXl)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous))
    }
}

private struct PlaybackIslandControls: View {
    let playing: Bool

    var body: some View {
        HStack(spacing: Dim.s2) {
            Image(systemName: "backward.fill").font(.system(size: Dim.icon12))
            Image(systemName: playing ? "pause.fill" : "play.fill").font(.system(size: Dim.icon14))
            Image(systemName: "forward.fill").font(.system(size: Dim.icon12))
        }
        .foregroundStyle(DesignTokens.text1)
    }
}