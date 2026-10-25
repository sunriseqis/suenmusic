import SwiftUI

/**
 * 全端轻提示（自绘，底部居中）—— 对齐 hw `common/AppToast.ets`。
 *
 * 不用系统 toast：沉浸式下会漂到屏幕顶部，样式也脱离哑光体系。
 * 渲染唯一落点：根视图最后一层 `ToastOverlay`。
 */
@MainActor
final class ToastCenter: ObservableObject {
    static let shared = ToastCenter()

    /// 显示中的文案；nil = 不显示
    @Published private(set) var text: String?
    /// 显示序号：同文案连点也能再弹（不靠文案判等）
    @Published private(set) var seq: Int = 0

    private var dismiss: Task<Void, Never>?

    private init() {}

    func show(_ text: String) {
        guard !text.isEmpty else { return }
        self.text = text
        seq &+= 1
        dismiss?.cancel()
        dismiss = Task { [weak self] in
            try? await Task.sleep(nanoseconds: ToastCenter.showNanos)
            guard !Task.isCancelled else { return }
            self?.text = nil
        }
    }

    /// 2200ms 自动消失
    private static let showNanos: UInt64 = 2_200 * 1_000_000
}

struct ToastOverlay: View {
    var body: some View {
        ToastLayer(center: ToastCenter.shared)
    }
}

/// 拆一层：`ToastCenter.shared` 在 MainActor 的 body 里取，避开非隔离初始化。
private struct ToastLayer: View {
    @Environment(\.colorScheme) private var scheme
    @ObservedObject var center: ToastCenter

    private var p: Palette { Palette(scheme) }

    /// 与 hw 同值：距底 132pt (+ 安全区)
    private let bottomInset: CGFloat = 132
    /// 最大宽 84%
    private let maxWidthRatio: CGFloat = 0.84

    private var fadeKey: String { "\(center.seq)|\(center.text == nil)" }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottom) {
                if let text = center.text {
                    bubble(text, maxWidth: proxy.size.width * maxWidthRatio)
                        .id(center.seq)
                        .padding(.bottom, bottomInset + proxy.safeAreaInsets.bottom)
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .animation(.easeOut(duration: Motion.fast), value: fadeKey)
        }
        .ignoresSafeArea()
        // 整层不吃点击：提示不能挡住底下的页面
        .allowsHitTesting(false)
    }

    private func bubble(_ text: String, maxWidth: CGFloat) -> some View {
        Text(text)
            .font(.system(size: Dim.fsBody))
            .foregroundStyle(p.text1)
            .multilineTextAlignment(.center)
            .lineLimit(3)
            .padding(.horizontal, Dim.s4)
            .padding(.vertical, Dim.s3)
            .background(
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .fill(p.panel2)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .stroke(p.line, lineWidth: Dim.hairline)
            )
            .frame(maxWidth: maxWidth)
    }
}
