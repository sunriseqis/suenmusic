import SwiftUI

/**
 * 通用二次确认弹窗（自绘哑光风格，对齐 hw `common/ConfirmDialog.ets`）。
 *
 * scrim 背板 + panel 卡片 + 发丝线描边；点遮罩 = 取消。
 * 左键 plain（single 时只有一键），右键 danger/primary。
 */
struct ConfirmDialog: View {
    @Environment(\.colorScheme) private var scheme

    private let title: String
    private let message: String?
    private let cancelTitle: String
    private let confirmTitle: String
    private let danger: Bool
    private let single: Bool
    private let onCancel: () -> Void
    private let onConfirm: () -> Void

    @State private var shown = false

    private var p: Palette { Palette(scheme) }

    /// 卡片宽 86%
    private let widthRatio: CGFloat = 0.86

    init(title: String, message: String? = nil,
         cancelTitle: String = "取消", confirmTitle: String = "确定",
         danger: Bool = false, single: Bool = false,
         onCancel: @escaping () -> Void, onConfirm: @escaping () -> Void) {
        self.title = title
        self.message = message
        self.cancelTitle = cancelTitle
        self.confirmTitle = confirmTitle
        self.danger = danger
        self.single = single
        self.onCancel = onCancel
        self.onConfirm = onConfirm
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                p.scrim
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onCancel)
                card
                    .frame(width: proxy.size.width * widthRatio)
                    .opacity(shown ? 1 : 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .ignoresSafeArea()
        .animation(.easeOut(duration: Motion.fast), value: shown)
        .onAppear { shown = true }
    }

    private var card: some View {
        VStack(spacing: Dim.s3) {
            Text(title)
                .font(.system(size: Dim.fsTitle, weight: .medium))
                .foregroundStyle(p.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let message, !message.isEmpty {
                Text(message)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: Dim.s2) {
                if !single {
                    WebButton(cancelTitle, variant: .plain, size: .md, block: true, action: onCancel)
                }
                WebButton(confirmTitle, variant: danger ? .danger : .primary,
                          size: .md, block: true, action: onConfirm)
            }
            .padding(.top, Dim.s1)
        }
        .padding(Dim.s4)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous)
                .fill(p.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
        .transition(.opacity)
    }
}
