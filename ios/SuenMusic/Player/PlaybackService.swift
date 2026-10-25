/**
 * 把播放内核接进 SwiftUI。
 *
 * 职责边界（原生化最重要的一条纪律）：
 *   · **播放状态机的 owner 是 AudioEngine**，本类只做三件事：
 *     ① 把用户意图翻译成引擎调用；② 把引擎事件翻译成 `@Published`；③ 解析/令牌/地址拼接。
 *   · 绝不在本类里保存第二份"队列/下标"的真相 —— `queue` 只是为了 UI 渲染而镜像的副本。
 */

import Foundation
import SwiftUI

@MainActor
final class PlaybackService: ObservableObject, AudioEngineEvents {

    static let shared = PlaybackService()

    @Published private(set) var queue: [Track] = []
    @Published private(set) var currentIndex: Int = -1
    @Published private(set) var playing: Bool = false
    @Published private(set) var positionMs: Int = 0
    @Published private(set) var durationMs: Int = 0
    @Published private(set) var loading: Bool = false
    /// 仅用于"引擎都起不来"这类**无法归入播放失败语义**的硬错误（不再用于逐曲失败）
    @Published var errorMessage: String?
    /// 音源角标：bilibili / netease
    @Published private(set) var source: String = "bilibili"
    /// 队列来源（eyebrow「正在播放 · 来源」用，setQueue 装载方写入）
    @Published private(set) var origin: String = ""
    /// 手动点播到无音源曲目：eyebrow 显示「无音源」，**不跳不弹任何按钮**（用户 2026-10-23 定的规格）
    @Published private(set) var noSource: Bool = false

    private var engine: AudioEngine?
    private var sessionToken: String?
    private var tokenExpiresAt: Date = .distantPast

    // MARK: 失败语义（与 hw `MediaPlayerCore` 逐条对齐）

    /// 失败先挂起 2.5s：AVPlayer 对 5xx 会自行重试，瞬时失败不该惊动用户
    private static let failGraceMs = 2500
    /// 装载看门狗：6s 内没进 playing 就当失败
    private static let stallMs = 6000
    /// 连续失败达到此数 → 暂停 + 通知，不再逐首跳
    private static let maxFailStreak = 2
    /// 连播静默跳过的延迟（服务端瞬时抖动时不至于把整条队列连跳掉）
    private static let skipDelayMs = 600
    /// 无音源文案（hw `NO_SOURCE_LABEL`）
    static let noSourceLabel = "无音源"

    /// true = 这次装载由**用户手动点播**触发（失败要停下并标无音源），false = 连播自动切
    private var manualLoad = false
    private var failStreak = 0
    private var graceTask: Task<Void, Never>?
    private var loadWatchdog: Task<Void, Never>?

    var currentTrack: Track? {
        guard queue.indices.contains(currentIndex) else { return nil }
        return queue[currentIndex]
    }

    private init() {}

    private func ensureEngine() -> AudioEngine? {
        if let engine { return engine }
        do {
            let created = try AudioEngine(events: self)
            engine = created
            return created
        } catch {
            errorMessage = "音频初始化失败：\(error.localizedDescription)"
            return nil
        }
    }

    // MARK: 令牌

    /// 流会话令牌：6 小时有效，提前 5 分钟续。拿不到就退回"无令牌"（服务端会 401，由引擎自愈）
    private func validToken(force: Bool = false) async -> String {
        if !force, let t = sessionToken, Date() < tokenExpiresAt { return t }
        struct Reply: Decodable { let token: String; let expiresInMs: Double }
        do {
            let r: Reply = try await APIClient.shared.get("/api/stream/session-token")
            sessionToken = r.token
            tokenExpiresAt = Date().addingTimeInterval(r.expiresInMs / 1000 - 300)
            return r.token
        } catch {
            return sessionToken ?? ""
        }
    }

    // MARK: 预热（降低起播延迟）

    /// 应用启动/回前台时调一次：把引擎（AVAudioSession + 观察者）建好，并预取流会话令牌。
    /// 这样用户点歌时省掉「引擎初始化 + 一次 token 往返」（模拟器实测 token 往返 ~120ms，真机更久）。
    func prewarm() {
        guard ensureEngine() != nil else { return }
        Task { _ = await validToken() }
    }

    // MARK: 列表预热（降低首播解析延迟）

