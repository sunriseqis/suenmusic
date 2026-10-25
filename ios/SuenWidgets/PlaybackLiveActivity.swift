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
                // 有歌词就把「歌手」这一行换成**当前歌词行**（滚到哪唱到哪），没有则回退歌手名。
                // 歌词由主 App 按播放位置算好随 ContentState 推过来 —— 渲染进程不能联网、也不该算时间轴。
                Text(state.lyricLine.isEmpty ? state.artist : state.lyricLine)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(state.lyricLine.isEmpty ? p.text2 : p.accent)
                    .lineLimit(2)
                progress
            }

            HStack(spacing: Dim.s3) {
                Button(intent: PrevTrackIntent()) {
                    Image(systemName: "backward.fill")
                        .font(.system(size: Dim.icon14))
                        .foregroundStyle(p.text1)
                }.buttonStyle(.plain)
                Button(intent: PlayPauseIntent()) {
                    Image(systemName: state.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: Dim.icon16))
                        .foregroundStyle(p.accent)
                }.buttonStyle(.plain)
                Button(intent: NextTrackIntent()) {
                    Image(systemName: "forward.fill")
                        .font(.system(size: Dim.icon14))
                        .foregroundStyle(p.text1)
                }.buttonStyle(.plain)
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
            // 锁屏卡**必须有内容**：Apple 文档（Displaying live data with Live Activities）明确写
            // 「must support all presentations … The Lock Screen presentation appears on the Lock Screen
            //  of iPhone and iPad」—— 不能只留灵动岛。之前返回 EmptyView() 的结果是锁屏上一个空壳面板，
            // 比重复更难看，所以这里用完整卡（与 hw 2×4 卡片对位）。
            PlaybackLockScreenView(state: context.state)
                .widgetURL(URL(string: "suenmusic://player"))
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
                        // 灵动岛 expanded 的 center：有歌词显示歌词行，没有则显示歌手
                        Text(context.state.lyricLine.isEmpty ? context.state.artist : context.state.lyricLine)
                            .font(.system(size: Dim.fsCaption))
                            .foregroundStyle(.secondary)
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
                // 单击岛 → 打开 App 并落到播放页（系统规定 tap 只能打开 App，用 URL 指定落地页）
                PlaybackIslandCover(jpeg: context.state.coverJPEG)
                    .widgetURL(URL(string: "suenmusic://player"))
            } compactTrailing: {
                Image(systemName: context.state.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: Dim.icon12))
                    .foregroundStyle(DesignTokens.accent)
            } minimal: {
                PlaybackIslandCover(jpeg: context.state.coverJPEG)
                    .widgetURL(URL(string: "suenmusic://player"))
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

/// 岛内遥控器：按钮走 AppIntent，**点按钮不打开 App**（系统后台唤醒 App 进程执行 perform）
private struct PlaybackIslandControls: View {
    let playing: Bool

    var body: some View {
        HStack(spacing: Dim.s2) {
            Button(intent: PrevTrackIntent()) {
                Image(systemName: "backward.fill").font(.system(size: Dim.icon12))
            }
            .buttonStyle(.plain)
            .foregroundStyle(DesignTokens.text1)

            Button(intent: PlayPauseIntent()) {
                Image(systemName: playing ? "pause.fill" : "play.fill").font(.system(size: Dim.icon14))
            }
            .buttonStyle(.plain)
            .foregroundStyle(DesignTokens.accent)

            Button(intent: NextTrackIntent()) {
                Image(systemName: "forward.fill").font(.system(size: Dim.icon12))
            }
            .buttonStyle(.plain)
            .foregroundStyle(DesignTokens.text1)
        }
    }
}