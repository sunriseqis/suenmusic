import SwiftUI

/**
 * 离线缓存页 —— 显示的是**磁盘上的真实数据**（完整文件缓存 + 1GB LRU，规格 6.2）。
 *
 * 与上一轮的做法相反：这里不承诺「不存在的能力」。
 * 每条缓存都是一次**完整下载**（来源是 CDN 直链，不经服务端代理），
 * 所以页面能逐条列出、逐条删除；超配额时按「最久未访问」自动淘汰，文案照实写。
 */
struct CachePage: View {
    @Environment(\.colorScheme) private var scheme

    /// 关闭回调（由承载方收起浮层）
    var onClose: () -> Void = {}

    @State private var entries: [AudioCacheStore.Entry] = []
    @State private var used: Int64 = 0
    @State private var confirmClear = false
    @State private var confirmDelete: AudioCacheStore.Entry?

    private var p: Palette { Palette(scheme) }

    var body: some View {
        VStack(spacing: 0) {
            header
            usageLine
            content
            clearButton
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(p.bg)
        .task { refresh() }
        .overlay {
            if confirmClear { clearConfirm }
        }
        .overlay {
            if let target = confirmDelete {
                ConfirmDialog(
                    title: "删除缓存",
                    message: "将删除《\(target.name)》的缓存文件（\(fmtBytes(target.bytes))），之后播放会重新联网下载。",
                    cancelTitle: "取消",
                    confirmTitle: "删除",
                    danger: true,
                    onCancel: { confirmDelete = nil },
                    onConfirm: {
                        AudioCacheStore.shared.evict(target.trackId)
                        confirmDelete = nil
                        refresh()
                    }
                )
            }
        }
    }

    // MARK: - 头部

    private var header: some View {
        HStack(spacing: Dim.s2) {
            WebButton("返回", variant: .plain, size: .md) { onClose() }
                .accessibilityLabel("返回上一页")
            Spacer(minLength: 0)
            Text("离线缓存")
                .font(.system(size: Dim.fsSection, weight: .medium))
                .foregroundStyle(p.text1)
        }
        .padding(.horizontal, Dim.s3)
        .padding(.vertical, Dim.s2)
    }

    // MARK: - 用量

    private var usageLine: some View {
        Text("缓存：已使用 \(fmtBytes(used))　上限 \(fmtBytes(AudioCacheStore.maxBytes))　·　\(entries.count) 首")
            .font(.system(size: Dim.fsSub))
            .foregroundStyle(p.text1)
            .frame(maxWidth: .infinity)
            .padding(.top, Dim.s4)
            .padding(.bottom, Dim.s2)
    }

    // MARK: - 列表 / 空态

    @ViewBuilder
    private var content: some View {
        if entries.isEmpty {
            VStack(spacing: Dim.s2) {
                Text("还没有缓存的曲目")
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text1)
                Text("直链下载完整结束后才会出现在这里；没有直链的曲目不缓存。")
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, Dim.s6)
        } else {
            ScrollView {
                VStack(spacing: Dim.s1) {
                    ForEach(entries) { entry in
                        row(entry)
                    }
                }
                .padding(.horizontal, Dim.s3)
                .padding(.vertical, Dim.s2)
            }
            .scrollIndicators(.hidden)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func row(_ entry: AudioCacheStore.Entry) -> some View {
        HStack(spacing: Dim.s2) {
            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(entry.name)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text1)
                    .lineLimit(1)
                // 缓存与音质解耦（规格 6.4 / 7.2）：缓存条目里没有音质信息可展示
                Text([entry.artist, fmtBytes(entry.bytes)]
                        .filter { !$0.isEmpty }
                        .joined(separator: " · "))
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            WebButton("删除", variant: .plain, size: .sm) { confirmDelete = entry }
                .accessibilityLabel("删除 \(entry.name) 的缓存")
        }
        .frame(minHeight: Dim.touchMin)
        .padding(.horizontal, Dim.s3)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusRow, style: .continuous).fill(p.panel)
        )
    }

    // MARK: - 清空

    private var clearButton: some View {
        WebButton("清空全部", variant: .danger, size: .lg, block: true, disabled: entries.isEmpty) {
            confirmClear = true
        }
        .accessibilityLabel("清空全部离线缓存")
        .padding(.horizontal, Dim.s5)
        .padding(.top, Dim.s2)
        .padding(.bottom, Dim.s3)
    }

    private var clearConfirm: some View {
        ConfirmDialog(
            title: "清空离线缓存",
            message: "将删除全部 \(entries.count) 首缓存，释放约 \(fmtBytes(used)) 空间。之后播放会重新联网下载。",
            cancelTitle: "取消",
            confirmTitle: "清空",
            danger: true,
            onCancel: { confirmClear = false },
            onConfirm: {
                AudioCacheStore.shared.clearAll()
                confirmClear = false
                refresh()
            }
        )
    }

    // MARK: - 数据

    private func refresh() {
        let store = AudioCacheStore.shared
        used = store.usedBytes
        entries = store.entries()
    }

    /// 与 hw `CachePage.fmtBytes` 逐值同口径：
    /// ≥1GB 两位小数 GB / ≥1MB 一位小数 MB / 否则 max(1, round(KB)) KB
    private func fmtBytes(_ bytes: Int64) -> String {
        let gb = Double(1024 * 1024 * 1024)
        let mb = Double(1024 * 1024)
        let value = Double(bytes)
        if value >= gb { return String(format: "%.2f", value / gb) + " GB" }
        if value >= mb { return String(format: "%.1f", value / mb) + " MB" }
        return String(max(1, Int((value / 1024).rounded()))) + " KB"
    }
}