    /// 把列表前几首的音源**在后台解析好**，用户点的时候直接命中服务端缓存。
    ///
    /// 为什么需要：服务端 `play_sources` 只缓存解析结果，而曲库 3749 首里只有几十条是热的     
    /// 冷曲目每次首播都要现场去 B 站搜索+打分匹配（实测 2-8s），这就是「大多数歌起播 5-10 秒」的根。
    /// 串行 + 上限，避免把上游打崩。
    func warm(_ tracks: [Track], limit: Int = 8) {
        let head = Array(tracks.prefix(limit))
        guard !head.isEmpty else { return }
        Task.detached(priority: .utility) {
            for track in head {
                _ = try? await APIClient.shared.resolve(trackId: track.id)
            }
        }
    }

    // MARK: 用户意图

    func play(tracks: [Track], startingAt index: Int, origin: String = "") async {
        guard !tracks.isEmpty, tracks.indices.contains(index) else { return }
        guard let engine = ensureEngine() else { return }
        loading = true
        errorMessage = nil
        noSource = false
        failStreak = 0
        // 手动点播：失败要停在当前曲并标「无音源」，不自动跳（hw `manualLoad = true`）
        manualLoad = true
        self.origin = origin
        queue = tracks
        currentIndex = index
        armLoadWatchdog()

        NSLog("[Start] play() 进入 id=\(tracks[index].id) origin=\(origin)")
        let token = await validToken()
        NSLog("[Start] 令牌就绪（\(Int(Date().timeIntervalSince1970))）")
        let mapped = tracks.map(Self.toNative)
        do {
            try engine.setQueue(
                baseUrl: APIClient.shared.baseURL,
                token: token,
                tracks: mapped,
                startIndex: index,
                startPositionMs: 0,
                autoplay: true,
                tailOnly: false
            )
        } catch {
            loading = false
            errorMessage = "无法装载音源：\(error.localizedDescription)"
        }
    }

    func toggle() {
        guard let engine, engine.currentIndex >= 0 else { return }
        if playing { engine.pause() } else { engine.play() }
    }

    /// 手动切歌：失败同样停在目标曲并标「无音源」
    func next() {
        manualLoad = true
        armLoadWatchdog()
        _ = engine?.skipToNext()
    }

    func prev() {
        manualLoad = true
        armLoadWatchdog()
        _ = engine?.skipToPrevious()
    }
    func seek(to ms: Int) { engine?.seek(to: max(0, ms)) }

    func setRepeat(_ mode: String) { engine?.setRepeatMode(mode) }

    /// 切服/改地址后：把队列重发到新地址（原生队列里存的是绝对 URL，换 base 即全失效）
    func rebind(baseUrl: String) {
        guard let engine, !queue.isEmpty, currentIndex >= 0 else { return }
        Task {
            let token = await validToken(force: true)
            try? engine.setQueue(
                baseUrl: APIClient.shared.baseURL,
                token: token,
                tracks: queue.map(Self.toNative),
                startIndex: currentIndex,
                startPositionMs: positionMs,
                autoplay: playing,
                tailOnly: false
            )
        }
    }

    static func toNative(_ t: Track) -> SuenTrack {
        SuenTrack(id: t.id, title: t.name, artist: t.artistLine,
                  album: t.al.name, coverUrl: t.al.picUrl, durationMs: t.dt)
    }

    // MARK: AudioEngineEvents（引擎在主线程回调，这里可直接改 @Published）

    nonisolated func emitTrackChange(index: Int, id: String, reason: Int) {
        Task { @MainActor in
            // reason 1 = 播完自动切下一首（hw：advance 走 manualLoad=false）
            if reason == 1 { self.manualLoad = false }
            self.currentIndex = index
            self.noSource = false
            // 换歌是元数据变更 → 立刻推 Live Activity（不受 1s 地板限制）
            self.pushActivity(force: true)
            // 时长先落元数据值，等流的精确值（X-Audio-Duration-Ms）回来再覆盖
            if self.queue.indices.contains(index) { self.durationMs = self.queue[index].dt }
        }
    }

    nonisolated func emitState(playing: Bool) {
        Task { @MainActor in
            self.playing = playing
            if playing {
                self.loading = false
                self.markLoaded()
            }
            self.pushActivity(force: false)
        }
    }

    nonisolated func emitProgress(index: Int, positionMs: Int, durationMs: Int, playing: Bool) {
        Task { @MainActor in
            if self.currentIndex != index { self.currentIndex = index }
            self.positionMs = positionMs
            if durationMs > 0 { self.durationMs = durationMs }
            let wasPlaying = self.playing
            self.playing = playing
            self.loading = false
            if playing {
                if !wasPlaying { NSLog("[Start] 首次 playing id=\(self.currentTrack?.id ?? "-")") }
                self.markLoaded()
            }
        }
    }

