import SwiftUI

/**
 * 首屏骨架（**对齐 hw `pages/SkeletonList.ets` 的语义**）：海报占位 + 列表占位，
 * 与真实区块同序 —— 加载完成时不跳变。
 *
 * 只用 `Dim` 与 `Palette`；脉冲用 `Motion` 的 200ms 节奏，不做逐帧动画。
 */
struct SkeletonList: View {
    @Environment(\.colorScheme) private var scheme
    /// 是否画海报占位（首页 true；纯列表页 false）
    var withPoster: Bool = false
    /// 列表占位行数
    var rows: Int = 6

    @State private var pulse = false

    private var p: Palette { Palette(scheme) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Dim.s4) {
                if withPoster {
                    // 一屏 2 张 1:1 大盘占位（与 hw poster 同序、同比例）
                    HStack(spacing: Dim.s2 * 2) {
                        ForEach(0..<2, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                                .fill(p.panel2)
                                .aspectRatio(1, contentMode: .fit)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                                        .stroke(p.line, lineWidth: Dim.hairline)
                                )
                        }
                    }
                    .padding(.horizontal, Dim.s4)
                }

                VStack(spacing: 0) {
                    ForEach(0..<rows, id: \.self) { i in
                        HStack(spacing: Dim.s3) {
                            RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous)
                                .fill(p.panel2)
                                .frame(width: Dim.coverSm, height: Dim.coverSm)
                            VStack(alignment: .leading, spacing: Dim.s2) {
                                bar(width: i % 2 == 0 ? 0.62 : 0.44, height: Dim.fsBody)
                                bar(width: 0.3, height: Dim.fsMinor)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, Dim.s4)
                        .frame(height: Dim.rowHeight)
                    }
                }
            }
            .padding(.vertical, Dim.s3)
        }
        .background(p.bg)
        .scrollIndicators(.hidden)
        .onAppear {
            withAnimation(.easeInOut(duration: Motion.standard).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
        .opacity(pulse ? 0.55 : 1.0)
        .accessibilityLabel("正在加载")
    }

    private func bar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous)
            .fill(p.panel2)
            .frame(width: width * 220, height: height)
    }
}
