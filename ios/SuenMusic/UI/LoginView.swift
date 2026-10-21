import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var app: AppState
    @State private var address = ServerRouter.shared.currentBaseURL
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section("服务端") {
                    TextField("http://192.168.1.10:3210", text: $address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !address.isEmpty, !ServerRouter.isPrivate(address), address.hasPrefix("http://") {
                        Text("公网地址建议用 https：口令与播放令牌会明文过网")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                Section("账号") {
                    TextField("用户名", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("口令", text: $password)
                }
                if let err = app.errorMessage {
                    Section { Text(err).foregroundStyle(.red) }
                }
                Section {
                    Button(busy ? "登录中…" : "登录") {
                        busy = true
                        Task {
                            await app.login(address: address, username: username, password: password)
                            busy = false
                        }
                    }
                    .disabled(busy || username.isEmpty || password.isEmpty || address.isEmpty)
                }
            }
            .navigationTitle("SuenMusic")
        }
    }
}
