/**
 * 分段标签页 —— 与鸿蒙端 `common/NeuTabs.ets` 1:1。
 *
 * 选中项用**凸起**表达（panel2 底 + 顶沿高光 + Bold），不用强调色：
 * web 铁律是分段标签连橙色都不用。导轨凹陷（bg 底 + line 描边 + radiusMd，内嵌 2）。
 */

import SwiftUI

struct NeuTabs: View {
    private let titles: [String]
    @Binding private var selection: Int

    init(titles: [String], selection: Binding<Int>) {
        self.titles = titles
        self._selection = selection
    }

    var body: some View {
        HStack(spacing: Dim.s0) {
            ForEach(Array(titles.enumerated()), id: \.offset) { index, title in
                let on = selection == index
                Text(title)
                    .font(.system(size: Dim.fsBody, weight: on ? .bold : .medium))
                    .foregroundStyle(on ? DesignTokens.text1 : DesignTokens.text2)
                    .frame(maxWidth: .infinity, minHeight: Dim.segH)
                    .padding(.horizontal, Dim.s4)
                    .background(cellShape.fill(on ? DesignTokens.panel2 : .clear))
                    .overlay(alignment: .top) {
                        // 高光固定 1pt 只换颜色，避免描边宽度 0↔1 跳变闪一下
                        Rectangle()
                            .fill(on ? DesignTokens.hi : Color.clear)
                            .frame(height: Dim.hairline)
                    }
                    .clipShape(cellShape)
                    .contentShape(cellShape)
                    .onTapGesture { selection = index }
                    .animation(.easeOut(duration: Motion.fast), value: on)
            }
        }
        .padding(Dim.s0)
        .frame(maxWidth: .infinity)
        .background(railShape.fill(DesignTokens.bg))
        .overlay { railShape.strokeBorder(DesignTokens.line, lineWidth: Dim.hairline) }
    }

    private var railShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
    }

    private var cellShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous)
    }
}
