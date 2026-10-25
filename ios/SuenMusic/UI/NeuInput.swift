import SwiftUI

/**
 * 统一输入框（对齐 hw `pages/NeuInput.ets` 的凹陷形态）。
 *
 * 系统输入框默认配色压在深色面板上文字几乎不可见，这里钉死全部颜色与尺寸：
 * bg 凹陷底 + 发丝描边 + t1 文字 + t2 占位 + 琥珀光标。
 */
struct NeuInput: View {
    @Environment(\.colorScheme) private var scheme

    @Binding private var text: String
    private let placeholder: String
    private let icon: WebIconName?
    private let isPassword: Bool
    private let onSubmit: (() -> Void)?

    private var p: Palette { Palette(scheme) }

    init(_ text: Binding<String>, placeholder: String,
         icon: WebIconName? = nil, isPassword: Bool = false,
         onSubmit: (() -> Void)? = nil) {
        self._text = text
        self.placeholder = placeholder
        self.icon = icon
        self.isPassword = isPassword
        self.onSubmit = onSubmit
    }

    var body: some View {
        HStack(spacing: Dim.s2) {
            if let icon {
                WebIcon(icon, size: Dim.iconSm)
                    .foregroundStyle(p.text2)
            }
            field
        }
        .frame(height: Dim.touchMin)
        .padding(.horizontal, Dim.s3)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                .fill(p.bg)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
    }

    @ViewBuilder
    private var field: some View {
        // 占位色只能经 prompt 传：TextField 自带的占位是系统灰
        let prompt = Text(placeholder).foregroundStyle(p.text2)
        if isPassword {
            SecureField(placeholder, text: $text, prompt: prompt)
                .textContentType(.password)
                .submitLabel(.done)
                .onSubmit { onSubmit?() }
                .modifier(NeuFieldStyle(p: p))
        } else {
            TextField(placeholder, text: $text, prompt: prompt)
                .submitLabel(.done)
                .onSubmit { onSubmit?() }
                .modifier(NeuFieldStyle(p: p))
        }
    }
}

/// 输入文字/光标配色（透明底，凹陷形态由外层 Row 承载）
private struct NeuFieldStyle: ViewModifier {
    let p: Palette

    func body(content: Content) -> some View {
        content
            .font(.system(size: Dim.fsBody))
            .foregroundStyle(p.text1)
            .tint(p.accent)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