    nonisolated func emitError(message: String) {
        Task { @MainActor in
            self.loading = false
            self.scheduleFailureSettle(message: message)
        }
    }

    // MARK: - 失败落定（hw `MediaPlayerCore.settleFailure` 逐条对齐）

    /// 进入 playing：清掉宽限/看门狗、连续失败计数、无音源标记
    private func markLoaded() {
        failStreak = 0
        noSource = false
        graceTask?.cancel()
        graceTask = nil
        loadWatchdog?.cancel()
        loadWatchdog = nil
    }

    /// 装载看门狗：6s 内没进 playing 按失败处理
    private func armLoadWatchdog() {
        loadWatchdog?.cancel()
        loadWatchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.stallMs) * 1_000_000)
            guard let self, !Task.isCancelled else { return }
            await MainActor.run {
                guard !self.playing else { return }
                self.scheduleFailureSettle(message: "装载超时")
            }
        }
    }

    /// 失败先挂起 2.5s：期间若已经播起来（AVPlayer 对 5xx 会自愈）就完全忽略
    private func scheduleFailureSettle(message: String) {
        graceTask?.cancel()
        graceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.failGraceMs) * 1_000_000)
            guard let self, !Task.isCancelled else { return }
            await MainActor.run {
                guard !self.playing else { return }   // 宽限窗口内自愈 → 不惊动用户
                self.settleFailure(message: message)
            }
        }
    }

    private func settleFailure(message: String) {
        graceTask?.cancel()
        graceTask = nil
        loadWatchdog?.cancel()
        loadWatchdog = nil
        // 必须把"已暂停"推给系统：否则锁屏/控制中心会按上次 playing 自行外推进度
        engine?.pause()
        playing = false
        loading = false
        failStreak += 1

        let title = currentTrack?.name ?? ""
        let hasWayOut = currentIndex + 1 < queue.count

        // ① 连续失败：暂停 + 通知，不再逐首跳
        if failStreak >= Self.maxFailStreak {
            errorMessage = nil
            noSource = false
            Notifier.notify(title: "连续多首没有匹配音源", body: "已暂停播放，请检查网络或稍后再试")
            return
        }

        // ② 连播（非手动）且还有下一首：**页面不留任何报错**，只发通知 + 600ms 后跳过
        if !manualLoad && hasWayOut {
            errorMessage = nil
            noSource = false
            Notifier.notify(title: "没有匹配音源", body: "《\(title)》没有可播放的匹配音源，已自动跳过")
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.skipDelayMs) * 1_000_000)
                guard let self, !Task.isCancelled else { return }
                await MainActor.run {
                    self.manualLoad = false
                    self.next()
                    self.manualLoad = false
                }
            }
            return
        }

        // ③ 手动点播（或连播已无路可走）：停住，只在 eyebrow 显示「无音源」
        errorMessage = nil
        noSource = true
    }

    /// 推一次 Live Activity / 灵动岛状态。
    /// force = true 时用于换歌/播放暂停等必须即时的变更；进度类走控制器内部 1s 地板（与 hw 卡片同值）。
    private func pushActivity(force: Bool) {
        let track = currentTrack
        let coverUrl = track?.al.picUrl ?? ""
        // 封面小图：命中内存缓存就拿，没有则异步下（下完回调里再 force 推一次）
        let cached = LiveActivityController.shared.coverJPEG(for: coverUrl) { [weak self] _ in
            self?.pushActivity(force: true)
        }
        let state = PlaybackActivityAttributes.ContentState(
            title: track?.name ?? "",
            artist: track?.artistLine ?? "",
            album: track?.al.name ?? "",
            coverUrl: coverUrl,
            positionMs: positionMs,
            durationMs: durationMs,
            playing: playing,
            sourceLabel: sourceLabel,
            coverJPEG: cached
        )
        LiveActivityController.shared.sync(state: state, force: force)
    }

    /// 顶栏 eyebrow（hw eyebrowText 同口径）：无音源/错误 > 「正在播放/已停止 · 来源」
    var eyebrowText: String {
        if noSource { return Self.noSourceLabel }
        if let err = errorMessage, !err.isEmpty { return err }
        let status = playing ? "正在播放" : "已停止"
        return origin.isEmpty ? status : "\(status) · \(origin)"
    }

    /// 音源文案（hw `sourceLabel` 同口径：bilibili / 网易云 / 未匹配）
    var sourceLabel: String {
        switch source {
        case "bilibili": return "bilibili"
        case "netease": return "网易云"
        default: return "未匹配"
        }
    }
}
