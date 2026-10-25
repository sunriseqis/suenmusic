/**
 * 自绘底部 Tab 栏 —— 与鸿蒙端 `pages/NativeRoot.ets` 的 `tabBar()` / `tabSlider()` / `tabCell()` 逐值同源。
 *
 * 结构（hw 同构）：横条 = Stack{ 活动滑块层 + Row(5 格) }。
 * - 横条：bg 底 + line 发丝线描边 + radiusMd，内嵌 Dim.s1；外边距 左右 s3 / 上 s1 / 下 s2
 * - 滑块：宽 = (栏宽 - 6 × Dim.s1) / 5、高 touchMin、radiusTab，panel2 底 + 顶沿内高光，
 *   底部内嵌 12×2 琥珀指示条（Dim.tabIndicatorW × Dim.tabIndicatorH），随下标平移
 * - 格子：五等分、touchMin 高、fsMinor 字；选中 Medium + text1 / 未选 Normal + text2；
 *   文字底部让位 Dim.s2 给指示条；按压整格下沉 1pt（不缩放、不改透明度）
 *
 * 切换动效：Motion.fast(100ms) easeOut —— 滑块平移与文字变色共用一个 `.animation`（hw animateTo 同源）。
 */

import SwiftUI

struct TabBar: View {
    /// 标签与顺序必须与 hw `tabCell('发现', 0) … tabCell('设置', 4)` 一致
    private static let labels = ["发现", "专属", "收藏", "搜索", "设置"]

    @Binding private var selection: Int
    /// hw `barW`：横条自身实测宽（含内嵌 padding）。首帧未测量时为 0
    @State private var barW: CGFloat = 0

    init(selection: Binding<Int>) {
        self._selection = selection
    }

    var body: some View {
        ZStack(alignment: .leading) {
            // 滑块垫底、格子层在上（hw Stack 同图层次序）
            slider
            cells
        }
        .frame(maxWidth: .infinity)
        .padding(Dim.s1)
        .background(railShape.fill(DesignTokens.bg))
        .overlay { railShape.strokeBorder(DesignTokens.line, lineWidth: Dim.hairline) }
        // ⚠️ 量宽必须**在 margin 之前**：hw `onAreaChange` 量的是横条自身宽（屏宽 − 左右各 s3 = 378），
        // 之前挂在 `.padding(.horizontal, s3)` 之后 → 量到屏宽 402，药丸宽多算 5pt，指示条整体偏右（用户实测“横线是歪的”）。
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barW = $0 }
        // hw margin：左右 s3 / 上 s1 / 下 s2。画在 padding 外侧，不参与 barW 计量
        .padding(.horizontal, Dim.s3)
        .padding(.top, Dim.s1)
        .padding(.bottom, Dim.s2)
        // hw 把 currentTab 的赋值包进 animateTo(duration: Motion.fast, curve: Motion.curve)：
        // 平移与文字变色同一条 100ms easeOut
        .animation(.easeOut(duration: Motion.fast), value: selection)
    }

    // MARK: - 格子层

    private var cells: some View {
        HStack(spacing: Dim.s1) {
            ForEach(Array(Self.labels.enumerated()), id: \.offset) { index, label in
                cell(label, index)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: Dim.touchMin)
    }

    private func cell(_ label: String, _ index: Int) -> some View {
        let on = selection == index
        return Button {
            selection = index
        } label: {
            Text(label)
                .font(.system(size: Dim.fsMinor, weight: on ? .medium : .regular))
                .foregroundStyle(on ? DesignTokens.text1 : DesignTokens.text2)
                // hw `.tab{padding:0 0 8px}`：文字上移，给滑块底部的琥珀指示条让位
                .padding(.bottom, Dim.s2)
                // hw `layoutWeight(1)` + `justifyContent(Center)`
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(TabCellPressStyle())
        .accessibilityLabel(label)
        .accessibilityValue(on ? "已选中" : "未选中")
        // hw `accessibilityLevel(currentTab === idx ? 'yes' : 'no')` 的 iOS 等价
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: - 滑块层

    private var slider: some View {
        sliderShape
            .fill(DesignTokens.panel2)
            // hw `border({ width: { top: Dim.hairline }, color: { top: Tokens.hi } })`：只留顶沿内高光
            .overlay(alignment: .top) {
                Rectangle().fill(DesignTokens.hi).frame(height: Dim.hairline)
            }
            .clipShape(sliderShape)
            // hw Stack(alignContent: .Bottom) + margin({ bottom: Dim.s1 }) 的琥珀指示条：底部居中
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(DesignTokens.accent)
                    .frame(width: Dim.tabIndicatorW, height: Dim.tabIndicatorH)
                    .padding(.bottom, Dim.s1)
            }
            .frame(width: sliderW, height: Dim.touchMin)
            .offset(x: sliderX)
            // 滑块是垫底装饰层，点击一律交给上面的格子
            .allowsHitTesting(false)
    }

    /// 滑块宽：导轨内容区五等分 —— hw `tabSliderW()` 原式 `(barW - 6 * Dim.s1) / 5`
    /// （6 = 左右 padding 2 + 四道 gap 4；5 = 格子数）。
    /// 首帧 barW 尚未测量（= 0）时返回 0：滑块宽 0 即整块不可见，
    /// 不会先在 x=0 处闪一整个滑块（hw 的 `if (this.barW <= 0) return 0` 同语义）。
    private var sliderW: CGFloat {
        guard barW > 0 else { return 0 }
        return (barW - 6 * Dim.s1) / 5
    }

    /// 滑块 x：内容区起点 + 当前下标 × (滑块宽 + gap) —— hw `tabSliderX()`
    private var sliderX: CGFloat {
        CGFloat(selection) * (sliderW + Dim.s1)
    }

    private var railShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
    }

    private var sliderShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Dim.radiusTab, style: .continuous)
    }
}

/// 按压反馈：整格下沉 1pt，不缩放、不改透明度（hw `translate({ y: 1 })`）
private struct TabCellPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .offset(y: configuration.isPressed ? Dim.tabPressSink : 0)
            .animation(.easeOut(duration: Motion.fast), value: configuration.isPressed)
    }
}
