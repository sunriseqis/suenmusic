import SwiftUI

/**
 * 骨架屏（对齐 hw `pages/SkeletonList.ets`）：海报占位 + 列表占位，
 * 与真实区块同序 —— 加载完成时不跳变。
 *
 * 只用 `Dim` 与 `Palette`；呼吸脉动用 `Motion` 的 200ms 节奏（0.45↔1 往返），不做逐帧动画。
 */
struct SkeletonList: View {
    @Environment(\.colorScheme) private var scheme
    /// 是否先画海报占位（首页 true；纯列表页 false）
    var withPoster: Bool = false
    /// 列表占位行数
    var rows: Int = 6

    @State private var lit = false

    private var p: Palette { Palette(scheme) }
    /// 每条骨架块共用同一个透明度（hw 同一 animateTo 驱动）
    private var pulse: Double { lit ? 1 : 0.45 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Dim.s4) {
                if withPoster {
                    posterBlock
                }
                VStack(spacing: 0) {
                    ForEach(0..<rows, id: \.self) { i in
                        row(i)
                    }
                }
            }
            .padding(.vertical, Dim.s3)
        }
        .background(p.bg)
        .scrollIndicators(.hidden)
        .animation(.easeOut(duration: Motion.standard).repeatForever(autoreverses: true), value: lit)
        .onAppear { lit = true }
        .accessibilityLabel("正在加载")
    }

    /// 海报占位：两张 1:1 方卡各占一半宽（对齐真实海报大卡）
    private var posterBlock: some View {
        HStack(spacing: Dim.s4) {
            ForEach(0..<2, id: \.self) { _ in
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .fill(p.panel2)
                    .aspectRatio(1, contentMode: .fit)
                    .opacity(pulse)
            }
        }
        .padding(.horizontal, Dim.s4)
        .padding(.vertical, Dim.s3)
    }

    private func row(_ i: Int) -> some View {
        HStack(spacing: Dim.s3) {
            RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous)
                .fill(p.panel2)
                .frame(width: Dim.coverSm, height: Dim.coverSm)
                .opacity(pulse)
            VStack(alignment: .leading, spacing: Dim.s2) {
                bar(width: i % 2 == 0 ? 0.62 : 0.44, height: Dim.fsBody)
                bar(width: 0.3, height: Dim.fsMinor)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Dim.s4)
        .frame(height: Dim.rowHeight)
    }

    private func bar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous)
            .fill(p.panel2)
            .frame(width: width * 220, height: height)
            .opacity(pulse)
    }
}
