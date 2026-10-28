import SwiftUI
import Foundation
import UniformTypeIdentifiers

/**
 * 设置页的五张底部弹层 + 弹层外壳 —— 逐项对齐鸿蒙端 pages/SettingsPage.ets。
 *
 *   · 黑名单 / 歌单导入 / 去重 / 修改密码 / 数据备份
 *   · 外壳统一：全屏 scrim（点空白关）+ 上滑面板（把手 36×3 + 标题 16 Medium + 收起键）
 *   · 面板：panel 底 + 上两角 radiusLg16 + 内边距 h16 / t12 / b16；上滑 200ms
 *
 * 弹层一律自绘（系统 .sheet 的卡片形态与哑光体系不一致，且 scrim 不能点空白关）。
 */

// MARK: - 数值 / 文案

/// 缓存行「已用 / 上限」专用格式化 —— 只服务 SettingsView 的缓存行右值，勿复用到其它行。
enum SettingsFmt {
    /// 已用：0 → "0M"；<1G → 整数 M（如 "100M"）；≥1G → 一位小数（如 "1.2G"）；单位不带 B。
    static func cacheUsed(_ bytes: Int64) -> String {
        guard bytes > 0 else { return "0M" }
        let gb = Double(1024 * 1024 * 1024)
        let mb = Double(1024 * 1024)
        let value = Double(bytes)
        if value >= gb { return String(format: "%.1f", value / gb) + "G" }
        return String(max(1, Int((value / mb).rounded()))) + "M"
    }

    /// 上限：由 AudioCacheStore.maxBytes 换算，整 G → "1G"（不写 "1.00 GB"）；非整 G 保留一位小数。
    static func cacheLimit(_ bytes: Int64) -> String {
        let value = Double(bytes) / Double(1024 * 1024 * 1024)
        let whole = value.rounded()
        if abs(value - whole) < 0.0001 { return String(Int(whole)) + "G" }
        return String(format: "%.1f", value) + "G"
    }
}

/// 错误 → 用户文案（两条口径与 hw 一致，不要混用）
enum SettingsErrorText {
    /// hw (e as ApiError).message：弹层内结果行直接显示服务端原话
    static func api(_ error: Error) -> String {
        (error as? ApiError)?.message ?? error.localizedDescription
    }

    /// hw Copy.describeError(e, true)：检查更新 / 改口令这类要区分网络与状态码的位置
    static func described(_ error: Error) -> String {
        guard let e = error as? ApiError else {
            return Copy.describe(status: 0, code: nil, message: error.localizedDescription)
        }
        return Copy.describe(status: e.status, code: e.code, message: e.message)
    }
}

// MARK: - 弹层外壳

/// 五张弹层的统一外壳（scrim + 上滑面板 + 把手/标题/收起键）。
struct SettingsSheetShell<Content: View>: View {
    @Environment(\.colorScheme) private var scheme

    private let title: String
    /// 定高比例（黑名单 62%）；nil = 随内容自适应
    private let heightRatio: CGFloat?
    private let onClose: () -> Void
    private let content: () -> Content

    init(title: String, heightRatio: CGFloat? = nil,
         onClose: @escaping () -> Void,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.heightRatio = heightRatio
        self.onClose = onClose
        self.content = content
    }

