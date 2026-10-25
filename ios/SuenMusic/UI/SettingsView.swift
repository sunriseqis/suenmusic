import SwiftUI

/**
 * 设置页 —— **对齐鸿蒙端 pages/SettingsPage.ets** 的三分段结构。
 *
 * 分段与 hw 同名同序：本机 / 智能 / 高级。
 *   · 本机：主题（三分段）+ 资料库（离线缓存说明、黑名单待接入）+ 账号（账号信息行，点行即改密码 + 退出登录二次确认）
 *   · 智能：画像/调优（hw 走服务端 AI 设置面板，iOS 接入排后续批次；这里如实说明，不放死开关）
 *   · 高级：设备（检查更新三形态）+ 多服务端（当前地址）+ 音源授权
 *
 * 检查更新与 hw 同形态：版本号 / 已是最新 / 新版本 x.y.z；
 * 有新版本时用 openURL 打开服务端直链（iOS 无静默安装，交给侧载工具签名）。
 */
struct SettingsView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var theme: ThemeStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    /// DEBUG 钩子：SIMCTL_CHILD_SUEN_SETTINGS_SEG=2 直接落「高级」段（无触摸环境验界面用）
    @State private var seg = SettingsView.initialSeg()
    @State private var showPassword = false
    @State private var pwOld = ""
    @State private var pwNew = ""
    @State private var pwNew2 = ""
    @State private var pwBusy = false
    @State private var showSignOut = false
    @State private var updating = false
    @State private var updState = ""
    @State private var toast = ""

    private let segLabels = ["本机", "智能", "高级"]

    private var p: Palette { Palette(scheme) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Dim.s3) {
                segmented
                if seg == 0 {
                    localTab
                } else if seg == 1 {
                    smartTab
                } else {
                    advancedTab
                }
            }
            .padding(.horizontal, Dim.s4)
            .padding(.bottom, Dim.s6)
        }
        .background(p.bg)
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showPassword) { passwordSheet }
        .alert("退出登录", isPresented: $showSignOut) {
            Button("取消", role: .cancel) {}
            Button("退出", role: .destructive) { app.signOut() }
        } message: {
            Text("退出后本机缓存与离线数据保留，重新登录即可继续收听。")
        }
        .overlay(alignment: .bottom) {
            if !toast.isEmpty {
                Text(toast)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(p.text1)
                    .padding(.horizontal, Dim.s4)
                    .padding(.vertical, Dim.s2)
                    .background(p.panel2)
                    .clipShape(Capsule())
                    .padding(.bottom, Dim.s5)
            }
        }
    }

    // MARK: - 三分段

    private var segmented: some View {
        HStack(spacing: Dim.s2) {
            ForEach(0..<segLabels.count, id: \.self) { i in
                Button {
                    seg = i
                } label: {
                    Text(segLabels[i])
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(seg == i ? p.onAccent : p.text2)
                        .frame(maxWidth: .infinity)
                        .frame(height: Dim.segH)
                        .background(seg == i ? p.accent : p.panel2)
                        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusTab, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, Dim.s3)
    }

    // MARK: - 本机

    private var localTab: some View {
        VStack(alignment: .leading, spacing: Dim.s3) {
            sectionLabel("主题")
            card {
                HStack(spacing: Dim.s2) {
                    ForEach(ThemeMode.allCases) { mode in
                        Button {
                            theme.set(mode)
                        } label: {
                            Text(mode.label)
                                .font(.system(size: Dim.fsMinor))
                                .foregroundStyle(theme.mode == mode ? p.onAccent : p.text2)
                                .frame(maxWidth: .infinity)
                                .frame(height: Dim.segH)
                                .background(theme.mode == mode ? p.accent : p.panel2)
                                .clipShape(RoundedRectangle(cornerRadius: Dim.radiusTab, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(Dim.s3)
            }

            sectionLabel("资料库")
            card {
                row("离线缓存", value: "播放时自动缓存")
                divider
                row("黑名单", value: "待接入")
            }

            sectionLabel("账号")
            card {
                if let u = app.user {
                    Button {
                        pwOld = ""; pwNew = ""; pwNew2 = ""
                        showPassword = true
                    } label: {
                        HStack {
                            Text(u.displayName.isEmpty ? u.username : u.displayName)
                                .font(.system(size: Dim.fsBody))
                                .foregroundStyle(p.text1)
                            Spacer()
                            Text(u.username + "-" + (u.role == "admin" ? "管理员" : "用户"))
                                .font(.system(size: Dim.fsMinor))
                                .foregroundStyle(p.text2)
                        }
                        .frame(height: Dim.touchMin)
                        .padding(.horizontal, Dim.s4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("账号信息，点击修改密码")

                    divider
                    Button {
                        showSignOut = true
                    } label: {
                        HStack {
                            Text("退出登录")
                                .font(.system(size: Dim.fsBody))
                                .foregroundStyle(p.danger)
                            Spacer()
                        }
                        .frame(height: Dim.touchMin)
                        .padding(.horizontal, Dim.s4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: - 智能

    private var smartTab: some View {
        VStack(alignment: .leading, spacing: Dim.s3) {
            sectionLabel("画像")
            card { row("兴趣画像", value: "待接入") }
            sectionLabel("调优")
            card { row("AI 调优", value: "待接入") }
            Text("hw 侧这两项走服务端 AI 设置面板，iOS 接入排在后续批次。")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
                .padding(.horizontal, Dim.s1)
        }
    }

    // MARK: - 高级

    private var advancedTab: some View {
        VStack(alignment: .leading, spacing: Dim.s3) {
            sectionLabel("设备")
            card {
                Button {
                    Task { await checkUpdate() }
                } label: {
                    HStack {
                        Text("检查更新")
                            .font(.system(size: Dim.fsBody))
                            .foregroundStyle(p.text1)
                        Spacer()
                        Text(updateLabel)
                            .font(.system(size: Dim.fsMinor))
                            .foregroundStyle(updState.hasPrefix("new=") ? p.accentText : p.text2)
                    }
                    .frame(height: Dim.touchMin)
                    .padding(.horizontal, Dim.s4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("检查更新，当前 " + updateLabel)
            }

            sectionLabel("多服务端")
            card { row("当前地址", value: ServerRouter.shared.currentBaseURL) }

            sectionLabel("音源授权")
            card {
                row("bilibili", value: "已授权")
                divider
                row("网易云", value: "已授权")
            }
        }
    }

    // MARK: - 组件

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: Dim.fsCaption))
            .foregroundStyle(p.text2)
            .padding(.leading, Dim.s1)
            .padding(.top, Dim.s2)
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .background(p.panel)
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .stroke(p.line, lineWidth: Dim.hairline)
            )
    }

    private func row(_ title: String, value: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text1)
            Spacer()
            Text(value)
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .lineLimit(1)
        }
        .frame(height: Dim.touchMin)
        .padding(.horizontal, Dim.s4)
    }

    private var divider: some View {
        Rectangle()
            .fill(p.line)
            .frame(height: Dim.hairline)
            .padding(.leading, Dim.s4)
    }

    // MARK: - 改密码弹层

    private var passwordSheet: some View {
        VStack(alignment: .leading, spacing: Dim.s3) {
            Text("修改密码")
                .font(.system(size: Dim.fsSection, weight: .semibold))
                .foregroundStyle(p.text1)
            input { SecureField("当前密码", text: $pwOld) }
            input { SecureField("新密码（至少 6 位）", text: $pwNew) }
            input { SecureField("再输一次新密码", text: $pwNew2) }
            if !pwNew2.isEmpty && pwNew != pwNew2 {
                Text("两次输入的新密码不一致")
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(p.danger)
            }
            Button {
                Task { await changePassword() }
            } label: {
                Text(pwBusy ? "提交中…" : "确认修改")
                    .font(.system(size: Dim.fsTitle, weight: .medium))
                    .foregroundStyle(p.onAccent)
                    .frame(maxWidth: .infinity)
                    .frame(height: Dim.touchMin)
                    .background(passwordReady ? p.accent : p.track)
                    .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!passwordReady || pwBusy)

            Text("改完会用新会话继续（其它设备上的登录会失效）")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
            Spacer(minLength: 0)
        }
        .padding(Dim.s4)
        .presentationDetents([.medium])
        .background(p.bg)
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

    // MARK: - 逻辑

    private static func initialSeg() -> Int {
        #if DEBUG
        return Int(ProcessInfo.processInfo.environment["SUEN_SETTINGS_SEG"] ?? "") ?? 0
        #else
        return 0
        #endif
    }

    private var passwordReady: Bool {
        !pwBusy && !pwOld.isEmpty && pwNew.count >= 6 && pwNew == pwNew2
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    private var appBuild: Int {
        Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    }

    /// 三形态：未检查 → 版本号；无新包 → 已是最新；有新包 → 新版本 x.y.z
    private var updateLabel: String {
        if updState == "latest" { return "已是最新" }
        if updState.hasPrefix("new=") { return "新版本 " + String(updState.dropFirst(4)) }
        return "v" + appVersion
    }

    private func checkUpdate() async {
        guard !updating else { return }
        updating = true
        defer { updating = false }
        do {
            let reply = try await APIClient.shared.checkUpdate(
                versionName: appVersion, versionCode: appBuild, force: true
            )
            if reply.available, let latest = reply.latest {
                updState = "new=" + latest.versionName
                let url = APIClient.shared.updateDownloadURL(path: reply.downloadPath, token: reply.downloadToken)
                if let target = URL(string: url) {
                    openURL(target)
                    showToast("新版本 " + latest.versionName + "：已交给浏览器下载，装好后用侧载工具签名安装")
                }
            } else {
                updState = "latest"
                showToast("已是最新版本")
            }
        } catch {
            updState = ""
            showToast((error as? ApiError)?.message ?? "检查更新失败")
        }
    }

    private func changePassword() async {
        guard passwordReady else { return }
        pwBusy = true
        defer { pwBusy = false }
        do {
            let session = try await APIClient.shared.changePassword(oldPassword: pwOld, newPassword: pwNew)
            APIClient.shared.adopt(session)
            showPassword = false
            showToast("密码已更新")
        } catch {
            showToast((error as? ApiError)?.message ?? "修改失败")
        }
    }

    private func showToast(_ text: String) {
        toast = text
        Task {
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            await MainActor.run { if toast == text { toast = "" } }
        }
    }
}
