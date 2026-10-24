import SwiftUI

/**
 * 登录页 —— **逐项对齐鸿蒙端 `pages/LoginPage.ets`**。
 *
 * 与 hw 相同：品牌大字 + 副标题「自托管音乐」、三个字段（服务端地址 / 用户名 / 口令）在面板卡里、
 * 错误行用 danger 色、主按钮整宽（登录中… 置灰）、整体垂直居中。
 * iOS 独有（保留，hw 无）：公网 http 明文风险提示（`ServerRouter.isPrivate` 判定）。
 */
struct LoginView: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.colorScheme) private var scheme

    @State private var address = ServerRouter.shared.currentBaseURL
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var err = ""

    private var p: Palette { Palette(scheme) }

    private var canSubmit: Bool {
        !busy && !username.isEmpty && !password.isEmpty && !address.isEmpty
    }

    var body: some View {
        VStack(spacing: Dim.s4) {
            Text("SuenMusic")
                .font(.system(size: Dim.fsBrand, weight: .bold))
                .foregroundStyle(p.text1)
            Text("自托管音乐")
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text2)

            VStack(alignment: .leading, spacing: Dim.s2) {
                fieldLabel("服务端地址")
                input {
                    TextField("http://192.168.1.10:3210", text: $address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                if !address.isEmpty, address.hasPrefix("http://"), !ServerRouter.isPrivate(address) {
                    Text("公网地址建议用 https：口令与播放令牌会明文过网")
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(p.danger)
                }

                fieldLabel("用户名").padding(.top, Dim.s2)
                input {
                    TextField("用户名", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                fieldLabel("口令").padding(.top, Dim.s2)
                input {
                    SecureField("口令", text: $password)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Dim.s4)
            .background(p.panel)
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))

            if !err.isEmpty {
                Text(err)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(p.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button {
                submit()
            } label: {
                Text(busy ? "登录中…" : "登录")
                    .font(.system(size: Dim.fsTitle, weight: .medium))
                    .foregroundStyle(p.onAccent)
                    .frame(maxWidth: .infinity)
                    .frame(height: Dim.touchMin)
                    .background(canSubmit ? p.accent : p.track)
                    .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit)
            .accessibilityLabel(busy ? "正在登录" : "登录")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, Dim.s5)
        .padding(.vertical, Dim.s5)
        .background(p.bg)
        .onAppear {
            // hw 同款：进页面带上当前服务端地址（首次为空则留占位提示）
            address = app.serverAddress
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: Dim.fsMinor))
            .foregroundStyle(p.text2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func input<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .font(.system(size: Dim.fsSub))
            .foregroundStyle(p.text1)
            .padding(.horizontal, Dim.s3)
            .frame(height: Dim.inputH)
            .background(p.panel2)
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous)
                    .stroke(p.line, lineWidth: Dim.hairline)
            )
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        err = ""
        Task {
            await app.login(address: address, username: username, password: password)
            // 登录页要服务端的原始 message（「用户名或密码错误」），不用会话过期话术 —— 对齐 hw
            if let message = app.errorMessage, !message.isEmpty {
                err = message
            }
            busy = false
        }
    }
}