    private var p: Palette { Palette(scheme) }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottom) {
                p.scrim
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onClose)
                    .transition(.opacity)
                // 定高面板吃满比例高度；自适应面板按内容收高（内部 ScrollView 才能按内容定高）
                Group {
                    if let ratio = heightRatio {
                        panel.frame(width: proxy.size.width, height: proxy.size.height * ratio)
                    } else {
                        panel
                            .frame(width: proxy.size.width)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .transition(.move(edge: .bottom))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
    }

    private var panel: some View {
        VStack(spacing: Dim.s3) {
            grip
            head
            content()
        }
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s3)
        .padding(.bottom, Dim.s4)
        .frame(maxWidth: .infinity,
               maxHeight: heightRatio == nil ? nil : .infinity,
               alignment: .top)
        .background(
            UnevenRoundedRectangle(
                topLeadingRadius: Dim.radiusLg,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: Dim.radiusLg,
                style: .continuous
            )
            .fill(p.panel)
        )
    }

    private var grip: some View {
        RoundedRectangle(cornerRadius: Dim.radiusPill, style: .continuous)
            .fill(p.line)
            .frame(width: Dim.gripW, height: Dim.gripH)
    }

    /// 第 ⑱ 条全局令：浮窗关闭一律向下收起（chevron-down），不用 X
    private var head: some View {
        HStack(spacing: Dim.s2) {
            Text(title)
                .font(.system(size: Dim.fsSection, weight: .medium))
                .foregroundStyle(p.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
            WebIconButton(.chevronDown, box: Dim.btnMd, style: .plain, action: onClose)
                .accessibilityLabel("收起")
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - 黑名单

/// 黑名单弹层：歌曲 / 歌手分片 + 列表 + 恢复（hw dislikesSheet）
@MainActor
struct SettingsDislikesSheet: View {
    @Environment(\.colorScheme) private var scheme

    @Binding var items: [DislikeEntry]
    let reload: () async -> Void
    let onClose: () -> Void

    @State private var tab = "track"

    private var p: Palette { Palette(scheme) }

    var body: some View {
        SettingsSheetShell(title: "黑名单", heightRatio: 0.62, onClose: onClose) {
            VStack(spacing: Dim.s3) {
                tabBar
                if visible.isEmpty {
                    Text("没有记录")
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, Dim.s3)
                    Spacer(minLength: 0)
                } else {
                    ScrollView {
                        VStack(spacing: 0) { rows }
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

    // MARK: 分片

    private var tabBar: some View {
        HStack(spacing: Dim.s5) {
            tabItem("歌曲 \(count("track"))", "track")
            tabItem("歌手 \(count("artist"))", "artist")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .bottom) {
            Rectangle().fill(p.line).frame(height: Dim.hairline)
        }
    }

    private func tabItem(_ label: String, _ key: String) -> some View {
        let on = tab == key
        return Text(label)
            .font(.system(size: Dim.fsMinor))
            .foregroundStyle(on ? p.text1 : p.text2)
            .padding(.top, Dim.s1)
            .padding(.bottom, Dim.s3)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(on ? p.accent : Color.clear)
                    .frame(height: Dim.tabIndicatorH)
            }
            .contentShape(Rectangle())
            .onTapGesture { tab = key }
            .animation(.easeOut(duration: Motion.fast), value: on)
    }

    // MARK: 列表

    @ViewBuilder private var rows: some View {
        ForEach(visible) { row in
            HStack(spacing: Dim.s2) {
                Text(displayName(row))
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                WebButton("恢复", variant: .plain, size: .sm) {
                    Task { await undo(row) }
                }
                .accessibilityLabel("恢复 " + displayName(row))
            }
            .frame(height: Dim.touchMin)
        }
    }

    // MARK: 数据

    private var visible: [DislikeEntry] {
        items.filter { ($0.type ?? "") == tab }
    }

    private func count(_ type: String) -> Int {
        items.reduce(0) { $0 + (($1.type ?? "") == type ? 1 : 0) }
    }

    private func displayName(_ row: DislikeEntry) -> String {
        if let name = row.name, !name.isEmpty { return name }
        return row.targetId ?? ""
    }

    private func undo(_ row: DislikeEntry) async {
        guard let type = row.type, let id = row.targetId else { return }
        do {
            try await APIClient.shared.removeDislike(type: type, id: id)
            await reload()
        } catch {
            ToastCenter.shared.show(SettingsErrorText.api(error))
        }
    }
}

// MARK: - 歌单导入

/// QQ 歌单导入弹层（hw importSheet）
@MainActor
struct SettingsImportSheet: View {
    @Environment(\.colorScheme) private var scheme
    let onClose: () -> Void

    @State private var link = ""
    @State private var importing = false
    @State private var msg = ""

    private var p: Palette { Palette(scheme) }

    var body: some View {
        SettingsSheetShell(title: "歌单导入", onClose: onClose) {
            VStack(alignment: .leading, spacing: Dim.s3) {
                NeuInput($link, placeholder: "QQ 歌单链接或 id")
                WebButton(importing ? "导入中…" : "导入",
                          variant: .primary, size: .md, block: true,
                          disabled: importing || trimmed.isEmpty) {
                    Task { await run() }
                }
                .accessibilityLabel(importing ? "正在导入" : "导入")
                if !msg.isEmpty {
                    Text(msg)
                        .font(.system(size: Dim.fsMinor))
                        .foregroundStyle(p.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var trimmed: String {
        link.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func run() async {
        let raw = trimmed
        guard !raw.isEmpty, !importing else { return }
        importing = true
        msg = ""
        defer { importing = false }
        do {
            let res = try await APIClient.shared.importQqPlaylist(link: raw)
            msg = "\(res.playlistName ?? "") · 新增 \(res.added ?? 0) 首（共 \(res.total ?? 0) 首）"
            link = ""
        } catch {
            msg = SettingsErrorText.api(error)
        }
    }
}

// MARK: - 去重

/// 去重弹层：打开即预检，重复组明细 + 一键清理（hw dedupeSheet）
@MainActor
struct SettingsDedupeSheet: View {
    @Environment(\.colorScheme) private var scheme
    let onClose: () -> Void

    @State private var busy = false
    @State private var msg = ""
    @State private var groups: [DedupGroup] = []

    private var p: Palette { Palette(scheme) }

    var body: some View {
        SettingsSheetShell(title: "去重", onClose: onClose) {
            VStack(alignment: .leading, spacing: Dim.s3) {
                if busy {
                    status("检查中…")
                } else if !msg.isEmpty {
                    status(msg)
                }
                if !busy && !groups.isEmpty {
                    ScrollView {
                        VStack(spacing: 0) { groupRows }
                    }
                    .scrollIndicators(.hidden)
                    .frame(maxHeight: Dim.sheetListMax)
                    WebButton("清理 \(removeTotal) 首", variant: .primary, size: .md, block: true) {
                        Task { await apply() }
                    }
                    .accessibilityLabel("清理重复收藏")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { await preview() }
    }

    private func status(_ text: String) -> some View {
        Text(text)
            .font(.system(size: Dim.fsMinor))
            .foregroundStyle(p.text2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var groupRows: some View {
        ForEach(Array(groups.enumerated()), id: \.offset) { index, group in
            HStack(spacing: Dim.s2) {
                VStack(alignment: .leading, spacing: Dim.s0) {
                    Text(group.name ?? "")
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.text1)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(group.artist ?? "")
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(p.text2)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text("清理 \(removeIds(group).count) 首")
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(p.text2)
            }
            .padding(.vertical, Dim.s2)
            .overlay(alignment: .top) {
                if index > 0 {
                    Rectangle().fill(p.line).frame(height: Dim.hairline)
                }
            }
        }
    }

    /// 服务端同一份数据给了 removeTrackIds / removeIds 两个键
    private func removeIds(_ group: DedupGroup) -> [String] {
        group.removeTrackIds ?? group.removeIds ?? []
    }

    private var removeTotal: Int {
        groups.reduce(0) { $0 + removeIds($1).count }
    }

    private func preview() async {
        if busy { return }
        busy = true
        msg = ""
        defer { busy = false }
        do {
            let res = try await APIClient.shared.dedupPreview()
            groups = res.resolvedGroups
            let n = res.duplicateCount ?? 0
            msg = n > 0 ? "发现 \(n) 首重复" : "没有重复"
        } catch {
            msg = SettingsErrorText.api(error)
        }
    }

    private func apply() async {
        if busy || groups.isEmpty { return }
        busy = true
        defer { busy = false }
        do {
            let res = try await APIClient.shared.dedupApply()
            groups = []
            msg = "已清理 \(res.removedCount ?? 0) 首"
        } catch {
            msg = SettingsErrorText.api(error)
        }
    }
}

// MARK: - 修改密码

/// 修改密码弹层（hw passwordSheet）：服务端回新会话，成功后必须 adopt
@MainActor
struct SettingsPasswordSheet: View {
    @Environment(\.colorScheme) private var scheme
    let onClose: () -> Void

    @State private var oldPw = ""
    @State private var newPw = ""
    @State private var newPw2 = ""
    @State private var busy = false

    private var p: Palette { Palette(scheme) }

    var body: some View {
        SettingsSheetShell(title: "修改密码", onClose: onClose) {
            VStack(alignment: .leading, spacing: Dim.s3) {
                NeuInput($oldPw, placeholder: "当前口令", isPassword: true)
                NeuInput($newPw, placeholder: "新口令（至少 6 位）", isPassword: true)
                NeuInput($newPw2, placeholder: "再输一次新口令", isPassword: true)
                if !newPw2.isEmpty && newPw != newPw2 {
                    Text("两次输入的新口令不一致")
                        .font(.system(size: Dim.fsMinor))
                        .foregroundStyle(p.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                WebButton(busy ? "提交中…" : "确认修改",
                          variant: .primary, size: .md, block: true,
                          disabled: !ready) {
                    Task { await submit() }
                }
                .accessibilityLabel("确认修改口令")
                Text("改完会用新会话继续（其它设备上的登录会失效）")
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var ready: Bool {
        !busy && !oldPw.isEmpty && newPw.count >= 6 && newPw == newPw2
    }

    private func submit() async {
        guard ready else { return }
        busy = true
        defer { busy = false }
        do {
            let session = try await APIClient.shared.changePassword(oldPassword: oldPw, newPassword: newPw)
            APIClient.shared.adopt(session)
            ToastCenter.shared.show("口令已更新")
            onClose()
        } catch {
            ToastCenter.shared.show(SettingsErrorText.described(error))
        }
    }
}

// MARK: - 数据备份

/// 备份文件（.sm，内容就是同一份 JSON）—— 交给系统文件导出面板
struct SettingsBackupDoc: FileDocument {
    /// 未注册的扩展名会得到动态 UTType；退回 json 也不会崩
    static let smType = UTType(filenameExtension: "sm") ?? .json

    static var readableContentTypes: [UTType] { [smType, .json] }
    static var writableContentTypes: [UTType] { [smType] }

    var text: String

    init(text: String) { self.text = text }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let text = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.text = text
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

/// WebDAV 配置（持久化形态与 hw 同键 webdav_config、同字段）
struct SettingsDav: Codable {
    var url: String
    var user: String
    var pass: String
}

private struct SettingsBackupDislike: Codable {
    var type: String
    var targetId: String
    var name: String
    var createdAt: Double?
}

/// 备份体（hw SmBackupFile 同构，字段同名同序）
private struct SettingsBackupPayload: Encodable {
    let version: Int
    let app: String
    let type: String
    let exportedAt: String
    let total: Int
    let tracks: [Track]
    let dislikes: [SettingsBackupDislike]
    let webdav: SettingsDav
}

/// 回写前的宽松校验形态：字段全可缺省，校验后再用
private struct SettingsBackupRaw: Decodable {
    let type: String?
    let tracks: [Track]?
    let dislikes: [SettingsBackupDislike]?
    let webdav: SettingsDav?
}

/// WebDAV 传输（对齐 hw core/WebDavClient.ets）：目标固定 地址去尾斜杠 + /suenmusic.sm
enum SettingsWebDav {
    static let fileName = "suenmusic.sm"

    private static func target(_ url: String) throws -> URL {
        var base = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        guard !base.isEmpty, let target = URL(string: base + "/" + fileName) else {
            throw ApiError(status: 0, code: "invalid", message: "请填写 WebDAV 地址")
        }
        return target
    }

    /// hw connect 15s / read 60s；iOS 无独立连接超时开关，
    /// 用 request 60s（读）+ resource 75s（连接 15 + 读 60）逼近同一口径。
    private static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 75
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }

    /// user 非空才加 Basic 认证（与 hw 同口径）
    private static func authHeader(user: String, pass: String) -> String? {
        if user.isEmpty { return nil }
        return "Basic " + Data((user + ":" + pass).utf8).base64EncodedString()
    }

    /// 上传（PUT，2xx 才算成功，带 Content-Type: application/json）
    static func put(url: String, user: String, pass: String, text: String) async throws {
        var req = URLRequest(url: try target(url))
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let auth = authHeader(user: user, pass: pass) {
            req.setValue(auth, forHTTPHeaderField: "Authorization")
        }
        req.httpBody = Data(text.utf8)
        let (_, response) = try await send(req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw ApiError(status: code, code: "webdav", message: "上传失败（HTTP \(code)）")
        }
    }

    /// 下载（GET，2xx 才算成功；空文件单独一档文案）
    static func get(url: String, user: String, pass: String) async throws -> String {
        var req = URLRequest(url: try target(url))
        req.httpMethod = "GET"
        if let auth = authHeader(user: user, pass: pass) {
            req.setValue(auth, forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await send(req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw ApiError(status: code, code: "webdav", message: "下载失败（HTTP \(code)）")
        }
        let text = String(data: data, encoding: .utf8) ?? ""
        if text.isEmpty {
            throw ApiError(status: code, code: "empty", message: "下载到空文件")
        }
        return text
    }

    private static func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session().data(for: request)
        } catch {
            // 传输层失败（DNS / 连接 / 超时）统一这一句，与 hw 同文案
            throw ApiError(status: 0, code: "webdav", message: "连不上 WebDAV 服务，请检查地址与网络")
        }
    }
}

/// 数据备份弹层：文件导出/导入 + WebDAV 三栏（hw backupSheet）
@MainActor
struct SettingsBackupSheet: View {
    @Environment(\.colorScheme) private var scheme
    let onClose: () -> Void

    @State private var davUrl = ""
    @State private var davUser = ""
    @State private var davPass = ""
    @State private var busy = false
    @State private var msg = ""

    @State private var exportDoc: SettingsBackupDoc?
    @State private var exportName = ""
    @State private var exporterShown = false
    @State private var importerShown = false

    private var p: Palette { Palette(scheme) }

    /// hw PREF_WEBDAV：同一份 JSON 字符串 {url,user,pass}
    private static let davKey = "webdav_config"

    var body: some View {
        SettingsSheetShell(title: "数据备份", onClose: onClose) {
            VStack(alignment: .leading, spacing: Dim.s3) {
                HStack(spacing: Dim.s2) {
                    WebButton(busy ? "处理中…" : "导出文件",
                              variant: .plain, size: .md, block: true, disabled: busy) {
                        Task { await exportFile() }
                    }
                    .accessibilityLabel("导出备份文件")
                    WebButton("导入文件",
                              variant: .plain, size: .md, block: true, disabled: busy) {
                        importerShown = true
                    }
                    .accessibilityLabel("导入备份文件")
                }
                if !msg.isEmpty {
                    Text(msg)
                        .font(.system(size: Dim.fsMinor))
                        .foregroundStyle(p.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Rectangle()
                    .fill(p.line)
                    .frame(height: Dim.hairline)
                davField("WebDAV", placeholder: "https://dav.example.com/music", text: $davUrl)
                davField("账号", placeholder: "WebDAV 账号", text: $davUser)
                davField("口令", placeholder: "WebDAV 口令", text: $davPass, isPassword: true)
                HStack(spacing: Dim.s2) {
                    WebButton("上传", variant: .plain, size: .md, block: true) {
                        Task { await upload() }
                    }
                    .accessibilityLabel("上传备份到 WebDAV")
                    WebButton("下载", variant: .primary, size: .md, block: true) {
                        Task { await download() }
                    }
                    .accessibilityLabel("从 WebDAV 下载备份")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { loadDav() }
        .fileExporter(isPresented: $exporterShown,
                      document: exportDoc,
                      contentType: SettingsBackupDoc.smType,
                      defaultFilename: exportName) { result in
            Task { @MainActor in
                switch result {
                case .success: msg = "已导出"
                case .failure(let error):
                    // 用户点取消不是失败：不提示
                    if !isCancelled(error) { msg = "导出失败" }
                }
                busy = false
            }
        }
        .fileImporter(isPresented: $importerShown,
                      allowedContentTypes: [SettingsBackupDoc.smType, .json],
                      allowsMultipleSelection: false) { result in
            Task { @MainActor in
                do {
                    let urls = try result.get()
                    guard let url = urls.first else {
                        busy = false
                        return
                    }
                    let text = try readText(url)
                    await applyBackup(text)
                } catch {
                    if !isCancelled(error) { msg = SettingsErrorText.api(error) }
                }
                busy = false
            }
        }
    }

    private func davField(_ label: String, placeholder: String,
                          text: Binding<String>, isPassword: Bool = false) -> some View {
        HStack(spacing: Dim.s2) {
            Text(label)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text2)
                .frame(width: Dim.fieldLabelW, alignment: .leading)
            NeuInput(text, placeholder: placeholder, isPassword: isPassword)
        }
    }

    // MARK: WebDAV 配置持久化

    private func loadDav() {
        guard let raw = UserDefaults.standard.string(forKey: Self.davKey),
              let data = raw.data(using: .utf8),
              let cfg = try? JSONDecoder().decode(SettingsDav.self, from: data) else { return }
        davUrl = cfg.url
        davUser = cfg.user
        davPass = cfg.pass
    }

    private func saveDav() {
        guard let data = try? JSONEncoder().encode(SettingsDav(url: davUrl, user: davUser, pass: davPass)),
              let raw = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(raw, forKey: Self.davKey)
    }

    // MARK: 文件

    /// 文件名 suenmusic_backup_YYYY-MM-DD.sm（与 hw 同名，跨端互认）
    private var backupFileName: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return "suenmusic_backup_" + f.string(from: Date()) + ".sm"
    }

    /// 系统文件面板的「取消」以 NSUserCancelledError 回来，不该当成错误文案
    private func isCancelled(_ error: Error) -> Bool {
        (error as NSError).code == NSUserCancelledError
    }

    private func readText(_ url: URL) throws -> String {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else {
            throw ApiError(status: 0, code: "file", message: "读取备份文件失败")
        }
        return text
    }

    private func exportFile() async {
        if busy { return }
        busy = true
        msg = ""
        let text = await buildBackupText()
        exportDoc = SettingsBackupDoc(text: text)
        exportName = backupFileName
        exporterShown = true
    }

    // MARK: 备份体

    /// 组装备份 JSON（tracks + dislikes + webdav 自包含，2 空格美化）
    private func buildBackupText() async -> String {
        var tracks: [Track] = []
        if let list = try? await APIClient.shared.favoriteTracks(limit: 500) { tracks = list }
        var dislikes: [SettingsBackupDislike] = []
        if let list = try? await APIClient.shared.dislikes() {
            dislikes = list.map {
                SettingsBackupDislike(type: $0.type ?? "", targetId: $0.targetId ?? "",
                                      name: $0.name ?? "", createdAt: $0.createdAt)
            }
        }
        let payload = SettingsBackupPayload(
            version: 1,
            app: "suenmusic",
            type: "favorites_backup",
            exportedAt: Self.iso.string(from: Date()),
            total: tracks.count,
            tracks: tracks,
            dislikes: dislikes,
            webdav: SettingsDav(url: davUrl, user: davUser, pass: davPass)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(payload) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// 回写备份（导入文件 / WebDAV 下载共用）：先校验 type 与 tracks，再导收藏，再逐条恢复黑名单
    private func applyBackup(_ text: String) async {
        guard let data = text.data(using: .utf8),
              let raw = try? JSONDecoder().decode(SettingsBackupRaw.self, from: data) else {
            msg = "不是有效的备份文件"
            return
        }
        guard raw.type == "favorites_backup", let tracks = raw.tracks else {
            msg = "备份结构不正确（缺少 tracks）"
            return
        }
        do {
            var added = 0
            if !tracks.isEmpty {
                added = (try await APIClient.shared.importFavorites(tracks)).added ?? 0
            }
            for row in raw.dislikes ?? [] {
                guard row.type == "track" || row.type == "artist" else { continue }
                // 单条恢复失败不阻断整份备份
                try? await APIClient.shared.addDislike(type: row.type, id: row.targetId, name: row.name)
            }
            if let dav = raw.webdav, !dav.url.isEmpty {
                davUrl = dav.url
                davUser = dav.user
                davPass = dav.pass
                saveDav()
            }
            msg = "新增 \(added) 首 · 跳过 \(max(0, tracks.count - added))"
        } catch {
            msg = SettingsErrorText.api(error)
        }
    }

    // MARK: WebDAV

    private func upload() async {
        if busy { return }
        guard !davUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            msg = "请填写 WebDAV 地址"
            return
        }
        busy = true
        msg = ""
        defer { busy = false }
        do {
            saveDav()
            let text = await buildBackupText()
            try await SettingsWebDav.put(url: davUrl, user: davUser, pass: davPass, text: text)
            msg = "已上传"
        } catch {
            msg = SettingsErrorText.api(error)
        }
    }

    private func download() async {
        if busy { return }
        guard !davUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            msg = "请填写 WebDAV 地址"
            return
        }
        busy = true
        msg = ""
        defer { busy = false }
        do {
            saveDav()
            let text = try await SettingsWebDav.get(url: davUrl, user: davUser, pass: davPass)
            await applyBackup(text)
        } catch {
            msg = SettingsErrorText.api(error)
        }
    }
}
