/**
 * 按钮两件套 —— 与鸿蒙端 `common/WebButtons.ets` + `WebIconButton` 逐值同源。
 *
 * 机械反馈 = translateY(1) 下沉 + 底色换 panel2，**不缩放、不改透明度**
 * （disabled 例外 0.55）；web/hw 铁律：除 primary / plain 选中态外，键上没有顶沿高光线。
 */

import SwiftUI

/// plain = hw 规格里的 default 变体
enum WebButtonVariant { case plain, primary, ghost, danger }
enum WebButtonSize { case sm, md, lg }
enum WebIconButtonStyle { case chrome, plain, gradient, primary }

/// web NeuButton / NeuIconButton 的各档常量（hw 同文件内联常量）
private enum Btn {
    /// 文字钮高度：sm 30 / md 40 / lg 48
    static let hSm: CGFloat = 30
    static let hMd: CGFloat = 40
    static let hLg: CGFloat = 48
    /// 文字钮左右内边距：sm 12 / md 16 / lg 24
    static let padSm: CGFloat = 12
    static let padMd: CGFloat = 16
    static let padLg: CGFloat = 24
    /// 图标钮 盒 28/36/44/60 → 图标 15/18/21/26
    static let boxSm: CGFloat = 28
    static let boxMd: CGFloat = 36
    static let boxLg: CGFloat = 44
    static let glyphSm: CGFloat = 15
    static let glyphMd: CGFloat = 18
    static let glyphLg: CGFloat = 21
    static let glyphXl: CGFloat = 26
    /// 按下下沉量 + 置灰不透明度
    static let pressDrop: CGFloat = 1
    static let disabledOpacity: Double = 0.55
}

// MARK: - WebButton

struct WebButton: View {
    private let title: String
    private let variant: WebButtonVariant
    private let size: WebButtonSize
    private let block: Bool
    private let disabled: Bool
    private let action: () -> Void

    init(_ title: String, variant: WebButtonVariant = .plain, size: WebButtonSize = .md,
         block: Bool = false, disabled: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.variant = variant
        self.size = size
        self.block = block
        self.disabled = disabled
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: font, weight: .medium))
                .foregroundStyle(ink)
        }
        .buttonStyle(WebTextButtonStyle(variant: variant, size: size, block: block))
        .disabled(disabled)
        .opacity(disabled ? Btn.disabledOpacity : 1)
    }

    private var font: CGFloat {
        switch size {
        case .sm: return Dim.fsBody
        case .md: return Dim.fsSub
        case .lg: return Dim.fsTitle
        }
    }

    private var ink: Color {
        switch variant {
        case .primary: return DesignTokens.badgeInk
        case .ghost: return DesignTokens.accentText
        case .danger: return DesignTokens.danger
        case .plain: return DesignTokens.text1
        }
    }
}

private struct WebTextButtonStyle: ButtonStyle {
    let variant: WebButtonVariant
    let size: WebButtonSize
    let block: Bool

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
        configuration.label
            .frame(maxWidth: block ? .infinity : nil)
            .frame(height: height)
            .padding(.horizontal, padH)
            .background(shape.fill(fill(pressed: configuration.isPressed)))
            .overlay {
                if variant == .plain {
                    shape.strokeBorder(DesignTokens.line, lineWidth: Dim.hairline)
                }
            }
            .overlay(alignment: .top) {
                // primary 只有顶沿内高光，衬在琥珀底上才有厚度
                if variant == .primary {
                    Rectangle().fill(DesignTokens.hi).frame(height: Dim.hairline)
                }
            }
            .clipShape(shape)
            .offset(y: configuration.isPressed ? Btn.pressDrop : 0)
            .animation(.easeOut(duration: Motion.fast), value: configuration.isPressed)
            .contentShape(shape)
    }

    private var height: CGFloat {
        switch size {
        case .sm: return Btn.hSm
        case .md: return Btn.hMd
        case .lg: return Btn.hLg
        }
    }

    private var padH: CGFloat {
        switch size {
        case .sm: return Btn.padSm
        case .md: return Btn.padMd
        case .lg: return Btn.padLg
        }
    }

    private func fill(pressed: Bool) -> Color {
        switch variant {
        case .primary: return DesignTokens.accent
        case .ghost, .danger: return .clear
        case .plain: return pressed ? DesignTokens.panel2 : DesignTokens.panel
        }
    }
}

// MARK: - WebIconButton

struct WebIconButton: View {
    private let name: WebIconName
    private let box: CGFloat
    private let style: WebIconButtonStyle
    private let selected: Bool
    private let action: () -> Void

    init(_ name: WebIconName, box: CGFloat = 44, style: WebIconButtonStyle = .chrome,
         selected: Bool = false, action: @escaping () -> Void) {
        self.name = name
        self.box = box
        self.style = style
        self.selected = selected
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            WebIcon(name, size: glyph)
                .foregroundStyle(ink)
        }
        .buttonStyle(WebIconPressStyle(box: box, style: style, selected: selected))
    }

    /// 盒 ≤28→15，≤36→18，≤44→21，否则 26
    private var glyph: CGFloat {
        if box <= Btn.boxSm { return Btn.glyphSm }
        if box <= Btn.boxMd { return Btn.glyphMd }
        if box <= Btn.boxLg { return Btn.glyphLg }
        return Btn.glyphXl
    }

    private var ink: Color {
        switch style {
        case .chrome, .plain: return DesignTokens.text1
        case .gradient: return DesignTokens.accent
        case .primary: return DesignTokens.badgeInk
        }
    }
}

private struct WebIconPressStyle: ButtonStyle {
    let box: CGFloat
    let style: WebIconButtonStyle
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
        let pressed = configuration.isPressed
        return configuration.label
            .frame(width: box, height: box)
            .background {
                if style == .gradient {
                    // 180°：上 panel2 → 下 panel（厚度感由渐变提供，不再画顶高光）
                    shape.fill(LinearGradient(colors: [DesignTokens.panel2, DesignTokens.panel],
                                              startPoint: .top, endPoint: .bottom))
                } else {
                    shape.fill(fill(pressed: pressed))
                }
            }
            .overlay {
                if style == .chrome || style == .gradient {
                    shape.strokeBorder(DesignTokens.line, lineWidth: Dim.hairline)
                }
            }
            .overlay(alignment: .top) {
                // plain 的选中/按下态才有顶沿高光；其余质感一律没有
                if style == .plain, selected || pressed {
                    Rectangle().fill(DesignTokens.hi).frame(height: Dim.hairline)
                }
            }
            .clipShape(shape)
            .offset(y: pressed ? Btn.pressDrop : 0)
            .animation(.easeOut(duration: Motion.fast), value: pressed)
            .contentShape(shape)
    }

    private func fill(pressed: Bool) -> Color {
        switch style {
        case .primary: return DesignTokens.accent
        case .gradient: return DesignTokens.panel
        case .chrome: return pressed ? DesignTokens.panel2 : DesignTokens.panel
        case .plain: return (selected || pressed) ? DesignTokens.panel2 : .clear
        }
    }
}
