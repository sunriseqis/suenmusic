import SwiftUI

/**
 * 在播序号列的三根跳动竖条（hw `PlayingBars` / web TrackRow `.bars`）。
 *
 * 条宽 2、圆角 1、高 8/14/6，容器高 14、底对齐、gap 2；scaleY 0.5↔1，
 * 1000ms、alternating、无限，三根延迟 0/160/320ms，缩放原点在条底部。
 */
struct PlayingBars: View {
    private static let scaleLow: CGFloat = 0.5
    private static let scaleHigh: CGFloat = 1

    @State private var up = false

    var body: some View {
        HStack(alignment: .bottom, spacing: Dim.s0) {
            bar(Dim.barMid, delay: 0)
            bar(Dim.barTall, delay: Motion.barsDelayMid)
            bar(Dim.barShort, delay: Motion.barsDelayShort)
        }
        .frame(height: Dim.barBox, alignment: .bottom)
        .onAppear { up = true }
    }

    private func bar(_ height: CGFloat, delay: Double) -> some View {
        RoundedRectangle(cornerRadius: Dim.hairline)
            .fill(DesignTokens.accent)
            .frame(width: Dim.barW, height: height)
            .scaleEffect(y: up ? Self.scaleHigh : Self.scaleLow, anchor: .bottom)
            .animation(
                .easeInOut(duration: Motion.barsBounce)
                    .repeatForever(autoreverses: true)
                    .delay(delay),
                value: up
            )
    }
}
