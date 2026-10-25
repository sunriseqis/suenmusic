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
    // MARK: 歌词（供 Live Activity 与播放页共用）

    /// 当前曲目的歌词行（按时间戳升序）
    private var lyricLines: [LyricLine] = []
    /// 上一次推进 Live Activity 的歌词行（换行才推，省 ActivityKit 预算）
    private var lastPushedLyric: String = ""
    /// 正在加载/已加载歌词的曲目 id（保证「当前曲一定已经发起过歌词请求」）
    private var lyricTrackId: String = ""

    /// 当前位置应该显示的歌词（没有歌词返回空串）
    var currentLyricLine: String {
        LyricParser.line(atMs: positionMs, in: lyricLines)
    }

    /// 拉取当前曲目的歌词（失败静默 —— 没有歌词不影响播放）
    ///
    /// 走 `LyricStore`：播放页歌词面板与 peek 预热的是同一份缓存，
    /// 一首歌不该因为"卡片要一行、页面要整篇"而拉两遍。
    func loadLyrics(for trackId: String) {
        NSLog("[Lyric] 请求歌词 %@", trackId)
        lyricTrackId = trackId
        lyricLines = []
        lastPushedLyric = ""
        Task { [weak self] in
            guard let doc = await LyricStore.shared.doc(for: trackId) else {
                NSLog("[Lyric] 拉取失败 %@", trackId)
                return
            }
            let lines = doc.lines.enumerated().map { index, line in
                LyricLine(atMs: line.atMs, text: line.text,
                          translation: index < doc.trans.count ? doc.trans[index] : "")
            }
            await MainActor.run {
                guard let self, self.currentTrack?.id == trackId else { return }
                self.lyricLines = lines
                NSLog("[Lyric] %@ 行数=%d 首行=%@", trackId, lines.count, lines.first?.text ?? "-")
                self.pushActivity(force: true)   // 歌词就绪后立刻推一次当前行
            }
        }
    }

    /// 保证当前曲的歌词已经在拉（每首只发起一次）。
    ///
    /// 为什么需要：`loadLyrics` 原来只由 `emitTrackChange` 触发，而引擎的 `setQueue` 是**内联整队装载**、
    /// 不发 trackChange（实测：起播后日志里一条 `[Lyric]` 都没有）——
    /// 于是「本次会话第一首」永远没有歌词行，而 `emitProgress` 又只在换行时推，
    /// 连带进度条整首不动。这里做成自愈：任何一次推状态前都核对一遍当前曲。
    private func ensureLyrics() {
        guard let id = currentTrack?.id, !id.isEmpty, id != lyricTrackId else { return }
        loadLyrics(for: id)
    }

    /// 当前歌词行距自己时间轴的滞后（毫秒）：换行推得够不够快，靠这个数自证
    private func lyricLagMs() -> Int {
        guard !lyricLines.isEmpty else { return 0 }
        var start = 0
        for line in lyricLines where line.atMs <= positionMs { start = line.atMs }
        return max(0, positionMs - start)
    }

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
        LiveActivityController.shared.endAllStale()
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
        ensureLyrics()   // 起播即拉歌词（引擎整队装载不发 trackChange，见 ensureLyrics 注释）
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
        if playing { pause() } else { play() }
    }

    /// 明确暂停（播放页试听候选前要停主播放，否则两条音轨叠着放）
    func pause() {
        engine?.pause()
    }

    /// 明确起播（试听结束/失败后把主播放接回来）
    func play() {
        guard let engine, engine.currentIndex >= 0 else { return }
        engine.play()
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

    // MARK: 队列操作（hw `MediaPlayerCore` 同语义：UI 只发意图，内核是数据源）

    /// 队列快照（播放页队列抽屉的数据源）
    var queueSnapshot: [Track] { queue }

    /// 跳到指定下标并起播（hw `jumpTo(i, true)`）
    func jumpTo(_ index: Int) {
        guard queue.indices.contains(index), let engine else { return }
        // 用户点了某一行 = 显式点播：失败停在当前曲、不自动跳（hw `manualLoad = true`）
        manualLoad = true
        armLoadWatchdog()
        engine.jumpTo(index, autoplay: true)
    }

    /// 从队列摘除一项（hw `removeAt` 三种情形）：当前曲之前的只挪下标、摘当前曲原地装
    /// 下一首、摘空则停止并清元数据。
    func removeAt(_ index: Int) async {
        guard queue.indices.contains(index) else { return }
        let wasPlaying = playing
        let removedCurrent = engine?.removeQueueItem(at: index) ?? false
        queue.remove(at: index)

        if queue.isEmpty {
            currentIndex = -1
            positionMs = 0
            durationMs = 0
            playing = false
            noSource = false
            currentRecoReason = nil
            engine?.stop()
            return
        }
        if removedCurrent {
            let next = min(index, queue.count - 1)
            currentIndex = next
            engine?.seekToIndex(next, autoplay: wasPlaying, force: true)
        } else if index < currentIndex {
            currentIndex -= 1
        }
    }

    /// 队列内移动一项（hw `moveItem`，拖拽排序）
    func moveItem(from: Int, to: Int) {
        guard queue.indices.contains(from), queue.indices.contains(to), from != to else { return }
        engine?.moveQueueItem(from: from, to: to)
        let moved = queue.remove(at: from)
        queue.insert(moved, at: to)
        if from == currentIndex {
            currentIndex = to
        } else if from < currentIndex && to >= currentIndex {
            currentIndex -= 1
        } else if from > currentIndex && to <= currentIndex {
            currentIndex += 1
        }
    }

    /// 强制重装当前曲（修正音源锚定后走新锚点）：清该曲离线缓存 → 丢缓冲重装 → 起播。
    /// hw `retryCurrent(true)` 同口径：锚定后服务端已清解析缓存，重装即走新音源。
    func reloadCurrentTrack(autoplay: Bool) async {
        guard let engine, queue.indices.contains(currentIndex) else { return }
        AudioCacheStore.shared.evict(id: queue[currentIndex].id)
        manualLoad = true
        armLoadWatchdog()
        engine.reloadCurrent(index: currentIndex, positionMs: 0, autoplay: autoplay)
    }

    // MARK: 收藏（播放页红心，hw `toggleFav` 同口径）

    private struct FavIdsBody: Encodable { let ids: [String] }
    private struct FavCheckReply: Decodable { let favorites: [String: Bool] }
    private struct FavAddBody: Encodable { let trackId: String; let track: Track? }
    private struct FavAddReply: Decodable { let ok: Bool?; let added: Bool? }

    /// 这批 id 里已收藏的（hw `favoredIds`：服务端单次上限 500）
    func favoredIds(_ ids: [String]) async -> [String] {
        guard !ids.isEmpty else { return [] }
        do {
            let r: FavCheckReply = try await APIClient.shared.post(
                "/api/favorites/check", body: FavIdsBody(ids: ids))
            return r.favorites.filter { $0.value }.map(\.key)
        } catch {
            // 静默：拉不到收藏标记只是红心不准，不该打断播放页
            return []
        }
    }

    /// 这首是否已收藏
    func isFavored(_ trackId: String) async -> Bool {
        guard !trackId.isEmpty else { return false }
        return await favoredIds([trackId]).contains(trackId)
    }

    /// 切换收藏态。返回新状态；nil = 失败（调用方回滚并 toast）
    func toggleFavorite(_ track: Track) async -> Bool? {
        let was = await isFavored(track.id)
        do {
            if was {
                try await APIClient.shared.removeFavorite(trackId: track.id)
            } else {
                let _: FavAddReply = try await APIClient.shared.post(
                    "/api/favorites", body: FavAddBody(trackId: track.id, track: track))
            }
            return !was
        } catch {
            NSLog("[Fav] 切换失败 %@: %@", track.id, error.localizedDescription)
            return nil
        }
    }

    // MARK: 播放模式（内核只有 off/one/all；hw 的 shuffle 两态 iOS 内核未实现）

    /// off = 顺序播放 / all = 列表循环 / one = 单曲循环
    @Published private(set) var playMode: String = "off"

    /// 循环切下一档（hw `cycleMode` 的 iOS 子集），返回切换后的模式
    @discardableResult
    func cycleMode() -> String {
        switch playMode {
        case "off": playMode = "all"
        case "all": playMode = "one"
        default: playMode = "off"
        }
        engine?.setRepeatMode(playMode)
        return playMode
    }

    /// 模式文案（hw `Copy.modeOrder` 等同意）
    var playModeLabel: String {
        switch playMode {
        case "all": return "列表循环"
        case "one": return "单曲循环"
        default: return "顺序播放"
        }
    }

    // MARK: 专属推荐理由（hw `Track.recommendReason`）

    /// 当前曲的专属推荐理由；nil = 不是每日推荐里的曲目（播放页不显示推荐卡）
    @Published private(set) var currentRecoReason: String?

    /// 「不喜欢」成功后请求每日推荐页重拉（hw `bumpDailyRefresh` 的等价通道）。
    /// 注：DailyView 本次不在改动范围、尚未监听，先保证发出方存在。
    static let dailyRefreshNeeded = Notification.Name("suenmusic.dailyRefreshNeeded")

    /// 曲目 id → 推荐理由。iOS 的 `Track` 模型还没声明 `recommendReason`（Net/ 不在本次
    /// 改动范围），这里按 `/api/recommend/daily` 的原始响应旁路取一份（失败静默）。
    private var recoReasons: [String: String] = [:]
    private var recoLoading = false
    private var recoLoadedAt: Date = .distantPast
    private static let recoReloadS: TimeInterval = 6 * 3600

    private struct RecoRow: Decodable { let id: String; let recommendReason: String? }
    private struct RecoReply: Decodable { let tracks: [RecoRow] }

    /// 清洗 AI 输出（hw `Copy.cleanAiText` 同口径：去 Markdown 残留 / 引号 / 前导杂标点，规范空白）
    private static func cleanAiText(_ raw: String) -> String {
        var s = raw
        for (pattern, replacement) in [
            ("```[\\s\\S]*?```", " "),
            ("`([^`]+)`", "$1"),
            ("(?:^|\\n)\\s*#+\\s*", " "),
            ("#+", ""),
            ("\\*\\*([^*]+)\\*\\*", "$1"),
            ("\\*([^*]+)\\*", "$1"),
            ("__([^_]+)__", "$1"),
            ("_([^_]+)_", "$1"),
            ("~~([^~]+)~~", "$1"),
            ("(?:^|\\n)\\s*>\\s*", " "),
            ("(?:^|\\n)\\s*[-*+]\\s+", " "),
            ("[\"“”'‘’]", ""),
            ("\\s+", " "),
        ] {
            s = s.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: "^[，,：:;；、\\-—\\s]+", with: "", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespaces)
    }

    /// 每日推荐的理由表按需拉一次（换歌时调；6 小时内不重复打服务端）
    private func ensureRecoReasons() {
        guard !recoLoading, Date().timeIntervalSince(recoLoadedAt) > Self.recoReloadS else { return }
        recoLoading = true
        Task { [weak self] in
            let reply: RecoReply? = try? await APIClient.shared.get("/api/recommend/daily")
            await MainActor.run {
                guard let self else { return }
                self.recoLoading = false
                self.recoLoadedAt = Date()
                var map: [String: String] = [:]
                for row in reply?.tracks ?? [] {
                    let text = Self.cleanAiText(row.recommendReason ?? "")
                    if !text.isEmpty { map[row.id] = text }
                }
                self.recoReasons = map
                self.currentRecoReason = self.currentTrack.flatMap { map[$0.id] }
            }
        }
    }

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
            self.ensureRecoReasons()
            self.currentRecoReason = self.recoReasons[id]
            self.lyricTrackId = id
            self.loadLyrics(for: id)   // 换歌即拉歌词（Live Activity 的歌词行靠它）
            self.noSource = false
            // 进度先归零：否则新歌的卡会带着上一首的位置（emitProgress 下一 tick 才纠正）
            self.positionMs = 0
            // 时长先落元数据值，等流的精确值（X-Audio-Duration-Ms）回来再覆盖
            if self.queue.indices.contains(index) { self.durationMs = self.queue[index].dt }
            // 换歌是元数据变更 → 立刻推 Live Activity（不受 1s 地板限制）
            self.pushActivity(force: true)
        }
    }

    nonisolated func emitState(playing: Bool) {
        Task { @MainActor in
            self.playing = playing
            if playing {
                self.loading = false
                self.markLoaded()
            }
            // 播放/暂停是用户看得见的即时反馈，不走地板（一次推送内就得到）
            self.pushActivity(force: true)
        }
    }

    nonisolated func emitProgress(index: Int, positionMs: Int, durationMs: Int, playing: Bool) {
        Task { @MainActor in
            // 进度回调只在引擎给的下标**在当前队列之内**时才采纳：
            // 引擎在 item 未就绪时曾兜底 0，会把页面切到 queue[0]（曲名/封面与音频不符）。
            if index >= 0, index < self.queue.count, self.currentIndex != index {
                self.currentIndex = index
            }
            self.positionMs = positionMs
            if durationMs > 0 { self.durationMs = durationMs }
            let wasPlaying = self.playing
            self.playing = playing
            self.loading = false
            if playing {
                if !wasPlaying { NSLog("[Start] 首次 playing id=\(self.currentTrack?.id ?? "-")") }
                self.markLoaded()
            }
            // 进度类：每 tick 都交给控制器，由它按 1s 地板节流。
            // 旧实现只在「歌词换行」时推 → 没有歌词的歌，进度条整首不动。
            // 歌词换行则 force（不等地板），目标是「换行后 ≤1s 岛上就变」，滞后量见 [Lyric] 日志的「滞后=」。
            let line = self.currentLyricLine
            let lyricChanged = line != self.lastPushedLyric
            if lyricChanged {
                self.lastPushedLyric = line
                if !line.isEmpty {
                    NSLog("[Lyric] 当前行=%@ 滞后=%dms pos=%d", line.replacingOccurrences(of: "\n", with: " / "),
                          self.lyricLagMs(), self.positionMs)
                }
            }
            self.pushActivity(force: lyricChanged)
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
            NSLog("[Fail] 连续失败 %d 首 → 暂停 + 通知", failStreak)
            Notifier.notify(title: "连续多首没有匹配音源", body: "已暂停播放，请检查网络或稍后再试")
            return
        }

        // ② 连播（非手动）且还有下一首：**页面不留任何报错**，只发通知 + 600ms 后跳过
        if !manualLoad && hasWayOut {
            errorMessage = nil
            noSource = false
            NSLog("[Fail] 连播无音源 → 600ms 后跳过《%@》", title)
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
        NSLog("[Fail] 手动点播无音源 → 停在当前曲，eyebrow 显示「无音源」（不跳、不弹按钮）")
    }

    /// 推一次 Live Activity / 灵动岛状态。
    /// force = true 时用于换歌/播放暂停等必须即时的变更；进度类走控制器内部 1s 地板（与 hw 卡片同值）。
    private func pushActivity(force: Bool) {
        ensureLyrics()   // 自愈：任何一次推状态前核对「当前曲的歌词是否已经在拉」
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
            coverJPEG: cached,
            lyricLine: currentLyricLine
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
