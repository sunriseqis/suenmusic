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
    /// 缓冲态（mpv 的 paused-for-cache / core-idle）。上层复用**已有的 loading 通道**，
    /// 不新造一套「缓冲中」状态位（loading 才是「还没真正出声」的唯一表示）。
    func emitBuffering(_ buffering: Bool)
}

extension AudioEngineEvents {
    /// 默认空实现：只有真正关心缓冲的实现（PlaybackService）才需要重写
    func emitBuffering(_ buffering: Bool) {}
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

    /// time-pos 驱动的进度回写节流点（约 1s 一次，见 writeNowPlayingProgress）
    private var lastNowPlayingProgressAt = Date.distantPast
    private static let nowPlayingProgressInterval: TimeInterval = 1.0
    /// 进度路径的诊断打点节流点（1s 回写太密，诊断 5s 一条足够）
    private var lastProgressDiagAt = Date.distantPast
    private static let progressDiagInterval: TimeInterval = 5.0

    // MARK: mpv 侧停滞看门狗（P1 删掉了 AVPlayer 时代的 10s stall 看门狗，这里在 mpv 侧补回来）

    /// playing / buffering 态下 time-pos 多久不推进算「卡死」
    private static let stallTimeoutSec: TimeInterval = 10
    /// 看门狗轮询间隔
    private static let stallPollSec: TimeInterval = 2
    private var stallTimer: Timer?
    /// 最近一次 time-pos 真的往前走的时刻
    private var lastAdvanceAt = Date()
    private var lastAdvancePosition: Double = 0
    /// 本轮装载已经自愈重装过几次（只允许 1 次，再失败交给上层失败三分支）
    private var stallRecoveries = 0
    private static let maxStallRecoveries = 1

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
    /// 「会话重申」诊断日志的节流点：loadfile / seek / 播放态都会触发重申，2s 一条足够
    private var lastReassertDiagAt = Date.distantPast
    private static let reassertDiagInterval: TimeInterval = 2.0

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
        wire(player)

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
        // mpv 侧停滞看门狗：playing 态下 time-pos 长期不推进 → 重装一次 → 再失败走上层失败三分支
        startStallWatchdog()

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
        // 先摘通知 / 停看门狗，再停核心：core 的事件线程会在销毁时刷出最后几帧回调
        NotificationCenter.default.removeObserver(self)
        stallTimer?.invalidate()
        stallTimer = nil
        mpv?.shutdown()
        mpv = nil
    }

    /// 把 mpv 的全部回调挂上来（init 与「媒体服务重置后重建核心」共用一处）
    private func wire(_ player: MpvPlayer) {
        player.onTime = { [weak self] seconds in self?.handleTime(seconds) }
        player.onDuration = { [weak self] seconds in self?.handleDuration(seconds) }
        player.onState = { [weak self] state in self?.handleMpvState(state) }
        player.onEnded = { [weak self] in self?.handleFileEnd() }
        player.onError = { [weak self] message in self?.handleMpvError(message) }
        player.onFileLoaded = { [weak self] in
            guard let self = self else { return }
            NSLog("[Start] mpv 已装载 idx=%d dur=%dms", self.currentIndex, self.currentItemDurationMs())
            // loadfile 会重建音频输出 → mpv 可能又改了一遍会话，装载完再重申一次
            self.reassertPlaybackSession(reason: "file-loaded")
            self.updateNowPlaying()
        }
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
        // seek 会重配音频输出 → 同样重申一次会话（幂等，会话已正确时立刻返回）
        reassertPlaybackSession(reason: "seek")
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
        // 新一轮装载：停滞看门狗的推进基准与自愈额度一起复位
        stallRecoveries = 0
        lastAdvanceAt = Date()
        lastAdvancePosition = Double(max(0, positionMs)) / 1000.0
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
        // 停滞看门狗的推进基准：time-pos 真的**往前走**了才算有推进
        // （缓冲 / 暂停时 mpv 根本不会发这个事件，所以这里的更新只可能来自真推进）
        if seconds > lastAdvancePosition + 0.05 {
            lastAdvancePosition = seconds
            lastAdvanceAt = Date()
        }
        diagTick(posMs)
        events?.emitProgress(index: currentIndex,
                             positionMs: posMs,
                             durationMs: max(0, currentItemDurationMs()),
                             playing: playingIntent)
        // 进度回写改成 time-pos 驱动（约 1s 节流），不再靠系统按 rate 推算 + 10s 校准
        writeNowPlayingProgress(elapsed: seconds)
    }

    private func handleDuration(_ seconds: Double) {
        guard seconds.isFinite, seconds > 0 else { return }
        NSLog("[Mpv] duration=%.2fs idx=%d", seconds, currentIndex)
    }

    /// 状态回调只做三件事：
    /// ① 真正开始出声（含缓冲恢复）→ 收起缓冲反馈 + 补一次「播放中」；
    /// ② 缓冲（paused-for-cache / core-idle）→ 走上层已有的 loading 通道，**不动播放意图**；
    /// ③ 暂停**不在这里上报** —— 暂停一律由 play/pause/stop/打断/曲末这些**意图明确**的路径上报，
    ///    否则 mpv 内部缓冲时的瞬时暂停会把 UI 闪一下。
    private func handleMpvState(_ state: MpvPlayer.PlaybackState) {
        switch state {
        case .playing:
            // 真正出流：收起缓冲反馈 + 补一次「播放中」
            events?.emitBuffering(false)
            reportPlaying(true)
            // mpv 的 audiounit 输出会把会话改成 mixWithOthers（日志 opts=1）→ 系统判为
            // 次要音频、不挂 Now Playing 面板。播放态一到就把会话**完整**改回来，
            // 再重新发布——顺序必须是「改回会话 → updateNowPlaying()」。
            reassertPlaybackSession(reason: "mpv-playing")
            logNowPlayingDiagnostics(reason: "mpv-playing")
            // 缓冲恢复后意图早已是 true（reportPlaying 会被去重），这里再正面刷一次，
            // 保证 PlaybackRate 从 0 立刻回 1.0，而不是等下一个 time-pos tick（最多滞后 1s）
            updateNowPlaying()
        case .buffering:
            // paused-for-cache / core-idle → 走上层**已有的 loading 通道**
            // （PlaybackService 的看门狗与失败三分支都挂在 loading 上，不另造状态位）
            NSLog("%@", "[Mpv] 缓冲中 → loading（播放意图不变）")
            if playingIntent { events?.emitBuffering(true) }
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

    // MARK: 私有：mpv 停滞看门狗（失败自愈）

    /// 看门狗轮询：playing / buffering 态下 time-pos 超过 stallTimeoutSec 不推进 → 自愈。
    ///
    /// 为什么需要：P1 删掉了 AVPlayer 时代的 10s stall 看门狗之后，mpv 一旦卡死
    /// （CDN 断流、解码线程挂住、缓冲永远等不到数据）就没有任何恢复手段 ——
    /// 表现是「进度条冻在那里，按暂停再播放也没用，只能杀 App」。
    ///
    /// 恢复阶梯（与上层失败三分支对齐）：
    ///   ① 重新 load 当前源一次（保留进度）；
    ///   ② 重装后仍然不推进 → 走 handleMpvError，交给 PlaybackService 的失败三分支
    ///      （手动点播 = 停住标「无音源」；连播 = 静默跳过；连续失败 = 暂停 + 通知）。
    ///
    /// 只在主线程跑：Timer 挂在主 RunLoop，mpv 的回调也已切回主线程。
    private func startStallWatchdog() {
        stallTimer?.invalidate()
        let timer = Timer(timeInterval: Self.stallPollSec, repeats: true) { [weak self] _ in
            self?.stallWatchdogTick()
        }
        // .common：拖拽播放页 / 拖进度条时主 RunLoop 进 tracking mode，用 default 会停摆
        RunLoop.main.add(timer, forMode: .common)
        stallTimer = timer
    }

    private func stallWatchdogTick() {
        guard let mpv = mpv, playingIntent else {
            // 没在播（或用户已暂停）→ 停滞无从谈起，基准一直刷新
            lastAdvanceAt = Date()
            return
        }
        switch mpv.state {
        case .playing, .buffering:
            break   // 这两种状态下「该有推进」，继续判定
        case .paused, .idle:
            lastAdvanceAt = Date()
            return
        }
        let stalledFor = Date().timeIntervalSince(lastAdvanceAt)
        guard stalledFor >= Self.stallTimeoutSec else { return }

        if stallRecoveries < Self.maxStallRecoveries {
            let resumeMs = Int(max(0, mpv.currentTime) * 1000)
            NSLog("[Watchdog] mpv 停滞 %.0fs（pos=%dms）→ 重新装载当前源一次", stalledFor, resumeMs)
            let attempt = stallRecoveries + 1
            loadCurrent(index: currentIndex, positionMs: resumeMs, autoplay: true, reason: 2)
            // loadCurrent 会把额度清零（新一轮装载），这里压回「已用掉一次」
            stallRecoveries = attempt
            lastAdvanceAt = Date()
            return
        }

        NSLog("[Watchdog] mpv 停滞 %.0fs，重装后仍未恢复 → 交上层失败三分支", stalledFor)
        lastAdvanceAt = Date()
        handleMpvError("播放停滞：mpv 位置超过 \(Int(Self.stallTimeoutSec)) 秒没有推进")
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
    ///
    /// 不只是内部用：换音源（锚定 / 源钉）时 `PlaybackService.reloadCurrentTrack` 要在
    /// **清本地缓存之前**先掐掉在飞下载（hw `OfflineCache.cancelDownload` 同口径）——
    /// 否则那次下载会在随后的解析等待里把旧音源字节重新落盘，evict 等于白做。
    func cancelCacheTasks() {
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

    /// 把音频会话**完整**改回我们设的那一份（.playback / .default / 无 options）。
    ///
    /// 为什么不能只 setActive：libmpv 的 ao=audiounit 为了不打断其它 App，会自己把
    /// 会话改成 `.playback + mixWithOthers`（日志里 opts=1、mode=MoviePlayback），
    /// 而 mixWithOthers 会让 iOS 把本 App 判成「次要音频」→ 不参与 Now Playing →
    /// 锁屏 / 控制中心 / 灵动岛**整个媒体面板都不出现**。
    /// 改动 options 必须 setCategory，且改 category 会作废激活 —— 顺序只能是
    /// 先 setCategory 再 setActive。
    private func reassertPlaybackSession(reason: String) {
        let session = AVAudioSession.sharedInstance()
        // 会话本来就对（含已激活）就什么都不做：seek 拖动每帧一次，重复 setCategory
        // 会重配音频输出、把声音拖出毛刺。
        if session.category == .playback, session.mode == .default,
           session.categoryOptions.isEmpty, isActivated {
            return
        }
        try? session.setCategory(.playback, mode: .default, options: [])
        // 按实际结果维护：无条件置 true 会让 activateIfNeeded() 直接短路，
        // 之后真被系统吊销会话也再没人去激活（以前踩过「永远没声音」）
        isActivated = (try? session.setActive(true)) != nil

        let now = Date()
        guard now.timeIntervalSince(lastReassertDiagAt) >= Self.reassertDiagInterval else { return }
        lastReassertDiagAt = now
        // 是否真改回来了，看 logNowPlayingDiagnostics 的 opts= / mode= / sessionRestored=
        NSLog("%@", "[AudioSession/reassert] reason=\(reason) activated=\(isActivated)"
            + " opts=\(session.categoryOptions.rawValue) mode=\(session.mode.rawValue)")
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
            // 来电 / 其它 App 抢焦点：真的落在 mpv 上（mpv 不接管音频会话，必须自己转发）
            mpv?.pause()
            reportPlaying(false)
            updateNowPlaying()   // 立刻把 playbackState/rate 落到暂停，锁屏图标才跟着变
        case .ended:
            // 不自动恢复播放（对齐 Android 的保守策略：是否继续由用户按播放决定），
            // 但**必须复位音频会话**：系统在打断期间把 AVAudioSession 置为非激活，
            // 而 isActivated 还停在 true → activateIfNeeded() 之后永远短路 →
            // 挂断电话再按播放完全没声音（真机复现过）。
            isActivated = false
            activateIfNeeded()
            reportPlaying(false)
            updateNowPlaying()
            break
        @unknown default:
            break
        }
    }

    /**
     * 音频服务被重置（系统回收音频守护进程 / 设置 → 开发者 → Reset Media Services）：
     * 旧的 session 配置、「已激活」标记、以及 **libmpv 的 audiounit 输出全部作废**。
     *
     * 只 pause 是不够的：mpv 的输出模块绑的是被系统杀掉的那个音频进程，句柄还活着的旧核心
     * 再也出不了声 —— 所以这里必须**重建 MpvPlayer**。
     * 官方同时要求重置后不得自动恢复播放：新核心只把原来的文件与位置装回去并**保持暂停**，
     * 让用户自己按播放。
     */
    @objc private func handleMediaServicesReset(_ note: Notification) {
        EngineThread.onMain { [weak self] in
            guard let self else { return }
            NSLog("%@", "[AudioSession] 音频服务被系统重置，重新初始化会话并重建播放核心")
            self.isActivated = false
            self.activateIfNeeded()
            self.playingIntent = false
            self.rebuildMpvCore()
            self.reportPlaying(false)
            self.updateNowPlaying()
        }
    }

    /// 音频服务重置后重建 mpv 核心（不改播放意图、不自动起播）。
    private func rebuildMpvCore() {
        let resumeAt = max(0, mpv?.currentTime ?? 0)
        let old = mpv
        mpv = nil
        // 旧核心必须彻底收尾：事件线程 + 句柄一起销毁，否则它会在后台继续吃着失效的输出
        old?.shutdown()
        do {
            let fresh = try MpvPlayer()
            wire(fresh)
            mpv = fresh
            stallRecoveries = 0
            lastAdvanceAt = Date()
            lastAdvancePosition = resumeAt
            NSLog("[AudioSession] 已重建 libmpv 核心，待续位置=%.1fs（保持暂停）", resumeAt)
            // 把原来那首装回去（paused-for-cache / 分辨率等全部重新协商），但不自动出声
            if tracks.indices.contains(currentIndex) {
                let src = resolveSource(for: tracks[currentIndex])
                fresh.load(url: src.url, headers: src.headers, startAt: resumeAt, autoplay: false)
            }
        } catch {
            NSLog("[AudioSession] 重建 libmpv 失败：%@", error.localizedDescription)
            events?.emitError(message: "音频服务重置后无法重建播放核心：\(error.localizedDescription)")
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
            // 拔耳机（含拔 USB/断开车载音频）：暂停到 mpv，且**绝不自动续播**
            // （对齐 Android 与旧 AVPlayer 行为；这里没有任何恢复分支，用户按播放才继续）
            mpv?.pause()
            reportPlaying(false)
            updateNowPlaying()
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

    /// Now Playing 的三态 + 停止。
    ///
    /// ⚠️ 系统的 MPNowPlayingPlaybackState **没有 buffering** 这一档，所以缓冲映射成
    /// 「playbackState = .playing + PlaybackRate = 0」：图标留在播放侧（否则锁屏/灵动岛
    /// 按钮会自己翻成 ▶️，看到的和实际不符），进度条因为 rate=0 停止推算。
    private enum NowPlayingPlayback {
        case playing
        case buffering
        case paused
        case stopped
    }

    /// 当前该往系统报哪一态。
    ///
    /// 判据是**播放意图 + mpv 是否真的在出流**：意图为播放但 mpv 还没出流（装载中 /
    /// paused-for-cache / core-idle）一律算缓冲，绝不落成 paused —— paused 会让系统把
    /// 锁屏按钮画成「播放」，这正是「点了没反应」这类观感的来源。
    private func currentNowPlayingPlayback() -> NowPlayingPlayback {
        guard tracks.indices.contains(currentIndex) else { return .stopped }
        guard playingIntent else { return .paused }
        guard let mpv = mpv else { return .paused }
        // 核心已经回到 idle（stop / 无文件）：报 stopped，别让锁屏停留在暂停面板的推算上
        if mpv.state == .idle { return playingIntent ? .buffering : .stopped }
        return mpv.state == .playing ? .playing : .buffering
    }

    /// 把三态落到 Now Playing 的两件套：playbackState（图标）+ PlaybackRate（进度推算）
    private func applyNowPlayingPlayback(_ playback: NowPlayingPlayback, to info: inout [String: Any]) {
        switch playback {
        case .playing:
            nowPlaying.playbackState = .playing
            info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
        case .buffering:
            nowPlaying.playbackState = .playing
            info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
        case .paused:
            nowPlaying.playbackState = .paused
            info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
        case .stopped:
            nowPlaying.playbackState = .stopped
            info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
        }
    }

    /// 写 Now Playing 元数据 —— 锁屏、控制中心、灵动岛、CarPlay 面板的**唯一数据源**。
    ///
    /// 职责：元数据（曲名/歌手/封面/时长）+ playbackState + 一次立即的进度落点。
    /// 高频进度不在这里推，由 writeNowPlayingProgress 按 1s 节流跟进。
    private func updateNowPlaying() {
        lastNowPlayingProgressAt = Date()

        guard tracks.indices.contains(currentIndex) else {
            nowPlaying.nowPlayingInfo = nil
            nowPlaying.playbackState = .stopped
            refreshRemoteCommandAvailability()
            return
        }
        let track = tracks[currentIndex]
        let playback = currentNowPlayingPlayback()
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPMediaItemPropertyPlaybackDuration: Double(max(1, currentItemDurationMs())) / 1000.0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: max(0, mpv?.currentTime ?? 0),
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        // playbackState 与 PlaybackRate 成对写：rate 跟真实播放态走，不再恒等于播放意图
        applyNowPlayingPlayback(playback, to: &info)
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

    /// **time-pos 驱动**的进度回写（约 1s 节流）。
    ///
    /// AVPlayer 时代是一招「一次性写 PlaybackRate=1.0 让系统自己往后推算 + 每 10s 校准」，
    /// mpv 下这条不成立：seek 后推算起点没跟上、缓冲期间推算照走、换源后时长也变，
    /// 10s 的校准窗口太粗 —— 表现就是「锁屏进度条和实际播放位置对不上」。
    /// 现在订阅 mpv 的 time-pos，按 1s 节流把**真实位置**正面写回，Rate 与真实播放态一致。
    ///
    /// 只在已有 nowPlayingInfo 上做增量覆盖：封面这类重字段不碰，省掉无谓重绘。
    private func writeNowPlayingProgress(elapsed seconds: Double) {
        guard tracks.indices.contains(currentIndex), var info = nowPlaying.nowPlayingInfo else { return }
        let now = Date()
        guard now.timeIntervalSince(lastNowPlayingProgressAt) >= Self.nowPlayingProgressInterval else { return }
        lastNowPlayingProgressAt = now
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, seconds)
        info[MPMediaItemPropertyPlaybackDuration] = Double(max(1, currentItemDurationMs())) / 1000.0
        applyNowPlayingPlayback(currentNowPlayingPlayback(), to: &info)
        nowPlaying.nowPlayingInfo = info
        // 进度路径节流到 5s 一条（1s 一条会把日志刷爆）
        if now.timeIntervalSince(lastProgressDiagAt) >= Self.progressDiagInterval {
            lastProgressDiagAt = now
            logNowPlayingDiagnostics(reason: "progress")
        }
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
        let hasTitle = info?[MPMediaItemPropertyTitle] != nil
        let hasDuration = info?[MPMediaItemPropertyPlaybackDuration] != nil
        let hasElapsed = info?[MPNowPlayingInfoPropertyElapsedPlaybackTime] != nil
        let hasArtwork = info?[MPMediaItemPropertyArtwork] != nil
        let num: (Double) -> String = { String(format: "%.1f", $0) }
        let yn: (Bool) -> String = { $0 ? "Y" : "N" }
        // 一段一段拼：单个巨型字符串插值表达式过不了类型检查（编译超时）。
        var parts: [String] = []
        // AVFoundation 没有公开的 session.isActive：用本类维护的 isActivated
        // （每次 setActive 成功才置 true）作为"会话是否活着"的等价信号。
        parts.append("isActive(self)=\(isActivated)")
        parts.append("cat=\(session.category.rawValue)")
        parts.append("mode=\(session.mode.rawValue)")
        parts.append("opts=\(session.categoryOptions.rawValue)")
        // 对照：opts=1 / mode≠default 就是「还被 mpv 改着」→ 肯定没有 Now Playing 面板
        let sessionRestored = session.category == .playback
            && session.mode == .default
            && session.categoryOptions.isEmpty
        parts.append("sessionRestored=\(yn(sessionRestored))")
        parts.append("playbackState=\(nowPlaying.playbackState.rawValue)")
        parts.append("intent=\(playingIntent ? "play" : "pause")")
        parts.append("title=\(yn(hasTitle))[\(title)]")
        parts.append("dur=\(yn(hasDuration))(\(num(duration)))")
        parts.append("elapsed=\(yn(hasElapsed))(\(num(elapsed)))")
        parts.append("artwork=\(yn(hasArtwork))")
        parts.append("rate=\(num(rate))")
        parts.append("cmd.play=\(center.playCommand.isEnabled)")
        parts.append("cmd.pause=\(center.pauseCommand.isEnabled)")
        parts.append("cmd.next=\(center.nextTrackCommand.isEnabled)")
        parts.append("app=\(UIApplication.shared.applicationState.rawValue)")
        // 一行输出，方便 grep，也方便 log show / Console.app 抓。
        // 必须是 NSLog：print 只进 stdout，log show 抓不到（回归排查就卡在这里）。
        NSLog("%@", "[NowPlaying/\(reason)] " + parts.joined(separator: " "))
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
