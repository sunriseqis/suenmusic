import SwiftUI

/// S1 才会铺开；S0 只保留"退出登录 + 服务端信息"，方便反复验证登录链路。
struct SettingsView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        Form {
            Section("账号") {
                if let u = app.user {
                    LabeledContent("用户名", value: u.username)
                    LabeledContent("角色", value: u.role == "admin" ? "管理员" : "成员")
                }
            }
            Section("服务端") {
                LabeledContent("地址", value: ServerRouter.shared.currentBaseURL)
            }
            Section {
                Button("退出登录", role: .destructive) { app.signOut() }
            }
        }
        .navigationTitle("我的")
    }
}
