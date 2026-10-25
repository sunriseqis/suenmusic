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
    private let clearable: Bool
    private let onSubmit: (() -> Void)?

    private var p: Palette { Palette(scheme) }

    // `clearable` 故意放在 placeholder 之前：调用点写成 `NeuInput($kw, clearable: true, placeholder: …)` 更自然，
    // 且 Swift 要求实参顺序与声明一致。
    init(_ text: Binding<String>, clearable: Bool = false, placeholder: String,
         icon: WebIconName? = nil, isPassword: Bool = false,
         onSubmit: (() -> Void)? = nil) {
        self._text = text
        self.placeholder = placeholder
        self.icon = icon
        self.isPassword = isPassword
        self.clearable = clearable
        self.onSubmit = onSubmit
    }

    var body: some View {
        HStack(spacing: Dim.s2) {
            if let icon {
                WebIcon(icon, size: Dim.iconSm)
                    .foregroundStyle(p.text2)
            }
            field
            // 一键清空（hw 缺这个交互；搜索框有内容时才出现，避免空框多一个灰点）
            if clearable, !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    WebIcon(.close, size: Dim.iconSm)
                        .foregroundStyle(p.text2)
                        .frame(width: Dim.touchMin, height: Dim.touchMin)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清空")
                // 右侧内边距已经由容器 s3 提供，这里只吃掉按钮自身留白
                .padding(.trailing, -Dim.s2)
            }
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
