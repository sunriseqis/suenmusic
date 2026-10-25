import SwiftUI
import AVFoundation

// MARK: - 候选检索契约（hw `core/Models.ets` 的 BiliCandidate / AnchorTrackMeta 同结构）
//
// iOS 的 `Net/Models.swift` 目前只声明了锚点本身（AnchorInfo），没有候选相关模型，
// 而本次改动不能碰 Net/。这里按 server 契约就地解码（类型名加 Anchor 前缀，
// 避免与将来补进 Models.swift 的同名类型撞车）。

/// 候选视频（锚定弹窗用）：score = 按本曲元数据算的置信分，durationDiff = 与曲目时长之差（秒）
struct AnchorCandidate: Decodable, Identifiable {
    let bvid: String
    let title: String
    let author: String
    let durationSec: Double
    let score: Double
    let durationDiff: Double
    let pic: String?
    /// 试听流地址（相对路径，带短期令牌，需拼服务端基地址）
    let previewUrl: String

    var id: String { bvid }
}

/// 曲目自身的 Q 音元数据（锚定弹窗的「原版参照」）
struct AnchorRefMeta: Decodable {
    let id: String?
    let name: String
    let artists: [String]
    let durationMs: Double?
    let albumName: String
    let albumPic: String?
}

/// `GET /api/tracks/:id/bili-candidates` 的返回
struct AnchorCandidatesReply: Decodable {
    let keyword: String?
    let rejected: Bool?
    let message: String?
    let track: AnchorRefMeta?
    let candidates: [AnchorCandidate]
}

enum AnchorCandidateAPI {
    /// 搜 B 站候选（keyword 缺省时服务端用「歌名 + 主歌手」构造；要等 B 站搜索，预算 20s）
    static func candidates(trackId: String, keyword: String) async throws -> AnchorCandidatesReply {
        var query: [String: String] = [:]
        let trimmed = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { query["keyword"] = trimmed }
        let seg = trackId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trackId
        return try await APIClient.shared.get("/api/tracks/\(seg)/bili-candidates", query: query)
    }
}

/// 试听播放器（**独立于主播放内核**，单实例：换条即换 URI，关弹窗/切歌即停）。
///
/// 试听前必须先停主播放 —— 两条音频叠着放，用户根本听不出试的是哪条。
@MainActor
final class AnchorPreview: ObservableObject {
    /// 正在试听的候选 bvid（空 = 没在放）
    @Published private(set) var bvid = ""
    private var player: AVPlayer?
    private var observers: [NSObjectProtocol] = []
    /// 试听把主播放暂停了（停试听要恢复；锚定流程例外：重装后统一起播）
    private var pausedMain = false

    /// 点候选行即试听；再点同一行 = 停试听并接回主播放
    func toggle(_ candidate: AnchorCandidate, main: PlaybackService) async {
        if bvid == candidate.bvid {
            stop(resumeMain: true, main: main)
            return
        }
        stop(resumeMain: false, main: main)
        guard let url = URL(string: APIClient.shared.absolute(candidate.previewUrl)) else {
            ToastCenter.shared.show("试听加载失败，请稍后重试")
            return
        }
        if main.playing {
            pausedMain = true
            main.pause()
        }
        bvid = candidate.bvid
        let item = AVPlayerItem(url: url)
        let fresh = AVPlayer(playerItem: item)
        player = fresh
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.stop(resumeMain: true, main: main) }
        })
        observers.append(center.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.stop(resumeMain: true, main: main)
                ToastCenter.shared.show("试听加载失败，请稍后重试")
            }
        })
        fresh.play()
    }

    /// 停试听。resumeMain：被试听暂停的主播放是否随之恢复。
    /// 锚定流程传 false —— 马上要重装当前曲，先恢复会闪一下旧音源。
    func stop(resumeMain: Bool, main: PlaybackService) {
        bvid = ""
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        player?.pause()
        player = nil
        guard pausedMain else { return }
        pausedMain = false
        if resumeMain { main.play() }
    }
}

/**
 * 修正音源 / 手动锚定（hw PlayerPage `anchorSheet` + `candidateRow`，web AnchorDialog 同款）。
 *
 * 候选搜索（默认词 = 歌名 + 主歌手，打开即搜）→ 点行试听（先暂停主播放，结束/失败恢复）
 * → 行内图钉键锚定（成功后清该曲离线缓存 → 强制重装当前曲并起播 → toast「已锚定，开始播放」）。
 * 已有锚点可解除（toast「已解除锚定，该曲目回到自动匹配」）。
 */
