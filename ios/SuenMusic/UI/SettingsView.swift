import SwiftUI

/**
 * 设置页 —— 逐项对齐鸿蒙端 pages/SettingsPage.ets（本机 / 智能 / 高级 三分段）。
 *
 * 页面结构（与 hw 同名同序）：
 *   标题「设置」18 Bold → NeuTabs(本机/智能/高级) → 分段内容；
 *   分区标签 = 11 Medium text2 + 右侧延伸发丝线，内容卡片 = panel 底 + 发丝描边 + radiusMd。
 *
 *   · 本机：播放（缓存行：已用 / 上限，点击二次确认清空 / 歌词翻译开关）/ 主题（三态）/ 资料库（黑名单 / 歌单导入 / 去重 / 数据备份）/ 账号
 *   · 智能：画像折叠卡（summary → 分隔线 → profileLines → ledgerLines）/ 调优（guidance 输入 + 上一次回显）
 *   · 高级：检查更新（三形态）/ 多服务端 / 音源授权（只读）
 *
 * 五张弹层在 SettingsSheets.swift；本页只负责挂载与数据。
 * 提示统一走 ToastCenter，二次确认统一走 ConfirmDialog（不再用系统 alert）。
 */
struct SettingsView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var theme: ThemeStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    /// DEBUG 钩子：SIMCTL_CHILD_SUEN_SETTINGS_SEG=2 直接落「高级」段（无触摸环境验界面用）
    @State private var seg = SettingsView.initialSeg()
    @State private var sheet: SettingsSheetKind?
    @State private var showServers = false

    // 本机：缓存用量（真实值，行内直显 已用 / 上限）+ 清空二次确认
    @State private var cacheUsed: Int64 = 0
    @State private var cacheClearAsk = false

    // 本机：开关（与 hw 同键）
    @AppStorage("lyric_translation") private var lyricTrans = true

    // 本机：资料库黑名单计数
    @State private var dislikes: [DislikeEntry] = []

    // 账号
    @State private var signOutAsk = false

    // 智能
    @State private var persona: PersonaReply?
    @State private var personaOpen = false
    @State private var guidance = ""
    @State private var tuning = false
    @AppStorage("last_tune_prompt") private var lastTune = ""

    // 高级
    @State private var updState = ""
    @State private var checkingUpd = false
    @AppStorage("auto_failover") private var autoFailover = true
    @State private var biliLabel = "未授权"
    @State private var neteaseLabel = "未授权"
    /// 酷狗（概念版）：昵称 · 登录态，文案来自服务端四态
    @State private var kugouLabel = "未登录"

    private let segLabels = ["本机", "智能", "高级"]

    private var p: Palette { Palette(scheme) }

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(alignment: .leading, spacing: Dim.s4) {
                    Text("设置")
                        .font(.system(size: Dim.fsHeadline, weight: .bold))
                        .foregroundStyle(p.text1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    NeuTabs(titles: segLabels, selection: $seg)
                    if seg == 0 {
                        localTab
                    } else if seg == 1 {
                        smartTab
                    } else {
                        advancedTab
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Dim.s4)
                .padding(.top, Dim.s4)
                .padding(.bottom, Dim.s5)
            }
            .scrollIndicators(.hidden)

            sheetLayer
            dialogLayer
        }
        .background(p.bg)
        .toolbar(.hidden, for: .navigationBar)
        .animation(Motion.curve, value: sheet)
        .animation(Motion.curve, value: showServers)
        .task {
            loadCacheUsage()
            await loadDislikes()
            await loadPersona()
            await loadSources()
        }
    }

    // MARK: - 本机

    private var localTab: some View {
        VStack(alignment: .leading, spacing: Dim.s4) {
            secLabel("播放")
            card {
                // 真实用量（AudioCacheStore 完整文件缓存 + 1GB LRU，规格 6.2）；行即入口，点击只做二次确认清空
                rowButton("缓存", value: cacheUsageText, first: true) {
                    loadCacheUsage()
                    cacheClearAsk = true
                }
                .accessibilityLabel("缓存：已用 " + SettingsFmt.cacheUsed(cacheUsed)
                                    + "，上限 " + SettingsFmt.cacheLimit(cacheQuota))
                toggleRow("显示歌词翻译", "原文行下方同时显示翻译", isOn: $lyricTrans)
            }

            secLabel("主题")
            card {
                NeuTabs(titles: ThemeMode.allCases.map(\.label), selection: themeBinding)
                    .padding(Dim.s3)
            }

            secLabel("资料库")
            card {
                rowButton("黑名单",
                          value: "歌曲 " + String(dislikeCount("track")) + " · 歌手 " + String(dislikeCount("artist")),
                          first: true) {
                    Task {
                        await loadDislikes()
                        sheet = .dislikes
                    }
                }
                .accessibilityLabel("黑名单")
                rowButton("歌单导入", value: "QQ 歌单") { sheet = .importPlaylist }
                    .accessibilityLabel("打开歌单导入")
                // 行本身即触发点：点击直接预检并开弹层
                rowButton("去重", value: "本机收藏") { sheet = .dedupe }
                    .accessibilityLabel("打开去重")
            }

            secLabel("账号")
            card {
                if let user = app.user {
                    rowButton(accountName(user), value: accountTag(user), first: true) {
                        sheet = .password
                    }
                    .accessibilityLabel("账号信息 " + accountName(user) + " " + accountTag(user) + "，点击修改密码")
                    Button {
                        signOutAsk = true
                    } label: {
                        HStack(spacing: Dim.s2) {
                            Text("退出登录")
                                .font(.system(size: Dim.fsBody))
                                .foregroundStyle(p.danger)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(height: Dim.touchMin)
                        .padding(.horizontal, Dim.s4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .overlay(alignment: .top) {
                        Rectangle().fill(p.line).frame(height: Dim.hairline)
                    }
                    .accessibilityLabel("退出登录")
                } else {
                    rowStatic("未登录", value: "", first: true)
                }
            }
        }
    }

    // MARK: - 智能

    private var smartTab: some View {
        VStack(alignment: .leading, spacing: Dim.s4) {
            secLabel("画像")
            personaCard

            secLabel("调优")
            card {
                VStack(alignment: .leading, spacing: Dim.s2) {
                    NeuInput($guidance, placeholder: "例如：少一点电音")
                    HStack(spacing: Dim.s3) {
                        VStack(alignment: .leading, spacing: Dim.s0) {
                            Text("上一次")
                                .font(.system(size: Dim.fsCaption))
                                .foregroundStyle(p.text2)
                            Text(lastTune.isEmpty ? "还没有记录" : lastTune)
                                .font(.system(size: Dim.fsBody))
                                .foregroundStyle(p.text1)
                                .lineLimit(2)
                                .truncationMode(.tail)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        WebButton(tuning ? "调优中…" : "提交",
                                  variant: .primary, size: .md,
                                  disabled: tuning || trimmedGuidance.isEmpty) {
                            Task { await submitTune() }
                        }
                        .accessibilityLabel(tuning ? "正在调优" : "提交调优意见")
                    }
                }
                .padding(Dim.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// 画像折叠卡：头 44（有 summary 时「音乐画像」，否则「尚未生成」）+ chevron
    private var personaCard: some View {
        VStack(spacing: 0) {
            Button {
                personaOpen.toggle()
            } label: {
                HStack(spacing: Dim.s2) {
                    Text(hasPersonaSummary ? "音乐画像" : "尚未生成")
                        .font(.system(size: Dim.fsBody))
                        .foregroundStyle(p.text1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    WebIcon(personaOpen ? .chevronUp : .chevronDown, size: Dim.icon18)
                        .foregroundStyle(p.text2)
                }
                .frame(height: Dim.touchMin)
                .padding(.horizontal, Dim.s4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(personaOpen ? "收起画像" : "展开画像")

            if personaOpen {
                personaBody
            }
        }
        .background(p.panel)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                .strokeBorder(p.line, lineWidth: Dim.hairline)
        )
    }

    private var personaBody: some View {
        let lines = SettingsPersonaMd.lines(persona)
        return VStack(alignment: .leading, spacing: Dim.s2) {
            if lines.isEmpty {
                Text("暂无")
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    mdRow(line)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s0)
        .padding(.bottom, Dim.s3)
        .overlay(alignment: .top) {
            Rectangle().fill(p.line).frame(height: Dim.hairline)
        }
    }

    @ViewBuilder
    private func mdRow(_ line: SettingsPersonaLine) -> some View {
        switch line.kind {
        case .rule:
            Rectangle()
                .fill(p.line)
                .frame(height: Dim.hairline)
                .frame(maxWidth: .infinity)
        case .title:
            let size = line.minor ? Dim.fsBody : Dim.fsSub
            Text(line.text)
                .font(.system(size: size, weight: .medium))
                .foregroundStyle(p.text1)
                .lineSpacing(lineSpacing(size, 22))
                .frame(maxWidth: .infinity, alignment: .leading)
        case .bullet:
            let size = line.minor ? Dim.fsMinor : Dim.fsBody
            Text("· " + line.text)
                .font(.system(size: size))
                .foregroundStyle(p.text2)
                .lineSpacing(lineSpacing(size, 20))
                .frame(maxWidth: .infinity, alignment: .leading)
        case .body:
            let size = line.minor ? Dim.fsMinor : Dim.fsBody
            Text(line.text)
                .font(.system(size: size))
                .foregroundStyle(line.minor ? p.text2 : p.text1)
                .lineSpacing(lineSpacing(size, line.minor ? 20 : 22))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// hw 的 lineHeight 在 SwiftUI 里用 lineSpacing 补（系统默认行高 ≈ 字号 × 1.2）
    private func lineSpacing(_ fontSize: CGFloat, _ lineHeight: CGFloat) -> CGFloat {
        max(0, lineHeight - fontSize * 1.2)
    }

    // MARK: - 高级

    private var advancedTab: some View {
        VStack(alignment: .leading, spacing: Dim.s4) {
            secLabel("设备")
            card {
                rowButton("检查更新", value: updateLabel, first: true,
                          accentValue: updState.hasPrefix("new=")) {
                    Task { await checkUpdate() }
                }
                .accessibilityLabel("检查更新，当前 " + updateLabel)
            }

            secLabel("多服务端")
            card {
                Button {
                    showServers = true
                } label: {
                    HStack(spacing: Dim.s2) {
                        Text("服务端管理")
                            .font(.system(size: Dim.fsBody))
                            .foregroundStyle(p.text1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        WebIcon(.chevronRight, size: Dim.icon16)
                            .foregroundStyle(p.text2)
                    }
                    .frame(height: Dim.touchMin)
                    .padding(.horizontal, Dim.s4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("打开服务端管理")
                toggleRow("自动切换服务器", "网络异常时自动尝试其它服务端", isOn: $autoFailover)
            }

            secLabel("音源授权")
            card {
                rowStatic("bilibili", value: biliLabel, first: true)
                rowStatic("网易云", value: neteaseLabel)
                rowStatic("酷狗", value: kugouLabel)
            }
        }
    }

    // MARK: - 通用组件

    /// 分区标签：小字 + 右侧延伸发丝线
    private func secLabel(_ title: String) -> some View {
        HStack(spacing: Dim.s3) {
            Text(title)
                .font(.system(size: Dim.fsCaption, weight: .medium))
                .foregroundStyle(p.text2)
            Rectangle()
                .fill(p.line)
                .frame(height: Dim.hairline)
                .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity)
    }

    /// 面板容器：panel 底 + 发丝描边 + 中圆角
    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .frame(maxWidth: .infinity)
            .background(p.panel)
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                    .strokeBorder(p.line, lineWidth: Dim.hairline)
            )
    }

    /// 可点击行：44 高 / 左右 16 / 左 13 text1 + 右 12 text2；first = 组内首行不加顶线
    private func rowButton(_ name: String, value: String, first: Bool = false,
                           accentValue: Bool = false,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            rowLabel(name, value: value, accentValue: accentValue)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) {
            if !first {
                Rectangle().fill(p.line).frame(height: Dim.hairline)
            }
        }
    }

    /// 静态展示行（不可点）
    private func rowStatic(_ name: String, value: String, first: Bool = false) -> some View {
        rowLabel(name, value: value, accentValue: false)
            .overlay(alignment: .top) {
                if !first {
                    Rectangle().fill(p.line).frame(height: Dim.hairline)
                }
            }
    }

    private func rowLabel(_ name: String, value: String, accentValue: Bool) -> some View {
        HStack(spacing: Dim.s2) {
            Text(name)
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !value.isEmpty {
                Text(value)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(accentValue ? p.accentText : p.text2)
                    .lineLimit(1)
            }
        }
        .frame(height: Dim.touchMin)
        .padding(.horizontal, Dim.s4)
    }

    /// 开关行（标题 + 副行 + 右侧 Toggle）；hw 里这类行一律带顶线
    private func toggleRow(_ title: String, _ subtitle: String, isOn: Binding<Bool>,
                           first: Bool = false) -> some View {
        HStack(spacing: Dim.s2) {
            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(title)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text1)
                Text(subtitle)
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Toggle("", isOn: isOn)
                .labelsHidden()
                .tint(p.accent)
                .accessibilityLabel(title)
        }
        .frame(minHeight: Dim.touchMin)
        .padding(.horizontal, Dim.s4)
        .overlay(alignment: .top) {
            if !first {
                Rectangle().fill(p.line).frame(height: Dim.hairline)
            }
        }
    }

    // MARK: - 弹层挂载

    @ViewBuilder
    private var sheetLayer: some View {
        switch sheet {
        case .dislikes:
            SettingsDislikesSheet(items: $dislikes, reload: { await loadDislikes() }, onClose: closeSheet)
        case .importPlaylist:
            SettingsImportSheet(onClose: closeSheet)
        case .dedupe:
            SettingsDedupeSheet(onClose: closeSheet)
        case .backup:
            SettingsBackupSheet(onClose: closeSheet)
        case .password:
            SettingsPasswordSheet(onClose: closeSheet)
        case nil:
            EmptyView()
        }
        if showServers {
            ServerListSheet(onClose: { showServers = false })
                .transition(.move(edge: .bottom))
        }
    }

    @ViewBuilder
    private var dialogLayer: some View {
        if cacheClearAsk {
            ConfirmDialog(
                title: "清空缓存",
                message: "将删除全部已缓存的歌曲，确定清空？",
                confirmTitle: "清空",
                danger: true,
                onCancel: { cacheClearAsk = false },
                onConfirm: {
                    AudioCacheStore.shared.clearAll()
                    cacheClearAsk = false
                    loadCacheUsage()
                    ToastCenter.shared.show("缓存已清空")
                }
            )
        }
        if signOutAsk {
            ConfirmDialog(
                title: "退出登录",
                message: "退出后本机偏好与离线快照保留，重新登录即可继续收听。",
                confirmTitle: "退出",
                danger: true,
                onCancel: { signOutAsk = false },
                onConfirm: {
                    signOutAsk = false
                    app.signOut()
                }
            )
        }
    }

    private func closeSheet() {
        sheet = nil
    }

    // MARK: - 数据

    private static func initialSeg() -> Int {
        #if DEBUG
        return DebugHooks.int("SUEN_SETTINGS_SEG") ?? 0
        #else
        return 0
        #endif
    }

    private var cacheQuota: Int64 {
        AudioCacheStore.maxBytes
    }

    /// 行右侧文案：已用 / 上限 → 形如 "100M / 1G"（右值专用格式，不走通用字节文案）
    private var cacheUsageText: String {
        SettingsFmt.cacheUsed(cacheUsed) + " / " + SettingsFmt.cacheLimit(cacheQuota)
    }

    private func loadCacheUsage() {
        cacheUsed = AudioCacheStore.shared.usedBytes
    }

    private func dislikeCount(_ type: String) -> Int {
        dislikes.reduce(0) { $0 + (($1.type ?? "") == type ? 1 : 0) }
    }

    private func loadDislikes() async {
        // 静默：拉不到只是计数不显示
        if let list = try? await APIClient.shared.dislikes() {
            dislikes = list
        }
    }

    private func loadPersona() async {
        persona = try? await APIClient.shared.persona()
    }

    private var hasPersonaSummary: Bool {
        guard let summary = persona?.summary else { return false }
        return !summary.isEmpty
    }

    private var trimmedGuidance: String {
        guidance.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func submitTune() async {
        let text = trimmedGuidance
        guard !text.isEmpty, !tuning else { return }
        tuning = true
        defer { tuning = false }
        do {
            persona = try await APIClient.shared.tunePersona(guidance: text)
            lastTune = text
            guidance = ""
            ToastCenter.shared.show("画像已更新")
        } catch {
            ToastCenter.shared.show(SettingsErrorText.api(error))
        }
    }

    private func loadSources() async {
        if let st = try? await APIClient.shared.bilibiliAccount() {
            biliLabel = sourceLabel(st)
        } else {
            biliLabel = "未授权"
        }
        if let st = try? await APIClient.shared.neteaseAccount() {
            // 网易云的 account 可能为 null 而 configured 为 true —— 授权与否以 configured 为准
            neteaseLabel = sourceLabel(st)
        } else {
            neteaseLabel = "未授权"
        }
        if let kg = try? await APIClient.shared.kugouStatus() {
            // 与另两行同构：有昵称时前置「昵称 · 状态」
            let name = (kg.nickname?.isEmpty == false) ? kg.nickname! : ((kg.userid?.isEmpty == false) ? "uid \(kg.userid!)" : "")
            kugouLabel = (kg.state != "logged_out" && !name.isEmpty) ? "\(name) · \(kg.label)" : kg.label
        } else {
            kugouLabel = "未登录"
        }
    }

    /// 有昵称显示昵称；缺昵称但已配置显示「已授权」
    private func sourceLabel(_ st: SourceAccount) -> String {
        if let name = st.account?.name, !name.isEmpty { return name }
        return st.configured ? "已授权" : "未授权"
    }

    // MARK: - 账号

    private func accountName(_ user: PublicUser) -> String {
        user.displayName.isEmpty ? user.username : user.displayName
    }

    /// 右侧「用户名-角色」（admin → 管理员）
    private func accountTag(_ user: PublicUser) -> String {
        user.username + "-" + (user.role == "admin" ? "管理员" : "用户")
    }

    // MARK: - 检查更新

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
        guard !checkingUpd else { return }
        checkingUpd = true
        defer { checkingUpd = false }
        do {
            let reply = try await APIClient.shared.checkUpdate(
                versionName: appVersion, versionCode: appBuild, force: true
            )
            if reply.available, let latest = reply.latest {
                updState = "new=" + latest.versionName
                let url = APIClient.shared.updateDownloadURL(path: reply.downloadPath, token: reply.downloadToken)
                openForInstall(url, versionName: latest.versionName)
            } else {
                updState = "latest"
                ToastCenter.shared.show("已是最新版本")
            }
        } catch {
            // 失败不占行尾形态：回落「版本号」，原因只弹 toast
            updState = ""
            ToastCenter.shared.show(SettingsErrorText.described(error))
        }
    }

    /// 更新投递阶梯：① altstore://install ② sidestore://install ③ 都没有 → 交给 Safari 下载。
    private func openForInstall(_ urlString: String, versionName: String) {
        let encoded = urlString.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? urlString
        for scheme in ["altstore", "sidestore"] {
            if let probe = URL(string: scheme + "://install?url=" + encoded),
               UIApplication.shared.canOpenURL(probe) {
                UIApplication.shared.open(probe)
                ToastCenter.shared.show("新版本 " + versionName + "：已交给 " + scheme + " 安装")
                return
            }
        }
        if let target = URL(string: urlString) {
            openURL(target)
            ToastCenter.shared.show("新版本 " + versionName + "：已交给浏览器下载（未装侧载工具）")
        }
    }

    // MARK: - 主题

    private var themeBinding: Binding<Int> {
        Binding(
            get: {
                ThemeMode.allCases.firstIndex(of: theme.mode) ?? 0
            },
            set: { index in
                let mode = ThemeMode.allCases[index]
                theme.set(mode)
                ToastCenter.shared.show("主题：" + mode.label)
            }
        )
    }
}

// MARK: - 弹层种类

/// 设置页的五张弹层（与 hw 的 sheet 字符串一一对应）
enum SettingsSheetKind: String, Identifiable {
    case dislikes
    case importPlaylist
    case dedupe
    case backup
    case password

    var id: String { rawValue }
}

// MARK: - 画像 md 行

/// 画像 md 行（kind 与 hw MdLine 同值：正文 / 标题 / 列表项 / 分隔线；minor = 次级行）
struct SettingsPersonaLine {
    enum Kind {
        case body
        case title
        case bullet
        case rule
    }

    let kind: Kind
    let text: String
    let minor: Bool
}

/// 画像三段 md 合并解析（summary → 分隔线 → profileLines → ledgerLines）
enum SettingsPersonaMd {
    static func lines(_ persona: PersonaReply?) -> [SettingsPersonaLine] {
        guard let persona else { return [] }
        var out: [SettingsPersonaLine] = []
        push(persona.summary ?? "", minor: false, into: &out)
        let mark = out.count
        for line in persona.profileLines { push(line, minor: true, into: &out) }
        // summary 与特征段之间补一条分隔线（两边都有内容才补，与 hw 同判据）
        if mark > 0 && mark < out.count {
            out.insert(SettingsPersonaLine(kind: .rule, text: "", minor: false), at: mark)
        }
        for line in persona.ledgerLines { push(line, minor: true, into: &out) }
        return out
    }

    private static func push(_ raw: String, minor: Bool, into out: inout [SettingsPersonaLine]) {
        for piece in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            let text = piece.trimmingCharacters(in: .whitespaces)
            if text.isEmpty { continue }
            if text == "---" || text == "***" || text == "___" {
                out.append(SettingsPersonaLine(kind: .rule, text: "", minor: minor))
            } else if text.hasPrefix("#") {
                let stripped = text.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
                out.append(SettingsPersonaLine(kind: .title, text: stripInline(stripped), minor: minor))
            } else if text.hasPrefix("- ") || text.hasPrefix("* ") || text.hasPrefix("• ") {
                out.append(SettingsPersonaLine(kind: .bullet, text: stripInline(String(text.dropFirst(2))), minor: minor))
            } else {
                out.append(SettingsPersonaLine(kind: .body, text: stripInline(text), minor: minor))
            }
        }
    }

    /// 去掉 md 行内记号（双星号 / 单星号 / 反引号）：Text 不渲染富文本，裸记号非常刺眼
    private static func stripInline(_ raw: String) -> String {
        let tick = String(UnicodeScalar(96) ?? " ")
        return raw
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "*", with: "")
            .replacingOccurrences(of: tick, with: "")
            .trimmingCharacters(in: .whitespaces)
    }
}
