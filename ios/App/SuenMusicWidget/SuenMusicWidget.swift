/**
 * iOS 桌面卡片：2×2 与 4×2。
 *
 * 只读展示：iOS 的第三方 Widget 不能直接控制正在播放的 AVAudioPlayer，
 * 点击卡片通过 widgetURL 打开 App。传输控制在 App 内完成。
 */
import SwiftUI
import WidgetKit

private let cardBg = Color(red: 0.09, green: 0.098, blue: 0.114)
private let cardT1 = Color(red: 0.91, green: 0.90, blue: 0.88)
private let cardT2 = Color(red: 0.55, green: 0.54, blue: 0.51)
private let cardAccent = Color(red: 0.91, green: 0.64, blue: 0.24)

struct SuenEntry: TimelineEntry {
    let date: Date
    let snap: WidgetNowPlaying
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> SuenEntry {
        SuenEntry(date: Date(), snap: .empty)
    }

    func getSnapshot(in context: Context, completion: @escaping (SuenEntry) -> Void) {
        completion(SuenEntry(date: Date(), snap: SharedNowPlaying.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SuenEntry>) -> Void) {
        let entry = SuenEntry(date: Date(), snap: SharedNowPlaying.read())
        // 数据由 App 主动 reload；这里给一个兜底刷新
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
    }
}

private func elapsedText(_ ms: Int) -> String {
    guard ms > 0 else { return "0:00" }
    let sec = ms / 1000
    return String(format: "%d:%02d", sec / 60, sec % 60)
}

/// App 被系统挂起/杀掉后不会再写快照：超过 90 秒没更新就按「已暂停」显示，
/// 避免进度条停在某个位置却看起来还在播。
private func isStale(_ snap: WidgetNowPlaying) -> Bool {
    snap.playing && Date().timeIntervalSince1970 - snap.updatedAt > 90
}

private func totalText(_ ms: Int) -> String {
    guard ms > 0 else { return "--:--" }
    let sec = ms / 1000
    return String(format: "%d:%02d", sec / 60, sec % 60)
}

private struct Cover: View {
    let side: CGFloat
    var body: some View {
        Group {
            if let url = SharedNowPlaying.coverURL,
               let ui = UIImage(contentsOfFile: url.path) {
                Image(uiImage: ui).resizable().scaledToFill()
            } else {
                ZStack {
                    LinearGradient(
                        colors: [Color(white: 0.24), Color(white: 0.10)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                    Image(systemName: "music.note")
                        .font(.system(size: side * 0.32, weight: .light))
                        .foregroundColor(cardT2.opacity(0.7))
                }
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color.white.opacity(0.10), lineWidth: 1)
        )
    }
}

private struct Progress: View {
    let value: Double
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.14))
                Capsule().fill(cardAccent)
                    .frame(width: max(0, min(1, value)) * geo.size.width)
            }
        }
        .frame(height: 2)
    }
}

private func lyricWindow(_ snap: WidgetNowPlaying) -> [WidgetLyricLine] {
    guard !snap.lyrics.isEmpty else { return [] }
    var idx = snap.lyrics.lastIndex(where: { $0.ms <= snap.positionMs }) ?? 0
    if idx > 0 { idx -= 1 }
    let end = min(snap.lyrics.count, idx + 4)
    return Array(snap.lyrics[idx..<end])
}

/// 传输三键：上一首 / 播放暂停 / 下一首。
///
/// iOS 17+ 由 AppIntent 真正驱动（见 PlaybackIntents.swift）；
/// 15/16 不渲染这颗视图 —— 那个版本点了没有接收方，画出来是骗人。
/// 空态下整组置灰：没有队列时这些命令本来就会失败。
@available(iOS 17.0, *)
private struct TransportKeys: View {
    let snap: WidgetNowPlaying
    /// 横向 = 2×2 底部；纵向 = 4×2 右轨
    var vertical = false
    /// 2×2 用 30pt 播放键，4×2 用 34pt
    var compact = false

    private var gap: CGFloat { vertical ? 12 : 10 }
    private var keySize: CGFloat { compact ? 30 : 34 }
    private var glyph: CGFloat { compact ? 10 : 12 }

    private var sideColor: Color { snap.isEmpty ? cardT2.opacity(0.35) : cardT2 }

