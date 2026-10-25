import SwiftUI
import WidgetKit
import ActivityKit

/**
 * Live Activity / 灵动岛 的三种呈现（**只加入 Widget Extension target**）。
 *
 * 与 hw 桌面卡片的对位（hw 2×4 卡：封面 + 歌名 + 歌手 + 进度 + 三键），iOS 这里信息密度更高：
 *   · 锁屏卡     = 封面 + 歌名 + 「歌手 · 专辑」 + 歌词行 + 进度条/时间 + 三键
 *   · 灵动岛 expanded = 左封面 / 中 歌名+歌手·专辑 / 下 歌词+进度+时间 / 右 三键
 *   · 灵动岛 compact  = 左封面 / 右播放暂停
 *   · 灵动岛 minimal  = 只留封面
 *
 * 颜色/尺寸全部走共享的 `Palette` / `Dim`（这两个文件也要加入 widget target）。
 * ⚠️ 歌词/封面都由主 App 算好塞进 ContentState —— 渲染进程不能联网、也不该算时间轴。
 */
struct PlaybackLockScreenView: View {
    let state: PlaybackActivityAttributes.ContentState
    @Environment(\.colorScheme) private var scheme

    private var p: Palette { Palette(scheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: Dim.s1) {
            HStack(spacing: Dim.s3) {
                PlaybackArtwork(jpeg: state.coverJPEG, size: Dim.coverSm)
                VStack(alignment: .leading, spacing: Dim.s0) {
                    Text(state.title.isEmpty ? "暂无歌曲播放" : state.title)
                        .font(.system(size: Dim.fsSub, weight: .semibold))
                        .foregroundStyle(p.text1)
                        .lineLimit(1)
                    // 「歌手 · 专辑」一行（专辑为空则只留歌手，歌手也没就回退音源）
                    Text(PlaybackMeta.line(state))
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(p.text2)
                        .lineLimit(1)
                }
                Spacer(minLength: Dim.s1)
                PlaybackControls(playing: state.playing, compact: false)
            }
            // 歌词行：只有有歌词才占位，避免没歌词的歌留一条空行
            if !state.lyricLine.isEmpty {
                Text(state.lyricLine)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(p.accent)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // 进度条固定在最下面：上面文字再长也挤不到它
            VStack(alignment: .leading, spacing: Dim.s0) {
                ProgressView(value: Double(min(state.positionMs, max(state.durationMs, 1))),
                             total: Double(max(state.durationMs, 1)))
                    .tint(p.accent)
                HStack {
                    Text(PlaybackMeta.mmss(state.positionMs))
                    Spacer()
                    Text(PlaybackMeta.mmss(state.durationMs))
                }
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
            }
        }
        .padding(Dim.s3)
        .activityBackgroundTint(p.panel)
        .activitySystemActionForegroundColor(p.text1)
    }
}

/// 灵动岛 + 锁屏的 Widget 声明（widget target 的 @main 由 Package/WidgetBundle 提供）
struct PlaybackLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PlaybackActivityAttributes.self) { context in
            // 锁屏卡**必须有内容**：Apple 文档（Displaying live data with Live Activities）明确写
            // 「must support all presentations … The Lock Screen presentation appears on the Lock Screen
            //  of iPhone and iPad」—— 不能只留 EmptyView()。
            PlaybackLockScreenView(state: context.state)
                .widgetURL(URL(string: "suenmusic://player"))
        } dynamicIsland: { context in
            DynamicIsland {
                // 用户 2026-10-25 定的形态：**左侧封面独占一列，右侧四行**
                //   1 歌名  2 歌手·专辑  3 进度  4 歌词
                // 之前把歌词/进度放在 .bottom 区域会和封面抢横向空间，歌词也不居中 → 重排。
                // 形态：**左侧封面独占一列，右侧四行**（歌名 / 歌手·专辑 / 进度 / 歌词）。
                // ⚠️ 不能拆到 .leading / .trailing：这两个区域的宽高由系统决定（leading 很窄、trailing 很高），
                //    实测 44pt 封面被压成空白、四行被拉成大间距。整块放进 .bottom 自己排版才可控。
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: Dim.s2) {
                        HStack(alignment: .top, spacing: Dim.s2) {
                            PlaybackArtwork(jpeg: context.state.coverJPEG, size: Dim.btnMd)
                            PlaybackIslandRows(state: context.state)
                        }
                        PlaybackControls(playing: context.state.playing, compact: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                // 单击岛 → 打开 App 并落到播放页（系统规定 tap 只能打开 App，用 URL 指定落地页）
                PlaybackArtwork(jpeg: context.state.coverJPEG, size: Dim.iconSm)
                    .widgetURL(URL(string: "suenmusic://player"))
            } compactTrailing: {
                PlaybackIslandPlayPause(playing: context.state.playing)
            } minimal: {
                PlaybackArtwork(jpeg: context.state.coverJPEG, size: Dim.iconSm)
                    .widgetURL(URL(string: "suenmusic://player"))
            }
            // keylineTint 挂在 DynamicIsland 构造器上、拿不到环境 → 只能用 token 本身
            //（等价于 Palette(scheme).accent：Palette 里 accent 就是 DesignTokens.accent 的动态色）
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

/// 灵动岛 expanded 中区：歌名 + 「歌手 · 专辑」
/// 灵动岛 expanded 右侧四行：歌名 / 歌手·专辑 / 进度 / 歌词（用户 2026-10-25 定的形态）
private struct PlaybackIslandRows: View {
    let state: PlaybackActivityAttributes.ContentState
    @Environment(\.colorScheme) private var scheme

    private var p: Palette { Palette(scheme) }

    var body: some View {
        // spacing 1：四行必须紧贴，不能被系统区域拉成大间距
        VStack(alignment: .leading, spacing: 1) {
            Text(state.title.isEmpty ? "暂无歌曲播放" : state.title)
                .font(.system(size: Dim.fsMinor, weight: .semibold))
                .foregroundStyle(p.text1)
                .lineLimit(1)
            Text(PlaybackMeta.line(state))
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
                .lineLimit(1)
            ProgressView(value: Double(min(state.positionMs, max(state.durationMs, 1))),
                         total: Double(max(state.durationMs, 1)))
                .tint(p.accent)
                .scaleEffect(x: 1, y: 0.7, anchor: .center)
            Text(state.lyricLine.isEmpty ? " " : state.lyricLine.replacingOccurrences(of: "\n", with: " / "))
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(state.lyricLine.isEmpty ? p.text2 : p.accent)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PlaybackIslandTitle: View {
    let state: PlaybackActivityAttributes.ContentState
    @Environment(\.colorScheme) private var scheme

    private var p: Palette { Palette(scheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(state.title.isEmpty ? "暂无歌曲播放" : state.title)
                .font(.system(size: Dim.fsMinor, weight: .semibold))
                .foregroundStyle(p.text1)
                .lineLimit(1)
            Text(PlaybackMeta.line(state))
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
                .lineLimit(1)
        }
    }
}

/// 灵动岛 expanded 下区：歌词行 + 进度条 + 时间
private struct PlaybackIslandBottom: View {
    let state: PlaybackActivityAttributes.ContentState
    @Environment(\.colorScheme) private var scheme

    private var p: Palette { Palette(scheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: Dim.s0) {
            // 歌词行（没有就不占位）：换行即由主 App force 推过来
            if !state.lyricLine.isEmpty {
                Text(state.lyricLine)
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.accent)
                    .lineLimit(1)
            }
            HStack(spacing: Dim.s2) {
                Text(PlaybackMeta.mmss(state.positionMs))
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
                ProgressView(value: Double(min(state.positionMs, max(state.durationMs, 1))),
                             total: Double(max(state.durationMs, 1)))
                    .tint(p.accent)
                Text(PlaybackMeta.mmss(state.durationMs))
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
            }
        }
    }
}

/// 灵动岛 compact 右侧：播放 / 暂停
private struct PlaybackIslandPlayPause: View {
    let playing: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Image(systemName: playing ? "pause.fill" : "play.fill")
            .font(.system(size: Dim.icon12))
            .foregroundStyle(Palette(scheme).accent)
    }
}

/// 状态里的文字排版规则（锁屏卡与灵动岛共用一套，避免两处各写一遍）
private enum PlaybackMeta {
    /// 「歌手 · 专辑」，专辑缺失只留歌手，都没有回退音源文案
    static func line(_ state: PlaybackActivityAttributes.ContentState) -> String {
        let parts = [state.artist, state.album].filter { !$0.isEmpty }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        return state.sourceLabel
    }

    static func mmss(_ ms: Int) -> String {
        let total = max(0, ms) / 1000
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// 封面：Live Activity 扩展**不能联网取图**（AsyncImage 在渲染进程不解析），
/// 图由主 App 下好、缩成 64×64 JPEG 塞进 ContentState（base64 随状态传过来）。
private struct PlaybackArtwork: View {
    let jpeg: Data?
    let size: CGFloat
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Palette(scheme).panel2
            if let jpeg, let image = UIImage(data: jpeg) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "music.note")
                    .font(.system(size: size * 0.42))
                    .foregroundStyle(Palette(scheme).text2)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous))
    }
}

/// 三键：按钮走 AppIntent，**点按钮不打开 App**（系统后台唤醒 App 进程执行 perform）
private struct PlaybackControls: View {
    let playing: Bool
    /// 灵动岛 expanded 空间窄：图标小一号、间距紧一档
    let compact: Bool
    @Environment(\.colorScheme) private var scheme

    private var p: Palette { Palette(scheme) }

    var body: some View {
        HStack(spacing: compact ? Dim.s2 : Dim.s3) {
            Button(intent: PrevTrackIntent()) {
                Image(systemName: "backward.fill")
                    .font(.system(size: compact ? Dim.icon12 : Dim.icon14))
                    .foregroundStyle(p.text1)
            }.buttonStyle(.plain)
            Button(intent: PlayPauseIntent()) {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.system(size: compact ? Dim.icon14 : Dim.icon16))
                    .foregroundStyle(p.accent)
            }.buttonStyle(.plain)
            Button(intent: NextTrackIntent()) {
                Image(systemName: "forward.fill")
                    .font(.system(size: compact ? Dim.icon12 : Dim.icon14))
                    .foregroundStyle(p.text1)
            }.buttonStyle(.plain)
        }
    }
}
