import SwiftUI

/**
 * 离线缓存页 —— **对齐鸿蒙端 `pages/CachePage.ets`（2026-10-23 验收二次裁定版）**。
 *
 * 设计意图照搬 hw：缓存是「后台静默下载、用户无需管理」的设施 —— 播放过的歌自动落盘，
 * 超配额按最久未使用自动淘汰。用户唯一关心的只有两件事：**占了多少、一键清空**。
 *
 * 所以这里**没有逐曲列表、没有用量卡、没有进度条**：只有
 *   头部（返回 + 标题）→ 一行「缓存：已使用 X　上限 Y」→ 一行说明（为什么没有逐条管理）
 *   → 全宽 danger「清空全部」（一首缓存都没有时禁用）。
 */
struct CachePage: View {
    @Environment(\.colorScheme) private var scheme

    /// 关闭回调（hw `onClose`）：由承载浮层的一方收起页面
    var onClose: () -> Void = {}

    @State private var used: Int64 = 0
    /// 缓存曲目数（清空按钮的禁用依据 + 确认文案里的「N 首」）
    @State private var count = 0
    @State private var confirmClear = false

    private var p: Palette { Palette(scheme) }

    var body: some View {
        VStack(spacing: 0) {
            header
            usageLine
            hint
            clearButton
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(p.bg)
        .task { refresh() }
        .overlay {
            if confirmClear { clearConfirm }
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

    // MARK: - 用量与说明

    /// 用量：一行纯文本（验收口径「缓存：已使用 X　上限 Y」，无卡片无进度条）
    private var usageLine: some View {
        Text("缓存：已使用 \(fmtBytes(used))　上限 \(fmtBytes(AudioCacheStore.maxBytes))")
            .font(.system(size: Dim.fsSub))
            .foregroundStyle(p.text1)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.top, Dim.s4)
            .padding(.bottom, Dim.s1)
    }

    /// 设计意图说明（为什么没有逐条管理）：一行小字足矣
    private var hint: some View {
        Text("播放过的歌曲会在后台自动缓存，无需手动管理；超过配额会自动清理最久未听的")
            .font(.system(size: Dim.fsCaption))
            .foregroundStyle(p.text2)
            .multilineTextAlignment(.center)
            .padding(.horizontal, Dim.s6)
            .padding(.vertical, Dim.s1)
    }

    // MARK: - 清空（唯一的管理动作）

    private var clearButton: some View {
        WebButton("清空全部", variant: .danger, size: .lg, block: true, disabled: count == 0) {
            confirmClear = true
        }
        .accessibilityLabel("清空全部离线缓存")
        .padding(.horizontal, Dim.s5)
        .padding(.top, Dim.s4)
        .padding(.bottom, Dim.s3)
    }

    /// 二次确认（文案照 hw：把「清掉几首 / 释放多少」说清，而不是干巴巴一句「确定清空吗」）
    private var clearConfirm: some View {
        ConfirmDialog(
            title: "清空离线缓存",
            message: "将删除全部 \(count) 首缓存（正在播放的除外），释放约 \(fmtBytes(used)) 空间。"
                + "之后播放会重新联网下载。",
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
        used = store.usedBytes()
        count = store.entryCount()
    }

    /// 与 hw `CachePage.fmtBytes` 逐值同口径：
    /// ≥1GB 两位小数 GB / ≥1MB 一位小数 MB / 否则 `max(1, round(KB))` KB
    private func fmtBytes(_ bytes: Int64) -> String {
        let gb = Double(1024 * 1024 * 1024)
        let mb = Double(1024 * 1024)
        let value = Double(bytes)
        if value >= gb { return String(format: "%.2f", value / gb) + " GB" }
        if value >= mb { return String(format: "%.1f", value / mb) + " MB" }
        return String(max(1, Int((value / 1024).rounded()))) + " KB"
    }
}