struct AnchorSheet: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    @Binding private var anchorInfo: AnchorInfo?
    private let onClose: () -> Void

    @StateObject private var preview = AnchorPreview()
    @State private var keyword = ""
    @State private var candidates: [AnchorCandidate] = []
    @State private var meta: AnchorRefMeta?
    /// 风控 / 空结果等说明文字
    @State private var note = ""
    @State private var searching = false
    /// 正在提交锚定的候选
    @State private var anchoringBvid = ""
    @State private var removing = false

    /// 卡片宽 / 最大高占屏幕比例（hw `width('92%')` + `maxHeight('80%')`）
    private static let cardRatio: CGFloat = 0.92
    private static let cardMaxRatio: CGFloat = 0.80
    /// 时长差异告警阈值（秒）：差得多 → 大概率不是同一录音（hw / web 同值 20 秒）
    private static let durationToleranceSec: Double = 20

    private var p: Palette { Palette(scheme) }

    init(anchorInfo: Binding<AnchorInfo?>, onClose: @escaping () -> Void) {
        self._anchorInfo = anchorInfo
        self.onClose = onClose
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                p.scrim
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture(perform: close)

                VStack(spacing: Dim.s3) {
                    header
                    if anchorInfo != nil { anchorRow }
                    searchRow
                    if !note.isEmpty { noteText }
                    if meta != nil { refCard }
                    candidateList
                }
                .padding(Dim.s3)
                // 宽 92% / 最高 80% 都按**父容器给的可用尺寸**算（父容器已在安全区内），
                // 候选列表自己滚，卡片本体不会顶到屏幕外。
                .frame(width: proxy.size.width * Self.cardRatio)
                .frame(maxHeight: proxy.size.height * Self.cardMaxRatio)
                .frameLog("anchor-card")
                .background(
                    RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous).fill(p.bg)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Dim.radiusLg, style: .continuous)
                        .stroke(p.line, lineWidth: Dim.hairline)
                )
                // 弹窗本体吸收点击，别漏到遮罩上把弹窗关掉
                .contentShape(Rectangle())
                .onTapGesture { }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: player.currentTrack?.id) { await open() }
        .onDisappear { preview.stop(resumeMain: true, main: player) }
    }

    // MARK: - 分块

    private var header: some View {
        HStack(spacing: Dim.s2) {
            Text("锚定音源")
                .font(.system(size: Dim.fsSub, weight: .medium))
                .foregroundStyle(p.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
            GlyphKey(.close, box: Dim.btnMd, color: p.text2, action: close)
                .accessibilityLabel("关闭")
        }
    }

    /// 已有锚点：回显 + 可解除（锚错了随时推翻重来）
    private var anchorRow: some View {
        HStack(spacing: Dim.s2) {
            Text(currentAnchorText)
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text1)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            WebButton(removing ? "解除中…" : "解除", variant: .plain, size: .sm,
                      disabled: removing) {
                Task { await removeAnchor() }
            }
            .accessibilityLabel("解除锚定")
        }
        .padding(.horizontal, Dim.s2)
        .padding(.vertical, Dim.s1)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous).fill(p.panel2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
    }

    private var searchRow: some View {
        HStack(spacing: Dim.s2) {
            NeuInput($keyword, placeholder: "歌名 歌手") {
                Task { await search() }
            }
            GlyphKey(.search, box: Dim.touchMin, color: searching ? p.accent : p.text2) {
                Task { await search() }
            }
            .accessibilityLabel("搜索 bilibili 候选")
        }
    }

    private var noteText: some View {
        Text(note)
            .font(.system(size: Dim.fsMinor))
            .foregroundStyle(p.text2)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
    }

    /// 原版参照：Q 音侧元数据（歌名 + 歌手·专辑·参考时长合并一行，帮用户认出正确的视频）
    private var refCard: some View {
        VStack(alignment: .leading, spacing: Dim.s0) {
            Text(meta?.name ?? "")
                .font(.system(size: Dim.fsSub, weight: .medium))
                .foregroundStyle(p.text1)
                .lineLimit(1)
                .truncationMode(.tail)
            Text(refMetaLine)
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Dim.s2)
        .padding(.vertical, Dim.s1)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous).fill(p.panel2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusSm, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
    }

    @ViewBuilder
    private var candidateList: some View {
        if searching && candidates.isEmpty {
            Text("正在搜索 bilibili 候选…")
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Dim.s4)
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(candidates) { candidate in
                        candidateRow(candidate)
                    }
                }
            }
            .scrollIndicators(.hidden)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// 候选行：标题 + UP·时长·置信 + 时长差异警告 + 锚定钮；点行即试听（再点停止）
    private func candidateRow(_ candidate: AnchorCandidate) -> some View {
        HStack(spacing: Dim.s2) {
            VStack(alignment: .leading, spacing: Dim.s0) {
                Text(candidate.title)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text1)
                    .lineLimit(2)
                    .truncationMode(.tail)
                Text(subLine(candidate))
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if durationMismatch(candidate) {
                    Text("时长\(durationDiffText(candidate))，可能不是同一版本")
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(p.accent)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            GlyphKey(.pin, box: Dim.touchMin,
                     color: anchoringBvid == candidate.bvid ? p.accent : p.text2) {
                guard anchoringBvid.isEmpty else { return }
                Task { await anchor(candidate) }
            }
            .accessibilityLabel("锚定该视频")
        }
        .padding(Dim.s2)
        .frame(maxWidth: .infinity)
        .background(preview.bvid == candidate.bvid ? p.panel2 : Color.clear)
        .overlay(alignment: .top) {
            Rectangle().fill(p.line).frame(height: Dim.hairline)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            Task { await preview.toggle(candidate, main: player) }
        }
        .accessibilityLabel(preview.bvid == candidate.bvid ? "停止试听" : "试听该候选")
    }

    // MARK: - 文案

    private var currentAnchorText: String {
        guard let anchor = anchorInfo else { return "" }
        let title = (anchor.title?.isEmpty == false) ? anchor.title! : anchor.bvid
        let author = anchor.author ?? ""
        return author.isEmpty ? "锚点 \(title)" : "锚点 \(title) · \(author)"
    }

    /// 原版参照副行（紧凑合并版）：歌手 · 专辑 · 参考时长
    private var refMetaLine: String {
        guard let meta else { return "" }
        let artists = meta.artists.joined(separator: " / ")
        let duration = Self.mmss(Int((meta.durationMs ?? 0)))
        var sub = artists
        if !meta.albumName.isEmpty {
            sub = sub.isEmpty ? meta.albumName : "\(sub) · \(meta.albumName)"
        }
        return sub.isEmpty ? "参考时长 \(duration)" : "\(sub) · \(duration)"
    }

    private func subLine(_ candidate: AnchorCandidate) -> String {
        let base = "\(candidate.author) · " + Self.mmss(Int(candidate.durationSec * 1000))
            + " · 置信 \(Int(candidate.score.rounded()))"
        return preview.bvid == candidate.bvid ? base + " · 试听中" : base
    }

    /// 候选时长与曲目差得多 → 大概率不是同一录音（阈值 20 秒，web 同口径）
    private func durationMismatch(_ candidate: AnchorCandidate) -> Bool {
        abs(candidate.durationDiff) > Self.durationToleranceSec
    }

    /// 服务端给的 durationDiff 是绝对值，不声称长/短方向
    private func durationDiffText(_ candidate: AnchorCandidate) -> String {
        "差 \(Int(abs(candidate.durationDiff).rounded())) 秒"
    }

    // MARK: - 动作

    private func close() {
        preview.stop(resumeMain: true, main: player)
        onClose()
    }

    /// 打开：关键词默认「歌名 + 主歌手」并自动搜一轮（web watch(track) 同口径）
    private func open() async {
        guard let track = player.currentTrack else { return }
        let firstArtist = track.ar.first?.name ?? ""
        keyword = "\(track.name) \(firstArtist)".trimmingCharacters(in: .whitespaces)
        candidates = []
        meta = nil
        note = ""
        anchoringBvid = ""
        preview.stop(resumeMain: true, main: player)
        anchorInfo = try? await APIClient.shared.trackAnchor(track.id)
        await search()
    }

    private func search() async {
        guard let id = player.currentTrack?.id, !id.isEmpty, !searching else { return }
        searching = true
        note = ""
        preview.stop(resumeMain: true, main: player)
        defer { searching = false }
        do {
            let reply = try await AnchorCandidateAPI.candidates(trackId: id, keyword: keyword)
            guard player.currentTrack?.id == id else { return }
            candidates = reply.candidates
            // Q 音侧的原版参照：歌名 / 歌手·专辑 / 时长，对着它挑 B 站视频
            meta = reply.track
            if reply.rejected == true {
                let reason = reply.message ?? ""
                note = reason.isEmpty ? "bilibili 搜索被风控拦截，请稍后重试" : reason
            } else if reply.candidates.isEmpty {
                note = "没有搜到候选视频，换个关键词试试"
            }
        } catch {
            note = (error as? ApiError)?.message ?? "搜索失败，请稍后重试"
        }
    }

    /// 锚定落地：入库 → 停试听 → 清旧音源缓存 → 重装当前曲走新锚点 → toast
    private func anchor(_ candidate: AnchorCandidate) async {
        guard let track = player.currentTrack, anchoringBvid.isEmpty else { return }
        anchoringBvid = candidate.bvid
        defer { anchoringBvid = "" }
        do {
            _ = try await APIClient.shared.setAnchor(track.id, bvid: candidate.bvid)
        } catch {
            ToastCenter.shared.show((error as? ApiError)?.message ?? "锚定失败，请稍后重试")
            return
        }
        // 重装后统一起播：这里不恢复被试听暂停的主播放，否则会闪一下旧音源
        preview.stop(resumeMain: false, main: player)
        anchorInfo = nil
        close()
        ToastCenter.shared.show("已锚定，开始播放")
        // 旧音源字节按曲目 id 缓存（含离线缓存）：不清会直接盖住新锚点
        await player.reloadCurrentTrack(autoplay: true)
        anchorInfo = try? await APIClient.shared.trackAnchor(track.id)
    }

    /// 解除锚定：该曲目回到自动匹配
    private func removeAnchor() async {
        guard let id = player.currentTrack?.id, !id.isEmpty, !removing else { return }
        removing = true
        defer { removing = false }
        do {
            try await APIClient.shared.removeAnchor(id)
            anchorInfo = nil
            ToastCenter.shared.show("已解除锚定，该曲目回到自动匹配")
        } catch {
            ToastCenter.shared.show((error as? ApiError)?.message ?? "解除失败，请稍后重试")
        }
    }

    private static func mmss(_ ms: Int) -> String {
        let total = max(0, ms) / 1000
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
