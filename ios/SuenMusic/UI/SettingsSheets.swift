import SwiftUI
import Foundation

/**
 * 设置页的四张底部弹层 + 弹层外壳 —— 逐项对齐鸿蒙端 pages/SettingsPage.ets。
 *
 *   · 黑名单 / 歌单导入 / 去重 / 修改密码
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

/// 四张弹层的统一外壳（scrim + 上滑面板 + 把手/标题/收起键）。
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
