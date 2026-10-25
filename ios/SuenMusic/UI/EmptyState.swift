import SwiftUI

/**
 * 统一空态（对齐 hw `pages/EmptyState.ets`）：可选图标 + 标题 + 副文案 + 可选按钮。
 *
 * 图标只走 `WebIcon`（系统符号），禁止 emoji；文案只能来自 `Copy`。
 */
struct EmptyState: View {
    @Environment(\.colorScheme) private var scheme

    private let icon: WebIconName?
    private let title: String
    private let subtitle: String?
    private let actionTitle: String?
    private let action: (() -> Void)?

    private var p: Palette { Palette(scheme) }

    init(icon: WebIconName? = nil, title: String, subtitle: String? = nil,
         actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        VStack(spacing: Dim.s2) {
            if let icon {
                WebIcon(icon, size: Dim.iconXl)
                    .foregroundStyle(p.text2)
            }
            Text(title)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text1)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
            }
            if let actionTitle, !actionTitle.isEmpty, let action {
                WebButton(actionTitle, variant: .plain, size: .md, action: action)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
