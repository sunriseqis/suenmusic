/**
 * 播放内核（P1：内核从 AVPlayer 换成 libmpv）。
 *
 * 分工：
 *   · 出声 / 定位 / 时长 / 时间推进 → MpvPlayer（libmpv，见 MpvPlayer.swift）；
 *   · 队列、播放顺序、随机/重复、缓存预约、Now Playing、锁屏远程命令、
 *     音频会话（打断 / 路由 / 媒体服务重置）→ 仍在本类，语义与 AVPlayer 时代一致；
 *   · **对外接口（含 PlaybackService 依赖的全部方法）一个字都没改。**
 *
 * AVQueuePlayer 时代的「多条目队列 + 原生接续」在 mpv 下不存在：核心同时只播一个文件，
 * 接续改由 END_FILE 事件驱动（见 handleFileEnd），逻辑队列 tracks / playOrder 仍是唯一事实源。
 *
 * 线程模型：mpv 的回调由 MpvPlayer 切回主线程后再发，本类大部分方法可以直接改状态；
 * 仍保留 EngineThread 供系统通知（打断 / 路由变化 / 媒体服务重置）切主线程用。
 */

import Foundation
import AVFoundation
import MediaPlayer
import Network
// CryptoKit 提供 Insecure.SHA1（封面文件名摘要用）
import CryptoKit

/// 播放内核向 UI 上报的事件（与 AVPlayer 时代完全一致，PlaybackService 不用改）。
protocol AudioEngineEvents: AnyObject {
    func emitProgress(index: Int, positionMs: Int, durationMs: Int, playing: Bool)
    func emitTrackChange(index: Int, id: String, reason: Int)
    func emitState(playing: Bool)
    func emitError(message: String)
}

/// 线程助手：系统通知（打断 / 路由）由系统从内部队列投递，线程不确定。
enum EngineThread {
    static func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) }
    }

    /// 延迟在主线程执行
    static func after(_ seconds: Double, _ body: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: body)
    }
}


struct SuenTrack {
    let id: String
    let title: String
    let artist: String
    let album: String?
    let coverUrl: String?
    let durationMs: Int
}

final class AudioEngine: NSObject {

    /// 播放模式：字符串与 hw MediaPlayerCore.PLAY_MODES 完全一致
    enum RepeatMode: String {
        case order
        case shuffle
        case repeatOne = "repeat-one"
        case listLoop = "list-loop"
        case shuffleOnce = "shuffle-once"

        var isShuffle: Bool { self == .shuffle || self == .shuffleOnce }
    }

    private weak var events: AudioEngineEvents?

    /// libmpv 封装。**整个引擎只有一个实例**：AVQueuePlayer 的多条目队列已删除，
    /// 换歌 = 对同一个核心 loadfile replace（见 loadCurrent）。
    private var mpv: MpvPlayer?

    struct DirectMediaLink {
        let url: String
        let headers: [String: String]?
        let expiresAt: Date
    }
    private var directLinks: [String: DirectMediaLink] = [:]

    /// 起播后 **25 秒**才发起整首缓存下载（规格 2.1）；延时期间切歌 / 暂停 / 停止即作废（3.1 / 3.3）。
    private static let cacheDelaySeconds: UInt64 = 25
    private var cacheDelayTask: Task<Void, Never>?
    private var cacheDownloadTask: Task<Void, Never>?

    func setDirect(trackId: String, url: String?, headers: [String: String]?, expiresInSec: Int = 3600) {
        if let url, !url.isEmpty {
            directLinks[trackId] = DirectMediaLink(
                url: url,
                headers: headers,
                expiresAt: Date().addingTimeInterval(Double(max(60, expiresInSec)))
            )
            // 直链几乎总是晚于起播到达：当前曲已经在播就补一次缓存预约（25s 到点才真正开下，规格 2.1）
            cacheIfPlaying(trackId: trackId)
        } else {
            directLinks.removeValue(forKey: trackId)
        }
    }

    /// 回收不再可能被用到的直链（N-4）：只保留「还在队列里」且「未过期」的条目。
    ///
    /// ⚠️ 必须等 tracks 已经是**新队列**之后再调：PlaybackService.play() 的顺序是
    /// 先对目标曲 setDirect()、再 setQueue() —— 过早清空会把刚解析好的直链一起扔掉。
    private func pruneDirectLinks() {
        guard !directLinks.isEmpty else { return }
        let live = Set(tracks.map(\.id))
        let now = Date()
        let before = directLinks.count
        directLinks = directLinks.filter { live.contains($0.key) && $0.value.expiresAt > now }
        if directLinks.count != before {
            NSLog("%@", "[DirectCDN] 回收直链 \(before - directLinks.count) 条 → 余 \(directLinks.count)")
        }
    }

    /// state 去重：只在有效播放状态**变化**时上报，避免缓冲抖动把 UI 刷成闪烁。
    private var lastReportedPlaying: Bool?

    private(set) var tracks: [SuenTrack] = []
    private var repeatMode: RepeatMode = .order
    /// 逻辑播放顺序（元素 = tracks 的下标）。非随机模式就是 0..<count；
    /// 随机模式是「当前曲打头 + 其余洗牌」，切回顺序模式时还原，保证列表显示顺序不被破坏。
    private var playOrder: [Int] = []

    private var baseUrl = ""
    private var sessionToken = ""
    /// 直连取流时的 UA：部分 CDN（B 站）对空 UA 直接拒
    private static let streamUserAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
        + "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    private var isActivated = false

    private let nowPlaying = MPNowPlayingInfoCenter.default()
    private var remoteCommandsInstalled = false
    /// addTarget 的返回 token。持有它既是为了将来能干净卸载，
    /// 也是因为"注册了但没拿到句柄"和"没注册"在现象上无法区分。
    private var remoteCommandTargets: [Any] = []
    private var artworkCache: [String: MPMediaItemArtwork] = [:]
    private var lastNowPlayingUpdate = Date.distantPast

