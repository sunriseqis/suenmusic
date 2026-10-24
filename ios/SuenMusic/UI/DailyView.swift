import SwiftUI

/**
 * 每日推荐（「专属」tab）—— **对齐鸿蒙端 `pages/DailyPage.ets`**。
 *
 * 只读：歌单由服务端每天 00:30 产出，**没有「换一批」**。
 * 头部：问候/欢迎语 + 日期；列表：曲目行（点击进队列，来源「每日推荐」）；
 * 异常态：`message` 有值就原样展示（服务端给的失败原因），否则通用文案。
 */
struct DailyView: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    @State private var data: DailyRecommend?
    @State private var loading = false
    @State private var err = ""

    private var p: Palette { Palette(scheme) }

    var body: some View {
        Group {
            if loading && data == nil {
                SkeletonList(withPoster: false, rows: 8)
            } else if let data {
                content(data)
            } else if !err.isEmpty {
                VStack(spacing: Dim.s3) {
                    Text(err)
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.danger)
                    Button("重试") { Task { await load() } }
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.accentText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                SkeletonList(withPoster: false, rows: 8)
            }
        }
        .background(p.bg)
        .task { if data == nil { await load() } }
    }

    private func content(_ data: DailyRecommend) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let greeting = data.greeting, !greeting.isEmpty {
                    Text(greeting)
                        .font(.system(size: Dim.fsBrand, weight: .bold))
                        .foregroundStyle(p.text1)
                        .padding(.horizontal, Dim.s4)
                        .padding(.top, Dim.s3)
                }
                if let phrase = data.welcomePhrase, !phrase.isEmpty {
                    Text(phrase)
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.text2)
                        .lineLimit(2)
                        .padding(.horizontal, Dim.s4)
                        .padding(.top, Dim.s1)
                }
                if let date = data.date, !date.isEmpty {
                    Text(date)
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(p.text2)
                        .padding(.horizontal, Dim.s4)
                        .padding(.top, Dim.s1)
                }

                if data.tracks.isEmpty {
                    Text(data.message?.isEmpty == false ? (data.message ?? "") : "今日歌单生成失败")
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.text2)
                        .frame(maxWidth: .infinity)
                        .padding(.top, Dim.s6)
                } else {
                    HStack {
                        Text("\(data.tracks.count) 首")
                            .font(.system(size: Dim.fsCaption))
                            .foregroundStyle(p.text2)
                        Spacer()
                        Button("播放全部") {
                            Task { await player.play(tracks: data.tracks, startingAt: 0, origin: "每日推荐") }
                        }
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.accentText)
                        .accessibilityLabel("播放全部")
                    }
                    .padding(.horizontal, Dim.s4)
                    .padding(.top, Dim.s3)

                    ForEach(Array(data.tracks.enumerated()), id: \.element.id) { index, track in
                        Button {
                            Task { await player.play(tracks: data.tracks, startingAt: index, origin: "每日推荐") }
                        } label: {
                            HStack(spacing: Dim.s3) {
                                Text(String(format: "%02d", index + 1))
                                    .font(.system(size: Dim.fsMinor))
                                    .foregroundStyle(p.text2)
                                    .frame(width: Dim.seqW, alignment: .leading)
                                Text(track.name)
                                    .font(.system(size: Dim.fsBody))
                                    .foregroundStyle(p.text1)
                                    .lineLimit(1)
                                Spacer(minLength: Dim.s2)
                                Text(track.artistLine)
                                    .font(.system(size: Dim.fsMinor))
                                    .foregroundStyle(p.text2)
                                    .lineLimit(1)
                            }
                            .padding(.horizontal, Dim.s4)
                            .frame(height: Dim.rowHeight)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(track.name) \(track.artistLine)")
                    }
                }
            }
            .padding(.bottom, Dim.s6)
        }
        .scrollIndicators(.hidden)
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        err = ""
        do {
            data = try await APIClient.shared.dailyRecommend()
        } catch {
            err = (error as? ApiError)?.message ?? error.localizedDescription
        }
        loading = false
    }
}
