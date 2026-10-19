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
            Text(elapsedText(snap.positionMs))
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(cardT2)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.bottom, 4)
            Progress(value: snap.durationMs > 0 ? Double(snap.positionMs) / Double(snap.durationMs) : 0)
        }
        .padding(10)
    }
}

private struct MediumView: View {
    let snap: WidgetNowPlaying
    var body: some View {
        HStack(spacing: 14) {
            Cover(side: 84)
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
                    Text(elapsedText(snap.positionMs))
                    Progress(value: snap.durationMs > 0 ? Double(snap.positionMs) / Double(snap.durationMs) : 0)
                    Text(totalText(snap.durationMs))
                }
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(cardT2)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
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