    /// 播放**意图** —— 锁屏 / 控制中心 / 灵动岛的按钮与进度条只看这一个值。
    ///
    /// 绝不能用 mpv 的 pause 属性代替：mpv 缓冲时会自己进 paused-for-cache，
    /// 拿瞬时状态判定会把"正在缓冲"错报成"已暂停"，锁屏按钮随即来回跳。
    private var playingIntent = false

    /// Now Playing 自检日志开关（真机验收通过后可以关掉）
    private var nowPlayingDebugLog = true

    /// 最后一次已知的逻辑下标（当前曲）
    private var logicalIndex = 0

    /// 连续失败计数（达到上限时通知上层暂停，不自动跳歌）
    private var consecutiveErrors = 0
    private static let maxConsecutiveErrors = 5

    /// 诊断打点节流
    private var lastDiagAt = Date.distantPast

    init(events: AudioEngineEvents) throws {
        self.events = events
        super.init()

        // ① 音频会话**必须先激活**，再 mpv_initialize：
        //    libmpv 的 audiounit 输出在初始化时就去找音频设备，会话没激活会退化成空输出。
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true)
        isActivated = true

        // ② libmpv 核心（创建 → 选项 → initialize 全在 MpvPlayer.init 里）
        let player = try MpvPlayer()
        mpv = player
        player.onTime = { [weak self] seconds in self?.handleTime(seconds) }
        player.onDuration = { [weak self] seconds in self?.handleDuration(seconds) }
        player.onState = { [weak self] state in self?.handleMpvState(state) }
        player.onEnded = { [weak self] in self?.handleFileEnd() }
        player.onError = { [weak self] message in self?.handleMpvError(message) }
        player.onFileLoaded = { [weak self] in
            guard let self = self else { return }
            NSLog("[Start] mpv 已装载 idx=%d dur=%dms", self.currentIndex, self.currentItemDurationMs())
        }