    private var keys: some View {
        Group {
            Button(intent: SuenPreviousTrackIntent()) {
                Image(systemName: "backward.fill")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(sideColor)
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.plain)
            Button(intent: SuenPlayPauseIntent()) {
                ZStack {
                    Circle()
                        .fill(snap.isEmpty ? cardT2.opacity(0.25) : cardAccent)
                    Image(systemName: snap.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: glyph, weight: .bold))
                        .foregroundColor(snap.isEmpty ? cardT2 : Color(red: 0.10, green: 0.07, blue: 0.02))
                        .offset(x: snap.playing ? 0 : 1, y: 0)
                }
                .frame(width: keySize, height: keySize)
            }
            .buttonStyle(.plain)
            Button(intent: SuenNextTrackIntent()) {
                Image(systemName: "forward.fill")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(sideColor)
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.plain)
        }
    }

    var body: some View {
        // 空态置灰：没有队列时这三颗命令本来就会失败，不如直接不给反应
        Group {
            if vertical {
                VStack(spacing: gap) { keys }
            } else {
                HStack(spacing: gap) { keys }
            }
        }
        .disabled(snap.isEmpty)
    }
}

private struct SmallView: View {
    let snap: WidgetNowPlaying
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Cover(side: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(snap.title)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(cardT1)
                        .lineLimit(2)
                    if !snap.artist.isEmpty {
                        Text(snap.artist)
                            .font(.system(size: 9.5))
                            .foregroundColor(cardT2)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            Spacer(minLength: 0)
            Text(isStale(snap) ? "已暂停" : elapsedText(snap.positionMs))
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(cardT2)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.bottom, 4)
            Progress(value: snap.durationMs > 0 ? Double(snap.positionMs) / Double(snap.durationMs) : 0)
                .opacity(isStale(snap) ? 0.35 : 1)
            if #available(iOS 17.0, *) {
                TransportKeys(snap: snap, compact: true)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            }
        }
        .padding(10)
    }
}

private struct MediumView: View {
    let snap: WidgetNowPlaying
    var body: some View {
        HStack(spacing: 0) {
            // 封面格：垂直居中，右侧发丝线
            Cover(side: 84)
                .frame(maxHeight: .infinity)
                .padding(.horizontal, 16)
                .overlay(alignment: .trailing) {
                    Rectangle()
                        .fill(Color.white.opacity(0.10))
                        .frame(width: 1)
                }
            VStack(alignment: .leading, spacing: 0) {
                Text(snap.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(cardT1)
                    .lineLimit(1)
                if !snap.artist.isEmpty {
                    Text(snap.artist)
                        .font(.system(size: 10))
                        .foregroundColor(cardT2)
                        .lineLimit(1)
                        .padding(.top, 2)
                }
                Spacer(minLength: 0)
                let lines = lyricWindow(snap)
                if lines.isEmpty {
                    Text("暂无歌词")
                        .font(.system(size: 10))
                        .foregroundColor(cardT2.opacity(0.7))
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            let active = line.ms <= snap.positionMs &&
                                (lines.last(where: { $0.ms <= snap.positionMs })?.ms == line.ms)
                            Text(line.text)
                                .font(.system(size: active ? 11 : 10, weight: active ? .bold : .regular))
                                .foregroundColor(active ? cardAccent : cardT2)
                                .lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    Text(isStale(snap) ? "已暂停" : elapsedText(snap.positionMs))
                    Progress(value: snap.durationMs > 0 ? Double(snap.positionMs) / Double(snap.durationMs) : 0)
                    Text(totalText(snap.durationMs))
                }
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(cardT2)
            }
            .padding(.horizontal, 14)

            // 运输轨格：三键纵向居中，左侧发丝线
            if #available(iOS 17.0, *) {
                TransportKeys(snap: snap, vertical: true)
                    .frame(width: 56, maxHeight: .infinity)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(Color.white.opacity(0.10))
                            .frame(width: 1)
                    }
            }
        }
        .padding(.vertical, 12)
    }
}

struct SuenWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SuenEntry

    var body: some View {
        Group {
            if family == .systemMedium {
                MediumView(snap: entry.snap)
            } else {
                SmallView(snap: entry.snap)
            }
        }
        .widgetURL(URL(string: "suenmusic://nowplaying"))
        .modifier(CardBackground())
    }
}

private struct CardBackground: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            content.containerBackground(for: .widget) { cardBg }
        } else {
            content.background(cardBg)
        }
    }
}

@main
struct SuenMusicWidget: Widget {
    let kind = "SuenMusicWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            SuenWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("正在播放")
        .description("显示当前歌曲、封面与歌词")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