        NotificationCenter.default.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification, object: nil)
        /**
         * 音频服务被系统重启（系统回收音频守护进程、或 设置 → 开发者 → Reset Media Services）。
         *
         * 官方要求：重新初始化音频对象、重设 category/mode/options，并且
         * **在用户操作前不得自动恢复播放**。mpv 的输出设备也会随之失效，
         * 所以这里除了复位会话，还要把播放暂停并把意图清掉。
         */
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification, object: nil)

        installRemoteCommands()

        // 让本 App 成为系统的 "Now Playing 宿主"。
        //
        // 只注册 MPRemoteCommandCenter 的 target **不够** —— 系统还要靠这个调用
        // 建立"远程控制事件路由到本 App"的关系。缺了它，锁屏 / 控制中心 / 灵动岛
        // 压根不会把"正在播放"面板挂到我们头上（按钮不出现、或出现但点了没反应）。
        precondition(Thread.isMainThread, "beginReceivingRemoteControlEvents 必须在主线程调用")
        UIApplication.shared.beginReceivingRemoteControlEvents()

        logNowPlayingDiagnostics(reason: "engine-init")
    }

    deinit {
        // 先摘通知，再停核心：core 的事件线程会在销毁时刷出最后几帧回调
        NotificationCenter.default.removeObserver(self)
        mpv?.shutdown()
        mpv = nil
    }

    // MARK: 队列操作

    func setQueue(baseUrl: String, token: String, tracks: [SuenTrack],
                  startIndex: Int, startPositionMs: Int,
                  autoplay: Bool, tailOnly: Bool) throws {
        NSLog("[Start] setQueue 进入 autoplay=\(autoplay) startIndex=\(startIndex) tracks=\(tracks.count) tokenLen=\(token.count)")
        self.baseUrl = normalizedBase(baseUrl)
        self.sessionToken = token

        var effectiveTracks = tracks
        if tailOnly {
            /**
             * 尾段替换（Web 的「切随机 / 切回列表」走这条路径）：
             * 前提是「当前曲已知、且逻辑下标 < startIndex」，这时才谈得上
             * "只替换当前项之后的部分，不动正在播的这首"。
             */
            let canTail = !self.tracks.isEmpty
                && logicalIndex >= 0
                && logicalIndex < startIndex
                && logicalIndex < self.tracks.count
            if canTail {
                if startIndex <= self.tracks.count {
                    self.tracks = Array(self.tracks[0 ..< startIndex]) + tracks
                } else {
                    self.tracks = tracks
                }
                pruneDirectLinks()
                // 对齐 Android：tailOnly 路径不动播放状态（不 seek、不 play、不重新装载）
                NSLog("[setQueue] tailOnly 只换尾段（当前曲不动）→ %d 首", self.tracks.count)
                refreshRemoteCommandAvailability()
                return
            }
            if startIndex <= self.tracks.count {
                effectiveTracks = Array(self.tracks[0 ..< startIndex]) + tracks
            }
            NSLog("%@", "[setQueue] tailOnly 前提不成立，拼回全量后整队重建 "
                + "(startIndex=\(startIndex), tracks=\(tracks.count) → \(effectiveTracks.count))")
        }

        self.tracks = effectiveTracks
        // 换整条队列：旧队列曲目的直链全部作废（N-4）
        pruneDirectLinks()
        // 换整条队列 = 当前曲变了（规格 3.1）
        cancelCacheTasks()
        let start = min(max(0, startIndex), max(0, effectiveTracks.count - 1))
        loadCurrent(index: start, positionMs: startPositionMs, autoplay: autoplay, reason: 2)
    }

    /// 起播 / 暂停 / 停止都只调 reportPlaying，由它统一负责
    /// ① 写播放意图 ② 发 state 事件 ③ 刷新 Now Playing。
    func play() {
        activateIfNeeded()
        mpv?.play()
        reportPlaying(true)
        // 暂停作废过预约后，恢复播放等于「重新起播」→ 重新计时 25 秒（规格 3.3）
        scheduleCacheIfNeeded()
    }

    func pause() {
        mpv?.pause()
        // 暂停只作废**还没开下**的预约；已经开始下的必须一口气下完（规格 2.3）
        cancelCacheDelay()
        reportPlaying(false)
    }

    func stop() {
        mpv?.stop()
        cancelCacheDelay()
        reportPlaying(false)
        updateNowPlaying()
    }

    func seek(to positionMs: Int) {
        let seconds = max(0, Double(positionMs) / 1000.0)
        mpv?.seek(to: seconds)
        updateNowPlaying()
    }

    /// 语义对齐 Android：目标就是当前曲且非故障态 → **不动位置**（选中 ≠ 从头播）；
    /// force 或已到末尾才从头重载。
    func seekToIndex(_ index: Int, autoplay: Bool, force: Bool) {
        guard tracks.indices.contains(index) else { return }
        let atEnd: Bool = {
            guard let mpv = mpv else { return true }
            return mpv.duration > 0 && mpv.currentTime >= mpv.duration - 0.2
        }()
        if index == currentIndex && !force && !atEnd {
            if autoplay { play() }
            return
        }
        loadCurrent(index: index, positionMs: 0, autoplay: autoplay, reason: 2)
    }

    /// 换音源硬重载：停掉 → 重新解析取流地址 → 定位 → 出声
    func reloadCurrent(index: Int, positionMs: Int, autoplay: Bool) {
        guard tracks.indices.contains(index) else { return }
        loadCurrent(index: index, positionMs: positionMs, autoplay: autoplay, reason: 2)
    }

    func setRepeatMode(_ mode: String) {
        repeatMode = RepeatMode(rawValue: mode) ?? .order
        rebuildPlayOrder(startingAt: currentIndex)
        // 模式决定"队尾还有没有下一首"：off→all 会让锁屏的"下一首"从灰变亮
        refreshRemoteCommandAvailability()
    }

    // MARK: 队列变更（播放页的队列抽屉：跳播 / 删除 / 拖拽排序）

    /// 队列逻辑快照（Swift 数组是值类型，UI 拿到的是副本，改不动内核）
    var queueSnapshot: [SuenTrack] { tracks }

    /// 跳到指定下标并（可选）起播（hw jumpTo）：点的是当前曲 = 从头再来
    func jumpTo(_ index: Int, autoplay: Bool) {
        guard tracks.indices.contains(index) else { return }
        if index == currentIndex {
            seek(to: 0)
            if autoplay { play() }
            return
        }
        loadCurrent(index: index, positionMs: 0, autoplay: autoplay, reason: 2)
    }

    /// 摘除队列里的一项（hw removeAt 的内核侧）。
    ///
    /// 返回 true = 被摘的正是当前曲，**调用方必须立刻装载新的当前曲**：
    /// 本方法只把当前播放暂停，绝不自行接续（否则会出现"删掉 A 却在放 B"）。
    @discardableResult
    func removeQueueItem(at index: Int) -> Bool {
        guard tracks.indices.contains(index) else { return false }
        let wasCurrent = index == currentIndex
        if wasCurrent { mpv?.pause() }
        tracks.remove(at: index)
        if index < logicalIndex { logicalIndex -= 1 }
        if logicalIndex >= tracks.count { logicalIndex = max(0, tracks.count - 1) }
        pruneDirectLinks()   // 被摘掉的那首的直链再也不会被用到（N-4）
        return wasCurrent
    }

    /// 队列内移动一项（hw moveItem，拖拽排序）：保留当前曲、进度与播放意图，按新序重装。
    func moveQueueItem(from: Int, to: Int) {
        guard tracks.indices.contains(from), tracks.indices.contains(to), from != to else { return }
        let current = currentIndex
        let positionMs = Int(max(0, mpv?.currentTime ?? 0) * 1000)
        let wasPlaying = playingIntent
        let moved = tracks.remove(at: from)
        tracks.insert(moved, at: to)
        // 下标修正（hw 同口径）：挪走当前项要跟着挪；别的项跨过当前项要相应 ±1
        let newIndex: Int
        if from == current {
            newIndex = to
        } else if from < current && to >= current {
            newIndex = current - 1
        } else if from > current && to <= current {
            newIndex = current + 1
        } else {
            newIndex = current
        }
        loadCurrent(index: min(max(0, newIndex), max(0, tracks.count - 1)),
                    positionMs: positionMs, autoplay: wasPlaying, reason: 2)
    }

    func statusSnapshot() -> [String: Any] {
        let positionMs = Int(max(0, mpv?.currentTime ?? 0) * 1000)
        return [
            "index": currentIndex,
            "positionMs": max(0, positionMs),
            "durationMs": max(0, currentItemDurationMs()),
            // 用**播放意图**而不是瞬时状态：缓冲时 mpv 自己会暂停，而 Web 的
            // restoreSession 拿它判断"是否该恢复播放"，一缓冲就误判成暂停（重审 F）。
            "playing": playingIntent,
            "queueLength": tracks.count,
        ]
    }

    // MARK: 私有：装载

    private struct ResolvedSource {
        let url: String
        let headers: [String: String]?
    }

    /// 装载并（可选）起播第 index 首：解析音源 → 设 headers → loadfile → 定位。
    ///
    /// reason: 1 = AUTO（播完自动接续） 2 = SEEK（显式切歌 / 重载），与 iOS 老口径一致。
    private func loadCurrent(index: Int, positionMs: Int, autoplay: Bool, reason: Int) {
        guard tracks.indices.contains(index), let mpv = mpv else { return }
        if reason == 2 { consecutiveErrors = 0 }
        logicalIndex = index
        // 切歌 = 立即取消未完成的下载并丢弃已下部分（规格 3.1 / 3.2）；
        // 下一首的预约由起播点重新发起。
        cancelCacheTasks()

        let track = tracks[index]
        let source = resolveSource(for: track)
        NSLog("[Start] mpv load idx=%d id=%@ startAt=%dms autoplay=%@",
              index, track.id, positionMs, autoplay ? "yes" : "no")
        mpv.load(url: source.url,
                 headers: source.headers,
                 startAt: Double(max(0, positionMs)) / 1000.0,
                 autoplay: autoplay)

        if autoplay {
            reportPlaying(true)
            // 真起播之后**不立刻**下载：只预约，25 秒后才发起（规格 2.1）
            scheduleCacheIfNeeded()
        }
        updateNowPlaying()
        events?.emitTrackChange(index: index, id: track.id, reason: reason)
    }

    /// 取流地址的三级优先（与 AVPlayer 时代同口径，只把"喂给播放器"的动作换成 mpv）：
    /// ① 本地完整缓存 → 本地文件路径；② 服务端解析出的 CDN 直链；③ 服务端代理流。
    private func resolveSource(for track: SuenTrack) -> ResolvedSource {
        // ① 本地完整缓存优先：命中就直接放本地文件（不需要任何 headers，也不走网络）
        if let cached = AudioCacheStore.shared.cachedFileURL(track.id) {
            AudioCacheStore.shared.setAccess(track.id)
            NSLog("%@", "[AudioCache] mpv load id=\(track.id) 命中本地 file=\(cached.lastPathComponent)")
            // 用**文件路径**而不是 absoluteString：ffmpeg 的 file 协议不解 %XX，
            // 容器路径里带空格（Application Support）时 URL 编码过的串会打不开文件。
            return ResolvedSource(url: cached.path, headers: nil)
        }
        // ② 其次 CDN 直链（对齐鸿蒙端直连体系，零服务端带宽）
        if let direct = directLinks[track.id], direct.expiresAt > Date(), !direct.url.isEmpty {
            NSLog("%@", "[DirectCDN] mpv load id=\(track.id) directUrl=\(direct.url.prefix(200))")
            return ResolvedSource(url: direct.url, headers: mergedHeaders(direct.headers, for: direct.url))
        }
        // ③ 兜底：服务端代理流
        let url = directStreamUrl(track.id)
        NSLog("%@", "[StreamUrl] mpv load id=\(track.id) proxyUrl=\(url.prefix(200))")
        return ResolvedSource(url: url, headers: mergedHeaders(nil, for: url))
    }

    /// HEADERS 兜底：B 站 CDN 只认 Referer + UA，服务端下发的 directHeaders 已带，
    /// 但解析缓存偶尔只给 UA —— 缺了就是 403，这里按域名补齐（宁可多设一个头）。
    private func mergedHeaders(_ headers: [String: String]?, for url: String) -> [String: String]? {
        var merged = headers ?? [:]
        if merged["User-Agent"] == nil { merged["User-Agent"] = Self.streamUserAgent }
        if merged["Referer"] == nil,
           url.contains("bilibili") || url.contains("bilivideo") {
            merged["Referer"] = "https://www.bilibili.com/"
        }
        return merged.isEmpty ? nil : merged
    }

    // MARK: 私有：mpv 回调（都由 MpvPlayer 切回主线程后调用）

    private func handleTime(_ seconds: Double) {
        let posMs = max(0, Int(seconds * 1000))
        diagTick(posMs)
        events?.emitProgress(index: currentIndex,
                             positionMs: posMs,
                             durationMs: max(0, currentItemDurationMs()),
                             playing: playingIntent)
        resyncNowPlayingIfStale()
    }

    private func handleDuration(_ seconds: Double) {
        guard seconds.isFinite, seconds > 0 else { return }
        NSLog("[Mpv] duration=%.2fs idx=%d", seconds, currentIndex)
    }

    /// 状态回调只做三件事：
    /// ① 真正开始出声（含缓冲恢复）→ 补一次"播放中"；② 缓冲只打日志，不动 UI 状态；
    /// ③ 暂停**不在这里上报** —— 暂停一律由 play/pause/stop/打断/曲末这些**意图明确**的路径上报，
    ///    否则 mpv 内部缓冲时的瞬时暂停会把 UI 闪一下。
    private func handleMpvState(_ state: MpvPlayer.PlaybackState) {
        switch state {
        case .playing:
            reportPlaying(true)
        case .buffering:
            NSLog("%@", "[Mpv] 缓冲中（保持播放意图）")
        case .paused, .idle:
            break
        }
    }

    /// 曲末接续（mpv END_FILE 自然播完）：
    ///   - repeat one：原地归零重播（reason=2，不是切歌）
    ///   - 队列中：按 playOrder 取下一首，reason=1（上层据此把 manualLoad 置 false）
    ///   - repeat all + 队尾：环绕重建
    ///   - repeat off + 队尾：停在末尾（等价 Media3 STATE_ENDED）
    private func handleFileEnd() {
        let idx = logicalIndex
        guard tracks.indices.contains(idx) else { return }

        if repeatMode == .repeatOne {
            NSLog("[Loop] repeat-one 命中 idx=%d dur=%dms", idx, currentItemDurationMs())
            loadCurrent(index: idx, positionMs: 0, autoplay: true, reason: 2)
            return
        }

        if let next = nextLogicalIndex() {
            loadCurrent(index: next, positionMs: 0, autoplay: true, reason: 1)
        } else {
            // 顺序播完 / 随机不重复播完：停在末尾
            cancelCacheTasks()   // 播完立即取消未完成的下载（规格 3.1）
            reportPlaying(false)
            updateNowPlaying()
        }
    }

    private func handleMpvError(_ message: String) {
        NSLog("[Mpv] 播放失败：%@", message)
        // ⚠️ 引擎**不许自己跳歌**（对齐 hw：失败策略在服务层 settleFailure）：
        // 手动点播=停住并标"无音源"，连播=静默跳过，连续失败=通知+暂停。
        events?.emitError(message: message)
        handlePlaybackFailure()
    }

    private func handlePlaybackFailure() {
        consecutiveErrors += 1
        if consecutiveErrors >= Self.maxConsecutiveErrors { consecutiveErrors = 0 }
        reportPlaying(false)
    }

    /// 诊断打点（真机排障用）：每 2s 打一次核心真实状态
    private func diagTick(_ positionMs: Int) {
        let now = Date()
        guard now.timeIntervalSince(lastDiagAt) >= 2 else { return }
        lastDiagAt = now
        NSLog("[Diag] pos=%dms dur=%dms state=%@ intent=%@",
              positionMs, currentItemDurationMs(),
              mpv?.state.rawValue ?? "-",
              playingIntent ? "play" : "pause")
    }

    // MARK: 私有：播放状态上报

    /// state 事件的唯一出口。语义是**播放意图**，不是瞬时播放状态。
    private func reportPlaying(_ playing: Bool) {
        // 这里是**播放意图**的唯一写入点。放在去重之前：即使 Web 端已经知道
        // 这个状态（事件被去重吃掉），Now Playing 的 rate 也必须落在正确值上。
        playingIntent = playing
        if playing {
            consecutiveErrors = 0
        }

        guard lastReportedPlaying != playing else { return }
        lastReportedPlaying = playing
        events?.emitState(playing: playing)
        updateNowPlaying()
    }

    /// 往队列尾部追加曲目（搜索结果翻页续接）。**不打断当前播放**。
    func appendToQueue(_ newTracks: [SuenTrack]) {
        guard !newTracks.isEmpty else { return }
        if playOrder.isEmpty && !tracks.isEmpty { playOrder = Array(tracks.indices) }
        let old = tracks.count
        tracks.append(contentsOf: newTracks)
        let added = Array(old..<tracks.count)
        playOrder.append(contentsOf: repeatMode.isShuffle ? added.shuffled() : added)
        NSLog("[Queue] 追加 %d 首 → %d 首（源=%@）", newTracks.count, tracks.count, repeatMode.rawValue)
    }

    // MARK: 播放顺序（随机 / 随机不重复）—— 与 AVPlayer 时代逐字一致

    /// 重建播放顺序：非随机 = 原序；随机 = 当前曲打头 + 其余洗牌。
    private func rebuildPlayOrder(startingAt index: Int) {
        guard !tracks.isEmpty else { playOrder = []; return }
        guard repeatMode.isShuffle else {
            playOrder = Array(tracks.indices)
            return
        }
        let safe = min(max(0, index), tracks.count - 1)
        playOrder = [safe] + tracks.indices.filter { $0 != safe }.shuffled()
    }

    /// 下一首的逻辑下标；nil = 到头且不允许回绕
    func nextLogicalIndex() -> Int? {
        guard !tracks.isEmpty else { return nil }
        if playOrder.count != tracks.count { rebuildPlayOrder(startingAt: currentIndex) }
        let base = playOrder.contains(currentIndex) ? currentIndex : (playOrder.first ?? currentIndex)
        return nextIndex(after: base)
    }

    /// 以给定逻辑下标为基准、按**播放顺序表**再走一步的下一首（N-2）。
    func nextIndex(after index: Int) -> Int? {
        guard !tracks.isEmpty else { return nil }
        if playOrder.count != tracks.count { rebuildPlayOrder(startingAt: index) }
        guard let pos = playOrder.firstIndex(of: index) else { return nil }
        if pos + 1 < playOrder.count { return playOrder[pos + 1] }
        switch repeatMode {
        case .listLoop:
            return playOrder.first
        case .shuffle:
            // 随机播放到末尾：重洗一轮继续（首位避开刚刚播完的那首）
            rebuildPlayOrder(startingAt: index)
            return playOrder.count > 1 ? playOrder[1] : playOrder.first
        default:
            return nil
        }
    }

    /// 上一首的逻辑下标；nil = 到头部且不允许回绕
    func previousLogicalIndex() -> Int? {
        guard !tracks.isEmpty else { return nil }
        if playOrder.count != tracks.count { rebuildPlayOrder(startingAt: currentIndex) }
        let base = playOrder.contains(currentIndex) ? currentIndex : (playOrder.first ?? currentIndex)
        return previousIndex(before: base)
    }

    /// 以给定逻辑下标为基准、按播放顺序表退一步的上一首（N-2）
    func previousIndex(before index: Int) -> Int? {
        guard !tracks.isEmpty else { return nil }
        if playOrder.count != tracks.count { rebuildPlayOrder(startingAt: index) }
        guard let pos = playOrder.firstIndex(of: index) else { return nil }
        if pos > 0 { return playOrder[pos - 1] }
        return repeatMode == .listLoop ? playOrder.last : nil
    }

    // MARK: 私有：状态跟踪

    /// 当前逻辑下标。兜底必须是「最后一次已知的逻辑下标」，而不是 0：mpv 刚装载、
    /// 时长还没解析出来时 emitProgress 会带 index 回传，兜底 0 会让**播放页显示
    /// queue[0] 的歌名/封面，而音频放的是用户点的那首**（用户实测过）。
    var currentIndex: Int {
        tracks.indices.contains(logicalIndex) ? logicalIndex : 0
    }

    private func currentItemDurationMs() -> Int {
        // ① 先用 mpv 解析出的**真实媒体时长**（文件就是我们实际在播的那个）
        if let mpv = mpv, mpv.duration.isFinite, mpv.duration > 0 {
            return Int(mpv.duration * 1000)
        }
        // ② 还没解析出时长时退回元数据（Web 端还会用已知真实时长覆盖）
        let idx = currentIndex
        return tracks.indices.contains(idx) ? tracks[idx].durationMs : 0
    }

    /// 起播后落盘缓存的取数口：当前曲 + **未过期**的 CDN 直链。
    ///
    /// 没有直链就返回 nil —— 上层据此放弃缓存，绝不用 /api/stream 代理 URL 当下载源。
    func currentCacheSource() -> (track: SuenTrack, url: String, headers: [String: String]?)? {
        let idx = currentIndex
        guard tracks.indices.contains(idx) else { return nil }
        let track = tracks[idx]
        guard let direct = directLinks[track.id], direct.expiresAt > Date(), !direct.url.isEmpty else {
            return nil
        }
        return (track, direct.url, direct.headers)
    }

    /// **预约**当前曲的整首缓存：起播后 25 秒才真正发起（规格 2.1）。
    private func scheduleCacheIfNeeded() {
        let idx = currentIndex
        guard tracks.indices.contains(idx) else { return }
        guard cacheDelayTask == nil else { return }
        let delay = Self.cacheDelaySeconds * 1_000_000_000
        cacheDelayTask = Task { [weak self] in
            // 取消（切歌 / 暂停 / 停止）时 sleep 立刻抛错返回，后面的下载根本不会发起
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled, let self else { return }
            EngineThread.onMain { self.startCacheDownloadNow() }
        }
    }

    /// 预约到点：一口气下完当前曲（规格 2.3），并留下句柄供「切歌即取消」用（规格 3.1）。
    private func startCacheDownloadNow() {
        cacheDelayTask = nil
        guard let src = currentCacheSource() else {
            NSLog("%@", "[AudioCache] 25s 到点但无直链，本次不缓存")
            return
        }
        if AudioCacheStore.shared.isCached(src.track.id) {
            AudioCacheStore.shared.setAccess(src.track.id)
            return
        }
        cacheDownloadTask = AudioCacheStore.shared.download(
            trackId: src.track.id,
            name: src.track.title,
            artist: src.track.artist,
            url: src.url,
            headers: src.headers
        )
        if cacheDownloadTask != nil {
            NSLog("%@", "[AudioCache] 起播 25s 到点，开始整首下载 id=\(src.track.id)")
        }
    }

    /// 作废预约 + 取消在飞下载（规格 3.1 / 3.2 / 3.3）。
    private func cancelCacheTasks() {
        cancelCacheDelay()
        cacheDownloadTask?.cancel()
        cacheDownloadTask = nil
    }

    /// 只作废「25 秒预约」，不动已在进行的下载（规格 2.3：一旦启动就一口气下完）。
    private func cancelCacheDelay() {
        cacheDelayTask?.cancel()
        cacheDelayTask = nil
    }

    /// 直链晚到时补一次**预约**：当前曲确实在播才预约（否则等于替用户偷偷下载）。
    private func cacheIfPlaying(trackId: String) {
        let fire = { [weak self] in
            guard let self, self.playingIntent else { return }
            let idx = self.currentIndex
            guard self.tracks.indices.contains(idx), self.tracks[idx].id == trackId else { return }
            self.scheduleCacheIfNeeded()
        }
        if Thread.isMainThread { fire() } else { EngineThread.onMain(fire) }
    }

    /// 直连上游（对齐 Android SuenAudio.streamUrlFor，防御双斜杠）
    private func directStreamUrl(_ trackId: String) -> String {
        var base = baseUrl
        while base.hasSuffix("/") { base.removeLast() }
        let encId = trackId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trackId
        if !sessionToken.isEmpty {
            let encToken = sessionToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sessionToken
            return "\(base)/api/stream/\(encId)?platform=ios&t=\(encToken)"
        }
        return "\(base)/api/stream/\(encId)?platform=ios"
    }

    private func normalizedBase(_ raw: String) -> String {
        var base = raw
        while base.hasSuffix("/") { base.removeLast() }
        return base
    }

    private func activateIfNeeded() {
        guard !isActivated else { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            isActivated = true
        } catch {
            // 以前是 try? 吞错 + 无条件置 true：一旦某次激活被拒（来电后、后台受限、
            // 别的 App 占着），isActivated 卡在 true，之后每次 activateIfNeeded() 都短路
            // —— 表现为"永远没声音，只能杀 App"。保持 false，下一次播放会自然重试。
            isActivated = false
            NSLog("%@", "[AudioSession] 激活失败，下次播放重试: \(error.localizedDescription)")
        }
    }

    // MARK: 私有：系统事件

    /// 音频焦点（对齐 Android：来电暂停、让路导航）
    ///
    /// AVAudioSession 的通知由系统从内部队列投递，线程不确定 —— 先切回主线程再动 mpv。
    @objc private func handleInterruption(_ note: Notification) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.handleInterruption(note) }
            return
        }
        guard let info = note.userInfo,
              let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        switch type {
        case .began:
            mpv?.pause()
            reportPlaying(false)
        case .ended:
            // 不自动恢复播放（对齐 Android 的保守策略：是否继续由用户按播放决定），
            // 但**必须复位音频会话**：系统在打断期间把 AVAudioSession 置为非激活，
            // 而 isActivated 还停在 true → activateIfNeeded() 之后永远短路 →
            // 挂断电话再按播放完全没声音（真机复现过）。
            isActivated = false
            activateIfNeeded()
            reportPlaying(false)
            break
        @unknown default:
            break
        }
    }

    /**
     * 音频服务被重置：旧的 session 配置与"已激活"标记全部作废。
     *
     * 只重建音频环境、**不自动起播** —— 官方明确要求把是否继续播放交回用户。
     * mpv 的 audiounit 输出同样失效，所以顺手暂停并清掉播放意图。
     */
    @objc private func handleMediaServicesReset(_ note: Notification) {
        EngineThread.onMain { [weak self] in
            guard let self else { return }
            NSLog("%@", "[AudioSession] 音频服务被系统重置，重新初始化会话")
            self.isActivated = false
            self.activateIfNeeded()
            self.playingIntent = false
            self.mpv?.pause()
            self.reportPlaying(false)
            self.updateNowPlaying()
        }
    }

    /// 耳机插拔：拔出即暂停（对齐 Android 行为）
    @objc private func handleRouteChange(_ note: Notification) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.handleRouteChange(note) }
            return
        }
        guard let info = note.userInfo,
              let reasonRaw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) else { return }
        if reason == .oldDeviceUnavailable {
            mpv?.pause()
            reportPlaying(false)
        }
    }

    // MARK: 私有：锁屏 / 控制中心

    /// 下一首。队列到尾时按 repeatMode 决定是否回到开头。
    @discardableResult
    func skipToNext() -> Bool {
        guard !tracks.isEmpty else { return false }
        guard let next = nextLogicalIndex() else { return false }
        loadCurrent(index: next, positionMs: 0, autoplay: true, reason: 2)
        return true
    }

    /// 上一首。队首且非列表循环时失败（与 Android 一致）。
    @discardableResult
    func skipToPrevious() -> Bool {
        guard !tracks.isEmpty else { return false }
        guard let prev = previousLogicalIndex() else { return false }
        loadCurrent(index: prev, positionMs: 0, autoplay: true, reason: 2)
        return true
    }

    /// 注册锁屏 / 控制中心 / 灵动岛的远程控制命令。
    ///
    /// ⚠️ 「addTarget 就够了」是错的：isEnabled 才是系统决定这颗按钮
    /// 显不显示、点不点得动的依据。两者必须成对处理。
    /// 远程命令回调现在打的是 MpvPlayer（play/pause/seek 都落在 mpv 上）。
    private func installRemoteCommands() {
        guard !remoteCommandsInstalled else { return }
        remoteCommandsInstalled = true
        let center = MPRemoteCommandCenter.shared()

        // 重复安装会叠加 target（同一次按键被处理多次）→ 先清空再注册
        [
            center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
            center.nextTrackCommand, center.previousTrackCommand,
            center.changePlaybackPositionCommand,
        ].forEach { $0.removeTarget(nil) }

        let playTarget = center.playCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.play()
            return .success
        }
        let pauseTarget = center.pauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.pause()
            return .success
        }
        let toggleTarget = center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            // 看**意图**而不是瞬时状态：缓冲时 mpv 自己是暂停的，
            // 按状态判断会把"暂停"误当成"播放"，用户按一下反而又起播一次。
            self.playingIntent ? self.pause() : self.play()
            return .success
        }
        let nextTarget = center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            return self.skipToNext() ? .success : .commandFailed
        }
        let prevTarget = center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            return self.skipToPrevious() ? .success : .commandFailed
        }
        let positionTarget = center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self,
                  let posEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self.seek(to: Int(posEvent.positionTime * 1000))
            return .success
        }
        remoteCommandTargets = [
            playTarget, pauseTarget, toggleTarget, nextTarget, prevTarget, positionTarget,
        ]

        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true

        // 对齐 Android 通知栏的按钮集合（上一首 / 暂停 / 下一首 + 进度条）。
        // 不注册 ±15s 快进快退，并显式关掉 —— 否则系统会在锁屏多塞两颗按钮。
        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false

        refreshRemoteCommandAvailability()
    }

    /// 锁屏 / 控制中心按钮的可用性。系统不会替我们判断"还有没有下一首"，它只看 isEnabled。
    private func refreshRemoteCommandAvailability() {
        let center = MPRemoteCommandCenter.shared()
        let hasTracks = !tracks.isEmpty
        let canGoNext = hasTracks && nextLogicalIndex() != nil
        let canGoPrev = hasTracks && previousLogicalIndex() != nil
        center.nextTrackCommand.isEnabled = canGoNext
        center.previousTrackCommand.isEnabled = canGoPrev
        center.changePlaybackPositionCommand.isEnabled = hasTracks
    }

    /// 写 Now Playing 元数据 —— 锁屏、控制中心、灵动岛、CarPlay 面板的**唯一数据源**。
    ///
    /// 刷新策略是**事件驱动**（play / pause / seek / 换曲），不在进度心跳里逐帧覆写：
    /// 系统会拿 MPNowPlayingInfoPropertyPlaybackRate 自己推算进度条位置，
    /// 我们再每 500ms 覆写一次 ElapsedPlaybackTime 反而会让进度条抖动（官方指南列为反模式）。
    private func updateNowPlaying() {
        lastNowPlayingUpdate = Date()

        guard tracks.indices.contains(currentIndex) else {
            nowPlaying.nowPlayingInfo = nil
            refreshRemoteCommandAvailability()
            return
        }
        let track = tracks[currentIndex]
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPMediaItemPropertyPlaybackDuration: Double(max(1, currentItemDurationMs())) / 1000.0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: max(0, mpv?.currentTime ?? 0),
            // 意图，不是瞬时状态（理由见 playingIntent 注释）
            MPNowPlayingInfoPropertyPlaybackRate: playingIntent ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let album = track.album, !album.isEmpty {
            info[MPMediaItemPropertyAlbumTitle] = album
        }
        nowPlaying.nowPlayingInfo = info

        if let coverUrl = track.coverUrl, !coverUrl.isEmpty {
            loadArtwork(for: track.id, url: coverUrl)
        }
        refreshRemoteCommandAvailability()
        logNowPlayingDiagnostics(reason: "update")
    }

    /// 低频校准：长播时系统按 rate 推算的进度会漂，每 10s 拿真实位置正面覆盖一次。
    private func resyncNowPlayingIfStale() {
        guard Date().timeIntervalSince(lastNowPlayingUpdate) >= 10 else { return }
        updateNowPlaying()
    }

    /// Now Playing 自检：把系统侧真正生效的状态打到 Xcode 控制台。
    /// 存在意义：锁屏 / 灵动岛由系统渲染，**模拟器不渲染**它们，只能靠日志自证数据源已就绪。
    private func logNowPlayingDiagnostics(reason: String) {
        guard nowPlayingDebugLog else { return }
        let session = AVAudioSession.sharedInstance()
        let center = MPRemoteCommandCenter.shared()
        let info = nowPlaying.nowPlayingInfo
        let title = (info?[MPMediaItemPropertyTitle] as? String) ?? "-"
        let elapsed = (info?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double) ?? -1
        let duration = (info?[MPMediaItemPropertyPlaybackDuration] as? Double) ?? -1
        let rate = (info?[MPNowPlayingInfoPropertyPlaybackRate] as? Double) ?? -1
        let hasArtwork = info?[MPMediaItemPropertyArtwork] != nil
        let num = { (v: Double) in String(format: "%.1f", v) }
        print("[NowPlaying/\(reason)] cat=\(session.category.rawValue) mode=\(session.mode.rawValue) "
              + "opts=\(session.categoryOptions.rawValue) ioSampleRate=\(session.sampleRate) "
              + "intent=\(playingIntent ? "play" : "pause")")
        print("[NowPlaying/\(reason)] title=\(title) rate=\(num(rate)) elapsed=\(num(elapsed)) "
              + "dur=\(num(duration)) artwork=\(hasArtwork ? "Y" : "N") "
              + "| cmds play=\(center.playCommand.isEnabled) pause=\(center.pauseCommand.isEnabled) "
              + "toggle=\(center.togglePlayPauseCommand.isEnabled) next=\(center.nextTrackCommand.isEnabled) "
              + "prev=\(center.previousTrackCommand.isEnabled) "
              + "seek=\(center.changePlaybackPositionCommand.isEnabled)")
    }

    private func loadArtwork(for trackId: String, url: String) {
        if let cached = artworkCache[trackId] {
            var info = nowPlaying.nowPlayingInfo ?? [:]
            info[MPMediaItemPropertyArtwork] = cached
            nowPlaying.nowPlayingInfo = info
            return
        }
        guard let remote = URL(string: url) else { return }
        URLSession.shared.dataTask(with: remote) { [weak self] data, _, _ in
                guard let self = self, let data = data,
                      let image = UIImage(data: data) else { return }
            // boundsSize 为 .zero 会让封面在锁屏上直接不显示（系统按这个尺寸索取图像）
            let bounds = image.size
            guard bounds.width > 0, bounds.height > 0 else { return }
            let artwork = MPMediaItemArtwork(boundsSize: bounds) { _ in image }
            DispatchQueue.main.async {
                // artworkCache 只在主线程读写
                self.artworkCache[trackId] = artwork
                guard self.tracks.indices.contains(self.currentIndex),
                      self.tracks[self.currentIndex].id == trackId else { return }
                var info = self.nowPlaying.nowPlayingInfo ?? [:]
                info[MPMediaItemPropertyArtwork] = artwork
                self.nowPlaying.nowPlayingInfo = info
            }
        }.resume()
    }
}

enum CoverCache {
    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("covers", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    static func clear() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// 已存在的不重复下载；单个失败返回 nil（尽力而为，对齐 Android）
    static func cacheImage(_ urlString: String) -> String? {
        guard let url = URL(string: urlString) else { return nil }
        let digest = Insecure.SHA1.hash(data: Data(urlString.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        let dest = directory.appendingPathComponent("\(hex).img")

        if FileManager.default.fileExists(atPath: dest.path) {
            return dest.path
        }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("SuenMusic/1.0 (iOS)", forHTTPHeaderField: "User-Agent")
        // cacheImages 跑在 utility 队列上，用信号量把异步下载转同步（逐张尽力而为）
        let semaphore = DispatchSemaphore(value: 0)
        var payload: Data?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            payload = data
            semaphore.signal()
        }.resume()
        semaphore.wait()
        guard let data = payload, !data.isEmpty else {
            return nil
        }
        try? data.write(to: dest, options: .atomic)
        return dest.path
    }
}

final class NetworkMonitor {
    private let monitor = NWPathMonitor()
    private var lastSatisfied: Bool?
    private var lastInterfaceType: NWInterface.InterfaceType?
    var onChange: ((String) -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            let satisfied = path.status == .satisfied
            let interfaceType = path.availableInterfaces.first?.type
            guard let lastSatisfied = self.lastSatisfied else {
                // 首次回调只记录基线，不发事件（对齐 Android：只报"变化"）
                self.lastSatisfied = satisfied
                self.lastInterfaceType = interfaceType
                return
            }
            // WiFi↔蜂窝切换时 satisfied 始终为 true，只靠连通性翻转报不出"切网"事件；
            // 接口类型变化也要报 —— 停在旧路径上的请求（缓存下载、Web 端探测）等的就是这个信号
            guard satisfied != lastSatisfied || interfaceType != self.lastInterfaceType else { return }
            self.lastSatisfied = satisfied
            self.lastInterfaceType = interfaceType
            self.onChange?(satisfied ? "available" : "lost")
        }
        monitor.start(queue: DispatchQueue.global(qos: .utility))
    }
}
