/**
 * 播放内核（从 `SuenAudioPlugin.swift` 抽出，**去掉了 Capacitor 依赖**）。
 *
 * 原生化之后它不再向 JS 发事件，而是通过 `AudioEngineEvents` 回调给 UI 层。
 * 队列接续、Now Playing / 锁屏、音频中断、stall 看门狗、`mediaServicesWereReset`
 * 这些逻辑**原样保留** —— 那是两轮真机排障攒下来的，不要重写。
 */

import Foundation
import AVFoundation
import MediaPlayer
// CryptoKit 提供 Insecure.SHA1（封面文件名摘要用；原来靠外部库，原生化后改系统框架）
import CryptoKit

/// 播放内核向 UI 上报的事件（替代原来的 Capacitor `notifyListeners`）。
protocol AudioEngineEvents: AnyObject {
    func emitProgress(index: Int, positionMs: Int, durationMs: Int, playing: Bool)
    func emitTrackChange(index: Int, id: String, reason: Int)
    func emitState(playing: Bool)
    func emitError(message: String)
}

/// 线程助手：内核里大量「先切回主线程再动 player / Now Playing」的调用点。
enum EngineThread {
    static func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) }
    }

    /// 延迟在主线程执行（起播等 ready 的轮询、兜底重试用）
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

    /// 播放模式：字符串与 hw `MediaPlayerCore.PLAY_MODES` 完全一致
    /// `['order','shuffle','repeat-one','list-loop','shuffle-once']`
    enum RepeatMode: String {
        case order
        case shuffle
        case repeatOne = "repeat-one"
        case listLoop = "list-loop"
        case shuffleOnce = "shuffle-once"

        var isShuffle: Bool { self == .shuffle || self == .shuffleOnce }
    }

    private weak var events: AudioEngineEvents?
    private let player = AVQueuePlayer()
    private var timeObserver: Any?

    /// KVO token **必须持有**。
    ///
    /// `observe(_:options:changeHandler:)` 返回的 `NSKeyValueObservation` 一旦
    /// 释放就立刻 `invalidate()` —— 观察者静默失效：不报错、不崩溃、不打印，
    /// 只有编译器那句 "result of call ... is unused" 在提示。
    /// 之前漏了这一步，直接后果是 `state` 事件从头到尾一次都没发出，而 Web 端的
    /// `playing` 状态与播放上报开关**全部**挂在这一个事件上。
    private var observations: [NSKeyValueObservation] = []

    /// `state` 去重：只在有效播放状态**变化**时上报，避免缓冲抖动把 UI 刷成闪烁。
    private var lastReportedPlaying: Bool?

    private(set) var tracks: [SuenTrack] = []
    private var itemIndex: [ObjectIdentifier: Int] = [:]
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

    /// 程序化换条目期间抑制 KVO 自动发 trackChange（手动发的带 reason=SEEK）
    private var suppressTransitionEvent = false
    private var lastCurrentItem: AVPlayerItem?
    private var reportedFailures: Set<ObjectIdentifier> = []
    private var isActivated = false

    private let nowPlaying = MPNowPlayingInfoCenter.default()
    private var remoteCommandsInstalled = false
    /// `addTarget` 的返回 token。持有它既是为了将来能干净卸载，
    /// 也是因为"注册了但没拿到句柄"和"没注册"在现象上无法区分。
    private var remoteCommandTargets: [Any] = []
    private var artworkCache: [String: MPMediaItemArtwork] = [:]
    private var lastNowPlayingUpdate = Date.distantPast

    /// 播放**意图** —— 锁屏 / 控制中心 / 灵动岛的按钮与进度条只看这一个值。
    ///
    /// 绝不能用 `player.rate` 代替：`automaticallyWaitsToMinimizeStalling` 打开后，
    /// 缓冲等待期间 rate 会掉到 0（日志里 index 11 那段 `MEDIA_PLAYBACK_STALL`
    /// 就是活例）—— 用 rate 判定会把"正在缓冲"错报成"已暂停"，锁屏按钮随即来回跳。
    private var playingIntent = false

    // MARK: 停顿看门狗状态
    /// 待执行的看门狗任务（10 秒没进场就自愈一次）
    private var stallWatchdog: DispatchWorkItem?
    /// 本轮连续 stall 的尝试次数（进 .playing 就清零）
    private var stallRetries = 0

    /// Now Playing 自检日志开关。
    ///
    /// 锁屏 / 灵动岛是**系统渲染**的界面，代码到底有没有生效无法从屏幕直接读出来。
    /// 只有 Xcode、没有真机的阶段，这行日志是唯一能自证"数据源已就绪"的手段。
    /// 真机验收通过后可以关掉。
    private var nowPlayingDebugLog = true
    /// 等 item ready 的最多轮数（100ms 一轮 → 3s）
    private static let playReadyMaxTries = 100   // 100 × 100ms = 10s：冷曲目首拉实测要 9-10s 才 ready
    private var playAttempts = 0
    /// 每个 AVPlayerItem 的 status 观察（随条目创建/丢弃增删）
    private var itemObservations: [NSKeyValueObservation] = []
    /// startPlayback 的起算时刻（用于打印「item 多久才 ready」）
    private var playbackStartedAt: Date?
    private var playRetries = 0
    /// 起播后进度持续为 0 的 tick 计数（2s/tick）与重载次数
    private var zeroProgressTicks = 0
    private var zeroProgressReloads = 0

    init(events: AudioEngineEvents) throws {
        self.events = events
        super.init()

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true)
        isActivated = true

        player.actionAtItemEnd = .none
        // 关掉"先评估缓冲速率再起播"：上游是本地回环代理（或直连 CDN），
        // 不需要它算带宽；开着时对 B 站 fMP4 会长期停在
        // AVPlayerWaitingWhileEvaluatingBufferingRateReason（进度条不动）。
        player.automaticallyWaitsToMinimizeStalling = false

        // 进度心跳：500ms，对齐 Android TICK_MS
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            self?.onProgressTick(time)
        }
        // KVO 回调的线程 = 改属性的那个线程。AVFoundation 会在自己的内部队列上
        // 改 currentItem（自动接续）和 timeControlStatus（起播/缓冲/暂停），所以
        // 不能假定是主线程 —— 先把值取出来，再切主线程处理。
        //
        // ⚠️ 返回值必须 append 进 `observations`，否则观察者立刻失效（见属性注释）。
        observations.append(player.observe(\.currentItem, options: [.new]) { [weak self] player, _ in
            let item = player.currentItem
            EngineThread.onMain { [weak self] in
                self?.onCurrentItemChanged(item)
            }
        })
        // 这个 KVO 只做两件事：① 真正进入 .playing 时补一次状态；② 跌回 .paused 时
        // 检查"条目是不是真的挂了"。普通暂停**不由它上报**（理由见 .paused 分支）。
        // 不用 rate 是因为缓冲等待时 rate 也会掉到 0，那会造成卡顿瞬间的假暂停。
        observations.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            switch player.timeControlStatus {
            case .playing:
                EngineThread.onMain { [weak self] in
                    self?.cancelStallWatchdog()
                    self?.reportPlaying(true)
                }
            case .paused:
                EngineThread.onMain { [weak self] in
                    // 这里**不报**"暂停"：队列重建期间 AVFoundation 会短暂跌回 paused，
                    // 而该回调是异步切回主线程的，可能在 startPlayback() 之后才到 ——
                    // 那样会把刚起播的状态又刷成暂停（UI 闪一下）。
                    // 暂停一律由 play/pause/stop/中断/曲末这些**意图明确**的路径上报。
                    // 只有"条目真的挂了"这种意外停止，才必须在这里补一次状态纠正。
                    self?.reportCurrentItemFailureIfNeeded(andStop: true)
                }
            case .waitingToPlayAtSpecifiedRate:
                /**
                 * 播放意图仍在（只是在等缓冲）→ 不上报状态，保持 UI 的"播放中"。
                 *
                 * 但**必须起看门狗**：我们起播走 `playImmediately(atRate:)`，
                 * 官方文档写明这种情况下缓冲不足只表现为 stall、**不会 post
                 * `playbackStalledNotification`** —— 想靠通知兜底是死路。
                 * 再叠加 `automaticallyWaitsToMinimizeStalling = false`（缓冲抽干即
                 * stall、rate→0，恢复责任在 App），不主动重试就是"永远卡住"。
                 */
                EngineThread.onMain { [weak self] in self?.armStallWatchdog() }
            @unknown default:
                break
            }
        })
        NotificationCenter.default.addObserver(
            self, selector: #selector(itemDidEnd(_:)),
            name: .AVPlayerItemDidPlayToEndTime, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(itemFailed(_:)),
            name: .AVPlayerItemFailedToPlayToEndTime, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification, object: nil)
        /**
         * 音频服务被系统重启（系统回收音频守护进程、或 设置 → 开发者 → Reset Media Services）。
         *
         * 官方要求：重新初始化音频对象、重设 category/mode/options，并且
         * **在用户操作前不得自动恢复播放**。之前全仓没有任何处理 —— 表现为
         * reset 之后彻底没声音、session 配置丢失，只能杀 App 重开。
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
        // 只注册 `MPRemoteCommandCenter` 的 target **不够** —— 系统还要靠这个调用
        // 建立"远程控制事件路由到本 App"的关系。缺了它，锁屏 / 控制中心 / 灵动岛
        // 压根不会把"正在播放"面板挂到我们头上，target 也永远收不到回调
        // （按钮不出现、或出现但点了没反应）。
        //
        // 必须在主线程调用；`AudioEngine` 只在 `setQueue` 的 main.async 里创建，
        // 这里天然在主线程，但仍显式断言一次，避免以后被人挪到后台队列。
        precondition(Thread.isMainThread, "beginReceivingRemoteControlEvents 必须在主线程调用")
        UIApplication.shared.beginReceivingRemoteControlEvents()

        logNowPlayingDiagnostics(reason: "engine-init")
    }

    deinit {
        if let timeObserver = timeObserver {
            player.removeTimeObserver(timeObserver)
        }
        observations.forEach { $0.invalidate() }
        observations.removeAll()
        player.pause()
    }

    // MARK: 队列操作

    func setQueue(baseUrl: String, token: String, tracks: [SuenTrack],
                  startIndex: Int, startPositionMs: Int,
                  autoplay: Bool, tailOnly: Bool) throws {
        NSLog("[Start] setQueue 进入 autoplay=\(autoplay) startIndex=\(startIndex) tracks=\(tracks.count) tokenLen=\(token.count)")
        self.baseUrl = normalizedBase(baseUrl)
        self.sessionToken = token
        logicalIndex = startIndex
        // ⚠️ 必须配置本地代理（2026-10-25 修的断线）：
        // 旧仓 2026-09-26 实测过「服务端对带 Range 的请求按码率限速（下限 40KB/s），
        // AVFoundation 在 40KB/s 下打不开 B 站 fMP4，永远停在 EvaluatingBufferingRate」。
        // 修法是让播放**走本地代理**，而代理的首次整卡拉取不带 Range（服务端对无 Range 的全量下载不节流）。
        // 这里一直漏了 configure → 代理 upstreamBase 为空 → 播放全程直连 → 被限速 → 点了不出声。
        LocalStreamProxy.shared.configure(base: self.baseUrl, token: token)

        suppressTransitionEvent = true
        defer { suppressTransitionEvent = false }

        /**
         * tailOnly 的前提：当前项已知、且逻辑下标 < startIndex（这样才谈得上
         * "只替换当前项之后的部分，不动正在播的这首"）。
         *
         * 前提不成立时必须**把尾段拼回全量**再走下面的整队重建：
         * `tracks` 参数只是 [startIndex, end) 这一段，而 startIndex 是全 Web 索引 ——
         * 直接拿它当全量，`self.tracks[idx]` 会取到错的歌，idx 越界还会崩
         *（重审 F；旧实现就是这么错的）。
         */
        var effectiveTracks = tracks
        if tailOnly {
            let currentLogical = player.currentItem.flatMap { itemIndex[ObjectIdentifier($0)] }
            let canTail = !self.tracks.isEmpty
                && currentLogical != nil
                && currentLogical! < startIndex
                && currentLogical! < self.tracks.count
            if !canTail {
                if startIndex <= self.tracks.count {
                    effectiveTracks = Array(self.tracks[0 ..< startIndex]) + tracks
                } else {
                    effectiveTracks = tracks
                }
                NSLog("%@", "[setQueue] tailOnly 前提不成立，拼回全量后整队重建 "
                    + "(startIndex=\(startIndex), tracks=\(tracks.count), "
                    + "logical=\(self.tracks.count) → \(effectiveTracks.count))")
            }
        }

        if tailOnly, !self.tracks.isEmpty, let current = player.currentItem,
           let currentLogical = itemIndex[ObjectIdentifier(current)],
           currentLogical < startIndex {
            // 只重排 [startIndex, 队尾)：此路径下 tracks 参数只含尾段。
            // 把 player 队列里当前条目之后的全部替换掉 —— 正在播的那首不在替换
            // 范围内 → 不重新装载 → 切播放模式不再"卡一下"
            //（对齐 Android replaceMediaItems 行为）。
            //
            // ⚠️ 但**逻辑队列尾段必须跟着换**：Web 的「切随机 / 切回列表」走的正是
            // 这条路径，传进来的 tracks 已是新顺序。若 self.tracks 保持旧顺序，
            // `itemIndex` 记下的 startIndex+offset 就会映射到旧顺序的曲目上 ——
            // 表现为切随机后 trackChange 带错 id、锁屏"下一首"播错歌、封面标题错位。
            if startIndex <= self.tracks.count {
                self.tracks = Array(self.tracks[0 ..< startIndex]) + tracks
            } else {
                self.tracks = tracks   // 防御：startIndex 越界时以传入为准
            }
            let queue = player.items()
            if let pos = queue.firstIndex(of: current) {
                for stale in queue[(pos + 1)...] {
                    itemIndex.removeValue(forKey: ObjectIdentifier(stale))
                    player.remove(stale)
                }
            }
            var lastInserted = current
            for (offset, track) in tracks.enumerated() {
                let item = makeItem(for: track)
                itemIndex[ObjectIdentifier(item)] = startIndex + offset
                player.insert(item, after: lastInserted)
                lastInserted = item
            }
            // 对齐 Android：tailOnly 路径不动播放状态（不 seek、不 play）
            lastCurrentItem = player.currentItem
            return
        }

        // 整队列重发：全量重建。player 队列装载 [startIndex, 队尾) 全部条目，
        // 由 AVQueuePlayer 原生接续，锁屏熄屏不依赖 JS 唤醒。
        self.tracks = effectiveTracks
        player.removeAllItems()
        itemIndex.removeAll()
        let start = min(max(0, startIndex), max(0, effectiveTracks.count - 1))
        var previous: AVPlayerItem?
        for i in start..<effectiveTracks.count {
            let item = makeItem(for: effectiveTracks[i])
            itemIndex[ObjectIdentifier(item)] = i
            player.insert(item, after: previous)
            previous = item
        }
        if startPositionMs > 0 {
            player.seek(to: CMTime(seconds: Double(startPositionMs) / 1000.0, preferredTimescale: 600))
        } else {
            player.seek(to: .zero)
        }
        if autoplay {
            startPlayback()
        }
        lastCurrentItem = player.currentItem
        updateNowPlaying()
    }

    /// 起播 / 暂停 / 停止都只调 `reportPlaying`，由它统一负责
    /// ① 写播放意图 ② 发 state 事件 ③ 刷新 Now Playing。
    /// 三条出口各写一遍是之前 Now Playing 状态不同步的根因，不要再拆散。
    func play() {
        activateIfNeeded()
        if player.rate == 0 {
            // 条目处于末尾（播放自然结束后的重播）则先归零
            if let item = player.currentItem, item.currentTime() >= item.duration, item.duration > CMTime.zero {
                player.seek(to: .zero)
            }
            player.playImmediately(atRate: 1.0)
        }
        // 无论走没走进上面的分支都表一次"要播"。去重后不会重复发事件，
        // 但能保证"用户按了播放"这件事一定被 Web 端听到。
        reportPlaying(true)
    }

    func pause() {
        player.pause()
        reportPlaying(false)
    }

    func stop() {
        player.pause()
        reportPlaying(false)
    }

    func seek(to positionMs: Int) {
        let seconds = max(0, Double(positionMs) / 1000.0)
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
        updateNowPlaying()
    }

    /// 语义对齐 Android：目标就是当前条目且非故障态 → **不动位置**（选中 ≠ 从头播）；
    /// force 或越界态才从头重载。其余情况重建 player 队列（等价 Media3 的 seekTo+prepare）。
    func seekToIndex(_ index: Int, autoplay: Bool, force: Bool) {
        let sameItem = player.currentItem.flatMap { itemIndex[ObjectIdentifier($0)] } == index
        let atEnd: Bool = {
            guard let item = player.currentItem else { return true }
            return item.duration > CMTime.zero && item.currentTime() >= item.duration
        }()
        if sameItem && !force && !atEnd {
            if autoplay { play() }
            return
        }
        rebuildQueue(from: index, positionMs: 0, autoplay: autoplay, reason: 2)
    }

    /// 换音源硬重载：停掉 → 重建条目（新 URL + 丢缓冲）→ 定位 → 出声
    ///
    /// 实现上**直接整队重建**（从 index 起到队尾），而不是"删掉当前项再插一条新的"。
    ///
    /// 为什么：AVQueuePlayer 只有 `insert(_:after:)`，没有 `insert(at:)`。旧实现
    /// 先 `remove(current)`，此时 currentItem 已经变成**下一首**，再把 fresh 插到
    /// `queue[pos-1]`（已经播过的上一首）之后 —— fresh 落在当前播放位置之前，
    /// 永远不会成为 currentItem，随后的 seek / startPlayback 全打在下一首上：
    /// 用户看到「换了音源，结果开始播下一首」。
    ///
    /// 重建虽然会连带重建尾段条目（丢掉 next 的预缓冲），但换音源本来就是
    /// 「丢缓冲重来」的语义，代价可接受，换来的是确定性。
    func reloadCurrent(index: Int, positionMs: Int, autoplay: Bool) {
        guard tracks.indices.contains(index) else { return }
        rebuildQueue(from: index, positionMs: positionMs, autoplay: autoplay, reason: 2)
    }

    func setRepeatMode(_ mode: String) {
        repeatMode = RepeatMode(rawValue: mode) ?? .order
        rebuildPlayOrder(startingAt: currentIndex)
        // 模式决定"队尾还有没有下一首"：off→all 会让锁屏的"下一首"从灰变亮
        refreshRemoteCommandAvailability()
    }

    // MARK: 队列变更（播放页的队列抽屉：跳播 / 删除 / 拖拽排序）
    //
    // 数据源永远是内核的 `tracks`（UI 只拿快照、只发意图）；下标语义照 hw
    // `MediaPlayerCore.jumpTo / removeAt / moveItem` 逐条对齐。

    /// 队列逻辑快照（Swift 数组是值类型，UI 拿到的是副本，改不动内核）
    var queueSnapshot: [SuenTrack] { tracks }

    /// 跳到指定下标并（可选）起播（hw `jumpTo`）：点的是当前曲 = 从头再来
    func jumpTo(_ index: Int, autoplay: Bool) {
        guard tracks.indices.contains(index) else { return }
        if index == currentIndex {
            seek(to: 0)
            if autoplay { play() }
            return
        }
        rebuildQueue(from: index, positionMs: 0, autoplay: autoplay, reason: 2)
    }

    /// 摘除队列里的一项（hw `removeAt` 的内核侧）。
    ///
    /// 返回 true = 被摘的正是当前曲，**调用方必须立刻装载新的当前曲**：本方法只把属于
    /// 它的条目从播放器里摘掉并暂停，绝不自行接续（否则会出现"删掉 A 却在放 B"）。
    @discardableResult
    func removeQueueItem(at index: Int) -> Bool {
        guard tracks.indices.contains(index) else { return false }
        let wasCurrent = index == currentIndex
        if wasCurrent { player.pause() }
        // ① 先按**旧**下标挑出要摘的条目：itemIndex 以 ObjectIdentifier 为键，
        //    下标改完就再也找不回条目了（顺序错了会留下占位的幽灵条目）。
        var victims: [AVPlayerItem] = []
        for item in player.items() where itemIndex[ObjectIdentifier(item)] == index {
            victims.append(item)
        }
        let victimKeys = Set(victims.map { ObjectIdentifier($0) })
        for item in victims {
            player.remove(item)
            reportedFailures.remove(ObjectIdentifier(item))
        }
        // ② 逻辑队列摘除 + 剩余条目下标整体前移一位
        tracks.remove(at: index)
        var remapped: [ObjectIdentifier: Int] = [:]
        for (key, logical) in itemIndex where !victimKeys.contains(key) {
            remapped[key] = logical > index ? logical - 1 : logical
        }
        itemIndex = remapped
        if insertedThrough >= index { insertedThrough -= 1 }
        return wasCurrent
    }

    /// 队列内移动一项（hw `moveItem`，拖拽排序）。
    ///
    /// AVQueuePlayer 的接续顺序由**实际入队顺序**决定，光挪逻辑数组会让"下一首"还是
    /// 旧顺序（高亮 A、接续 B）—— 所以按新序就地重建，保留当前曲、进度与播放意图。
    func moveQueueItem(from: Int, to: Int) {
        guard tracks.indices.contains(from), tracks.indices.contains(to), from != to else { return }
        let current = currentIndex
        let seconds = player.currentTime().seconds
        let positionMs = seconds.isFinite ? max(0, Int(seconds * 1000)) : 0
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
        rebuildQueue(from: min(max(0, newIndex), max(0, tracks.count - 1)),
                     positionMs: positionMs, autoplay: wasPlaying, reason: 2)
    }

    func statusSnapshot() -> [String: Any] {
        let positionMs = Int(player.currentTime().seconds * 1000)
        let duration = currentItemDurationMs()
        return [
            "index": currentIndex,
            "positionMs": max(0, positionMs),
            "durationMs": max(0, duration),
            // 用**播放意图**而不是瞬时 rate：缓冲/等待时 rate 会是 0，
            // 而 Web 的 restoreSession 拿它判断"是否该恢复播放"，一缓冲就误判成暂停、
            // 把队列重置掉（重审 F）。
            "playing": playingIntent,
            "queueLength": tracks.count,
        ]
    }

    // MARK: 私有：队列构建

    /// 重建 player 队列使其从 index 开始（等价 Media3 的 seekTo(index) + prepare）。
    /// reason: 1=AUTO（repeat all 环绕接续） 2=SEEK
    private func rebuildQueue(from index: Int, positionMs: Int, autoplay: Bool, reason: Int) {
        guard tracks.indices.contains(index) else { return }
        if reason == 2 {
            consecutiveErrors = 0
        }
        suppressTransitionEvent = true
        logicalIndex = index

        player.removeAllItems()
        itemIndex.removeAll()
        insertedThrough = index - 1
        // ⚠️ 惰性装载（2026-10-25 修「点了不出声」）：
        // 原来一次性 insert 队列里全部 40 首，每首都要 AVFoundation 准备，实测在模拟器要 10s+，
        // 而 startPlayback() 在这循环之后才调用 —— 于是"点的那首半天不出声"。
        // 现在只装当前 + LOOKAHEAD 首，其余在播放推进时按需补（见 ensureLookahead()）。
        ensureLookahead()
        // 无条件 seek：AVQueuePlayer 的时间轴是全局的，换条目后不归零会承接上一首的
        // 位置 —— 上一首 4:19 结束、下一首从 4:20 继续走，但新的 item 并没有起播。
        player.seek(to: CMTime(seconds: Double(max(0, positionMs)) / 1000.0, preferredTimescale: 600))
        NSLog("[Start] rebuildQueue 结束 autoplay=\(autoplay) items=\(player.items().count) intent=\(playingIntent)")
        if autoplay { startPlayback() }

        suppressTransitionEvent = false
        lastCurrentItem = player.currentItem
        updateNowPlaying()
        events?.emitTrackChange(index: index, id: tracks[index].id, reason: reason)
    }

    /// 曲末接续决策（原生侧，熄屏可靠）：
    ///   - repeat one：原地归零重播（不发 trackChange，不是切歌）
    ///   - 队列中：advanceToNextItem，KVO 检测后发 trackChange(reason=1)
    ///   - repeat all + 队尾：整队列环绕重建
    ///   - repeat off + 队尾：停在末尾（等价 Media3 STATE_ENDED）
    @objc private func itemDidEnd(_ note: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  let item = note.object as? AVPlayerItem else { return }
            guard ObjectIdentifier(item) == self.currentItemKey() else {
                // 旧条目的迟到通知，忽略
                return
            }
            guard let idx = self.itemIndex[ObjectIdentifier(item)] else { return }

            if self.repeatMode == .repeatOne {
                NSLog("[Loop] repeat-one 命中 idx=\(idx) dur=\(self.currentItemDurationMs()) 源=\(self.durationSource())")
                // 单曲循环：**重建条目**而不是 seek(0)。
                // seek 会留下两个问题（用户实测）：① 时间基已到末尾，周期观察者不再回调 → 进度条卡在结尾；
                // ② 音源长度与元数据不一致时，条目仍报旧时长。
                // 重建 = 新条目 + seek 0 + 起播，时间轴和时长都会重新解析。
                self.rebuildQueue(from: idx, positionMs: 0, autoplay: true, reason: 2)
                return
            }

            // 接续统一走「播放顺序表」：非随机 = 原序（与旧行为一致），
            // 随机 / 随机不重复由 playOrder 决定下一首是谁。
            if let next = self.nextLogicalIndex() {
                if next == idx + 1 && self.player.items().count > 1 && !self.repeatMode.isShuffle {
                    self.player.advanceToNextItem()
                    self.onCurrentItemChanged(self.player.currentItem)
                } else {
                    self.rebuildQueue(from: next, positionMs: 0, autoplay: true, reason: 1)
                }
            } else {
                // 顺序播完 / 随机不重复播完：停在末尾（等价 Media3 STATE_ENDED）
                self.player.pause()
                self.reportPlaying(false)
            }
        }
    }

    private var consecutiveErrors = 0
    private static let maxConsecutiveErrors = 5

    // MARK: 停顿看门狗

    /**
     * 起表：`.waitingToPlayAtSpecifiedRate` 持续 10 秒还没进 `.playing` 就自愈。
     *
     * 为什么必须自己看：
     *  - 起播走 `playImmediately(atRate:)`，官方文档写明缓冲不足时**不 post**
     *    `playbackStalledNotification`，靠通知兜底是死路；
     *  - `automaticallyWaitsToMinimizeStalling = false` 的语义是"缓冲抽干即 stall、
     *    rate→0、恢复由 App 负责"，官方没有给恢复流程（阈值是经验值）。
     *
     * 两段式：第一次让在途下载立刻换轨续拉 + 重建当前条目（丢掉可能已死的连接）；
     * 第二次仍不行就按真正的播放失败处理（会向 Web 上报 error）。
     */
    private func armStallWatchdog() {
        cancelStallWatchdog()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.player.timeControlStatus == .waitingToPlayAtSpecifiedRate else { return }
            self.stallRetries += 1
            let positionMs = Int(max(0, self.player.currentTime().seconds) * 1000)
            NSLog("%@", "[Stall] 缓冲停顿超过 10s，第 \(self.stallRetries) 次自愈 \(positionMs)ms")
            if self.stallRetries == 1 {
                AudioCacheStore.shared.retryStalledDownloads()
                self.reloadCurrent(index: self.currentIndex, positionMs: positionMs,
                                   autoplay: self.playingIntent)
            } else {
                self.handlePlaybackFailure()
            }
        }
        stallWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    /// 进 `.playing`（或切歌/暂停）就撤表，并清掉连续 stall 计数。
    private func cancelStallWatchdog() {
        stallWatchdog?.cancel()
        stallWatchdog = nil
        stallRetries = 0
    }

    private func handlePlaybackFailure() {
        consecutiveErrors += 1
        if consecutiveErrors >= Self.maxConsecutiveErrors { consecutiveErrors = 0 }
        // ⚠️ 2026-10-25 对齐 hw：**引擎不许自己跳歌**。
        // 旧实现失败 0.3s 后 rebuildQueue(next, reason: 1) 自动跳 —— 副作用有两层：
        //   ① 把 PlaybackService 的 manualLoad 冲成 false（emitTrackChange(reason:1) 会重置），
        //      于是 hw 那条「手动点播无音源 → 停住 + eyebrow 显示无音源」永远走不到；
        //   ② 用户想锚定的那首被自动切走，永远锚不上（hw 代码里专门写死了这条规则）。
        // hw 的失败策略在服务层（MediaPlayerCore.settleFailure）：手动=停住、连播=600ms 静默跳过、
        // 连续失败=通知+暂停。iOS 侧对应 PlaybackService.settleFailure，这里只负责报告失败。
        reportPlaying(false)
    }

    @objc private func itemFailed(_ note: Notification) {
        // 通知是 `object: nil` 全局注册的，**必须自己校验归属**：
        // AVQueuePlayer 会预取下一首，下一首失败时同样会发这个通知 ——
        // 不过滤就会把正在播的那首当成失败、跳歌，并向 Web 报"当前曲出错"（重审 F）。
        guard let failedItem = note.object as? AVPlayerItem,
              ObjectIdentifier(failedItem) == currentItemKey() else { return }
        let message = (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? NSError)?
            .localizedDescription ?? "播放错误"
        // 与其他音频通知一致：系统可能从内部队列投递，先回主线程再动 player/NowPlaying
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.events?.emitError(message: message)
            self.handlePlaybackFailure()
        }
    }

    // MARK: 私有：播放状态上报

    /// `state` 事件的唯一出口。
    ///
    /// Web 端把 `state` 当 DOM 的 `play`/`pause`/`playing` 用（bridge.ts），
    /// 而 store 的 `playing` 与"播放上报开关"**只**由这三个事件驱动 ——
    /// 这个事件一断，界面就会永远停在错的播放态。
    ///
    /// 语义是**播放意图**，不是瞬时播放状态：起播 / 暂停 / 中断 / 曲末各自显式上报，
    /// 不靠 `rate`、`timeControlStatus` 去反推。瞬时状态会在缓冲与队列重建时抖动，
    /// 拿它驱动 UI 就是闪烁的来源。
    private func reportPlaying(_ playing: Bool) {
        // 这里同时是**播放意图**的唯一写入点。放在去重之前：即使 Web 端已经知道
        // 这个状态（事件被去重吃掉），Now Playing 的 rate 也必须落在正确值上。
        playingIntent = playing
        if playing {
            consecutiveErrors = 0
        }

        guard lastReportedPlaying != playing else { return }
        lastReportedPlaying = playing
        events?.emitState(playing: playing)

        // 意图变了 → 锁屏 / 控制中心 / 灵动岛必须同步。
        // 之前漏了这一步：暂停后 `addPeriodicTimeObserver` 不再回调，
        // `MPNowPlayingInfoPropertyPlaybackRate` 就永远停在最后一次写的 1.0，
        // 系统据此认为"还在播"，锁屏进度条会自顾自地继续往前走。
        updateNowPlaying()
    }

    /// 起播的唯一入口：出声 + 立刻上报播放态。
    ///
    /// 不等 `timeControlStatus` 走完 waiting → playing 再报 —— 否则从用户按下播放
    /// 到按钮变样之间会有一段空窗（网络慢时尤其明显）。
    /**
     * 起播。
     *
     * ⚠️ 2026-10-25 真机 bug：点的那一首永远不出声，跳到下一首才响。
     * 根因：rebuildQueue 在 removeAllItems() 之后立刻 insert + seek + play，而
     * automaticallyWaitsToMinimizeStalling = false 时，对**尚未 ready** 的 item 调 play
     * 会长期停在 waitingToPlayAtSpecifiedRate（不报错、不出声）；跳到下一首等于新建
     * item 再 play 一次，所以能响。
     *
     * 修法：等 currentItem.status == .readyToPlay 再 play（最多 3s）；
     * 起播后 1.2s 仍在 waiting 就重试一次 play（兜底）。
     */
    private func startPlayback() {
        // autoplay 语义 = 用户就是要它现在播：把意图立起来，别让 playWhenReady 的 guard 挡掉
        // （2026-10-25 实测：rebuildQueue 结束时 intent=false，起播被自己的 guard 挡住 → 永远不出声）
        playingIntent = true
        playbackStartedAt = Date()
        playAttempts = 0
        playRetries = 0
        playWhenReady()
    }

    /// 诊断打点（真机排障用）：每 2s 打一次播放器真实状态。
    private var lastDiagAt = Date.distantPast

    private func diagTick(_ positionMs: Int) {
        let now = Date()
        guard now.timeIntervalSince(lastDiagAt) >= 2 else { return }
        lastDiagAt = now
        let item = player.currentItem
        let status = item.map { Int($0.status.rawValue) } ?? -1
        let reason = player.reasonForWaitingToPlay?.rawValue ?? "-"
        let errText = item?.error.map { "\($0)" } ?? "-"
        NSLog("[Diag] tcs=\(player.timeControlStatus.rawValue) item=\(status) pos=\(positionMs)ms dur=\(currentItemDurationMs())ms 源=\(durationSource()) rate=\(player.rate) err=\(errText) intent=\(playingIntent)")

        // 兜底（2026-10-25）：有音源却起不来 —— tcs 已是 playing、item 未 failed、但 5s 内进度一直是 0。
        // 实测 qq_002TTnfc13TkgO 就是这种：服务端 206 正常、ttfb 2.25s，AVFoundation 却停在 unknown。
        // 处理：重载当前曲一次（新建 item + 重新 play）；再不行交给上层失败语义。
        if playingIntent, player.timeControlStatus == .playing, positionMs == 0, item?.status != .failed {
            zeroProgressTicks += 1
            if zeroProgressTicks == 3, zeroProgressReloads < 1 {
                zeroProgressReloads += 1
                NSLog("[Start] 起播 6s 仍无进度，重载当前曲一次")
                reloadCurrent(index: currentIndex, positionMs: 0, autoplay: true)
            }
        } else if positionMs > 0 {
            zeroProgressTicks = 0
            zeroProgressReloads = 0
        }
    }
    /// 队列前瞻：保证"当前项之后"始终还有 LOOKAHEAD 首待播（惰性装载的核心）
    private static let lookahead = 2
    private var insertedThrough = -1
    /// 最后一次已知的逻辑下标（item 尚未就绪时的兜底，禁止用 0）
    private var logicalIndex = 0

    private func ensureLookahead() {
        guard !tracks.isEmpty else { return }
        let target = min(tracks.count - 1, player.items().count > 0
            ? (itemIndex[ObjectIdentifier(player.items().last!)] ?? insertedThrough) + Self.lookahead
            : insertedThrough + Self.lookahead + 1)
        while insertedThrough < target, insertedThrough + 1 < tracks.count {
            insertedThrough += 1
            let item = makeItem(for: tracks[insertedThrough])
            itemIndex[ObjectIdentifier(item)] = insertedThrough
            player.insert(item, after: player.items().last)
        }
    }

    private func playWhenReady() {
        guard playingIntent else { return }
        playAttempts += 1
        if playAttempts == 1 { NSLog("[Start] playWhenReady 开始 intent=\(playingIntent) item=\(player.currentItem != nil)") }
        let item = player.currentItem
        let ready = item?.status == .readyToPlay

        if ready, let t0 = playbackStartedAt {
            NSLog("[Start] item ready 用时 %.2fs", Date().timeIntervalSince(t0))
        }
        if ready || playAttempts > Self.playReadyMaxTries {
            player.playImmediately(atRate: 1.0)
            reportPlaying(true)
            let st = player.currentItem.map { Int($0.status.rawValue) } ?? -1
            NSLog("[Start] play 后立即 tcs=\(player.timeControlStatus.rawValue) item=\(st)")
            EngineThread.after(1.5) { [weak self] in
                guard let self else { return }
                let s2 = self.player.currentItem.map { Int($0.status.rawValue) } ?? -1
                let e2 = self.player.currentItem?.error.map { "\($0)" } ?? "-"
                NSLog("[Start] play 后 1.5s tcs=\(self.player.timeControlStatus.rawValue) item=\(s2) reason=\(self.player.reasonForWaitingToPlay?.rawValue ?? "-") err=\(e2)")
            }
            // 兜底：1.2s 后仍在 waiting 就再推一次（最多 2 次，不无限重试）
            EngineThread.after(1.2) { [weak self] in
                guard let self, self.playingIntent else { return }
                if self.player.timeControlStatus != .playing, self.playRetries < 2 {
                    self.playRetries += 1
                    NSLog("[Start] 起播后仍在 waiting（第 %d 次重试）", self.playRetries)
                    self.player.playImmediately(atRate: 1.0)
                }
            }
            return
        }
        EngineThread.after(0.1) { [weak self] in
            self?.playWhenReady()
        }
    }

    /// 当前条目确实挂了就上报（每个条目只报一次，Web 端负责解析重试）。
    ///
    /// 两个触发点复用：进度心跳（只报错误）+ 播放状态跌回 paused（错误 + 状态纠正）。
    /// 后者是必要的 —— 条目失败时时间轴会停住，`addPeriodicTimeObserver` 不再回调，
    /// 只靠心跳会漏报。
    ///
    /// - Parameter andStop: true 表示同时纠正播放状态（用于"意外停止"场景）。
    private func reportCurrentItemFailureIfNeeded(andStop: Bool = false) {
        guard let item = player.currentItem else { return }
        guard item.status == .failed || item.error != nil else { return }
        let key = ObjectIdentifier(item)
        guard !reportedFailures.contains(key) else { return }
        reportedFailures.insert(key)
        if andStop { reportPlaying(false) }
        events?.emitError(message: item.error?.localizedDescription ?? "播放错误")
        handlePlaybackFailure()
    }

    /// 往队列尾部追加曲目（搜索结果翻页续接）。**不打断当前播放**：
    /// 只改 `tracks` 与顺序表，条目仍按 lookahead 懒插入。
    func appendToQueue(_ newTracks: [SuenTrack]) {
        guard !newTracks.isEmpty else { return }
        if playOrder.isEmpty && !tracks.isEmpty { playOrder = Array(tracks.indices) }
        let old = tracks.count
        tracks.append(contentsOf: newTracks)
        let added = Array(old..<tracks.count)
        playOrder.append(contentsOf: repeatMode.isShuffle ? added.shuffled() : added)
        NSLog("[Queue] 追加 %d 首 → %d 首（源=%@）", newTracks.count, tracks.count, repeatMode.rawValue)
        ensureLookahead()
    }

    // MARK: 播放顺序（随机 / 随机不重复）

    /// 重建播放顺序：非随机 = 原序；随机 = 当前曲打头 + 其余洗牌。
    /// 这样「切到随机」不会打断当前曲，且列表显示顺序（tracks）始终不变。
    private func rebuildPlayOrder(startingAt index: Int) {
        guard !tracks.isEmpty else { playOrder = []; return }
        guard repeatMode.isShuffle else {
            playOrder = Array(tracks.indices)
            return
        }
        let safe = min(max(0, index), tracks.count - 1)
        playOrder = [safe] + tracks.indices.filter { $0 != safe }.shuffled()
    }

    /// 当前曲在顺序表里的位置（找不到就退回 0）
    private var orderPosition: Int {
        playOrder.firstIndex(of: currentIndex) ?? 0
    }

    /// 下一首的逻辑下标；nil = 到头且不允许回绕
    private func nextLogicalIndex() -> Int? {
        guard !tracks.isEmpty else { return nil }
        if playOrder.count != tracks.count { rebuildPlayOrder(startingAt: currentIndex) }
        let pos = orderPosition
        if pos + 1 < playOrder.count { return playOrder[pos + 1] }
        switch repeatMode {
        case .listLoop:
            return playOrder.first
        case .shuffle:
            // 随机播放到末尾：重洗一轮继续（首位避开刚刚播完的那首）
            rebuildPlayOrder(startingAt: currentIndex)
            return playOrder.count > 1 ? playOrder[1] : playOrder.first
        default:
            return nil
        }
    }

    /// 上一首的逻辑下标；nil = 到头部且不允许回绕
    private func previousLogicalIndex() -> Int? {
        guard !tracks.isEmpty else { return nil }
        if playOrder.count != tracks.count { rebuildPlayOrder(startingAt: currentIndex) }
        let pos = orderPosition
        if pos > 0 { return playOrder[pos - 1] }
        return repeatMode == .listLoop ? playOrder.last : nil
    }

    // MARK: 私有：状态跟踪

    private func onProgressTick(_ time: CMTime) {
        guard player.rate > 0 || player.currentItem != nil else { return }
        reportCurrentItemFailureIfNeeded()
        let posMs = max(0, Int(time.seconds * 1000))
        let durMs = currentItemDurationMs()
        diagTick(posMs)
        ensureLookahead()
        events?.emitProgress(index: currentIndex, positionMs: posMs, durationMs: max(0, durMs), playing: player.rate > 0)
        resyncNowPlayingIfStale()
    }

    private func onCurrentItemChanged(_ newItem: AVPlayerItem?) {
        guard !suppressTransitionEvent else { return }
        guard let item = newItem, item !== lastCurrentItem else {
            lastCurrentItem = newItem
            return
        }
        lastCurrentItem = item
        guard let idx = itemIndex[ObjectIdentifier(item)] else { return }
        updateNowPlaying()
        // KVO 触发的换条目只有"自然接续"一种来源（切歌的显式路径都手动发 reason=2）
        events?.emitTrackChange(index: idx, id: tracks[idx].id, reason: 1)
    }

    /// 直连模式下"下一首还没入队"时的逻辑索引。
    ///
    /// 队列里只有当前曲目（后续曲目要等 Web 解析直链），播完后 `currentItem` 会变成
    /// nil —— 没有这个值，Now Playing / 卡片会退回第 0 首，UI 与真实位置脱节。

    var currentIndex: Int {
        guard let item = player.currentItem, let idx = itemIndex[ObjectIdentifier(item)] else {
            // ⚠️ 2026-10-25 修：原来兜底 `return 0` —— 起播早期 item 还没就绪时 `emitProgress`
            // 会带 index=0 回传，把 PlaybackService.currentIndex 改成 0，于是**播放页显示 queue[0]
            // 的歌名/封面，而音频放的是用户点的那首**（用户实测：黄金甲播出来页面是别的钢琴曲）。
            // 兜底必须是「最后一次已知的逻辑下标」，而不是 0。
            return logicalIndex
        }
        return idx
    }

    private func currentItemKey() -> ObjectIdentifier? {
        player.currentItem.map { ObjectIdentifier($0) }
    }

    /// 时长是从哪儿来的（排查「页面显示元数据长度」用）
    private func durationSource() -> String {
        let idxNow = currentIndex
        if tracks.indices.contains(idxNow), AudioCacheStore.shared.realDurationMs(tracks[idxNow].id) > 0 { return "header" }
        if let item = player.currentItem, item.duration.seconds.isFinite, item.duration.seconds > 0 { return "item" }
        return "metadata"
    }

    private func currentItemDurationMs() -> Int {
        // ① 先用 **AVPlayerItem 解析出的真实媒体时长**：
        //    条目就是我们实际在播的那个视频/音频，它报的长度才是真的。
        //    （用户实测：叱咤红人真实 2:56，页面显示 3:08 —— 因为之前让响应头优先，
        //      而服务端在没有锚点时会用元数据兜底，于是把 3:08 当成了「真实时长」。）
        if let item = player.currentItem {
            let sec = item.duration.seconds
            if sec.isFinite && sec > 0 { return Int(sec * 1000) }
        }
        // ② 条目还没解析出时长时，才用服务端响应头（锚定曲目它就是真实视频时长）
        let idxNow = currentIndex
        if tracks.indices.contains(idxNow) {
            let real = AudioCacheStore.shared.realDurationMs(tracks[idxNow].id)
            if real > 0 { return real }
        }
        // 流尚未探测到时长时退回元数据（Web 端还会用已知真实时长覆盖）
        let idx = currentIndex
        return tracks.indices.contains(idx) ? tracks[idx].durationMs : 0
    }

    private func makeItem(for track: SuenTrack) -> AVPlayerItem {
        let raw = streamUrl(track)
        let url = URL(string: raw).flatMap { $0.scheme == nil ? nil : $0 }
            ?? URL(string: "suenmusic://invalid-stream/\(track.id)")!
        NSLog("%@", "[StreamUrl] makeItem id=\(track.id) url=\(raw.prefix(300))")
        let item = AVPlayerItem(asset: AVURLAsset(url: url))
        // ⚠️ 2026-10-25：**必须监听 item.status**，不能只靠进度 tick 里的失败检测。
        // 服务端 503（曲目真没音源）时 item 会立刻 failed，而吃不上饭的播放器**根本没有时间轴** ——
        // 周期时间观察者永不回调 → 失败传不出去 → 上层「无音源」三分支（停住/跳过/通知）全都不会执行。
        // 表现就是用户看到「点了没反应、也没有任何提示」。
        let key = ObjectIdentifier(item)
        let obs = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            EngineThread.onMain { [weak self] in
                guard let self, self.player.currentItem === item,
                      !self.reportedFailures.contains(key) else { return }
                self.reportedFailures.insert(key)
                NSLog("[Start] item failed: %@", item.error?.localizedDescription ?? "-")
                self.events?.emitError(message: item.error?.localizedDescription ?? "播放错误")
                self.handlePlaybackFailure()
            }
        }
        itemObservations.append(obs)
        return item
    }

    /// 组装流地址：本地回环代理优先（本地 4GB 磁盘 LRU 缓存与断点续拉），服务端代理兜底
    private func streamUrl(_ track: SuenTrack) -> String {
        // 2026-10-25 v4（实测：列表逐首点，起播 10s 左右）：
        //   直连时 AVFoundation 会连发多次 Range 请求，而冷曲目每次都要服务端现场去上游取（1-2s/次），
        //   攒到 9-10s item 才 ready。日志证据：playWhenReady 后 item=unknown 持续 9.8s。
        //   修法：走**本地代理**（它按整首顺序预拉，一次全速），AVPlayer 的区间请求全部从本地磁盘秒回。
        //   代理的首次整拉不带 Range → 服务端不限速（旧仓 §九-10），所以又快又对。
        _ = LocalStreamProxy.shared.entry(trackId: track.id)   // 立刻开始后台整首预拉
        if let local = LocalStreamProxy.shared.localURL(trackId: track.id) {
            return local
        }
        return directStreamUrl(track.id)
    }

    /// 直连上游（对齐 Android SuenAudio.streamUrlFor，防御双斜杠）
    private func directStreamUrl(_ trackId: String) -> String {
        var base = baseUrl
        while base.hasSuffix("/") { base.removeLast() }
        let encId = trackId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trackId
        if !sessionToken.isEmpty {
            let encToken = sessionToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sessionToken
            return "\(base)/api/stream/\(encId)?t=\(encToken)"
        }
        return "\(base)/api/stream/\(encId)"
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
            // 以前是 `try?` 吞错 + 无条件置 true：一旦某次激活被拒（来电后、
            // 后台受限、别的 App 占着），isActivated 卡在 true，之后每次
            // activateIfNeeded() 都短路 —— 表现为"永远没声音，只能杀 App"（重审 F）。
            // 保持 false，下一次播放会自然重试。
            isActivated = false
            NSLog("%@", "[AudioSession] 激活失败，下次播放重试: \(error.localizedDescription)")
        }
    }

    // MARK: 私有：系统事件

    /// 音频焦点（对齐 Android：来电暂停、让路导航）
    ///
    /// AVAudioSession 的通知由系统从内部队列投递，线程不确定 —— 先切回主线程
    /// 再动 player，理由同 `EngineThread.onMain` 的注释。
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
            player.pause()
            reportPlaying(false)
        case .ended:
            // 不自动恢复播放（对齐 Android 的保守策略：是否继续由用户按播放决定），
            // 但**必须复位音频会话**：系统在打断期间把 AVAudioSession 置为非激活，
            // 而 isActivated 还停在 true → activateIfNeeded() 之后永远短路 →
            // 挂断电话再按播放完全没声音，必须杀 App 重开（真机复现过）。
            isActivated = false
            activateIfNeeded()
            // 播放状态也要纠正：打断时已上报过 paused，这里不能凭空报 playing
            reportPlaying(false)
            break
        @unknown default:
            break
        }
    }

    /**
     * 音频服务被重置：旧的 session 配置与"已激活"标记全部作废。
     *
     * 只重建音频环境、**不自动起播** —— 官方明确要求把是否继续播放交回用户，
     * 否则会出现"用户没点任何东西，音乐自己响了"。
     */
    @objc private func handleMediaServicesReset(_ note: Notification) {
        EngineThread.onMain { [weak self] in
            guard let self else { return }
            NSLog("%@", "[AudioSession] 音频服务被系统重置，重新初始化会话")
            self.isActivated = false
            self.activateIfNeeded()
            // 丢掉"要播"的意图：reset 之后让用户自己按播放（官方要求）
            self.playingIntent = false
            self.player.pause()
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
            player.pause()
            reportPlaying(false)
        }
    }

    // MARK: 私有：锁屏 / 控制中心

    /// 下一首。队列到尾时按 repeatMode 决定是否回到开头。
    /// 锁屏命令与卡片命令共用这一份，避免两套边界条件。
    @discardableResult
    func skipToNext() -> Bool {
        guard !tracks.isEmpty else { return false }
        guard let next = nextLogicalIndex() else { return false }
        rebuildQueue(from: next, positionMs: 0, autoplay: true, reason: 2)
        return true
    }

    /// 上一首。队首且非列表循环时失败（与 Android 一致）。
    @discardableResult
    func skipToPrevious() -> Bool {
        guard !tracks.isEmpty else { return false }
        guard let prev = previousLogicalIndex() else { return false }
        rebuildQueue(from: prev, positionMs: 0, autoplay: true, reason: 2)
        return true
    }

    /// 注册锁屏 / 控制中心 / 灵动岛的远程控制命令。
    ///
    /// ⚠️ 「addTarget 就够了」是错的：`isEnabled` 才是系统决定这颗按钮
    /// 显不显示、点不点得动的依据。两者必须成对处理。
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
            // 看**意图**而不是 rate：缓冲时 rate 为 0，按 rate 判断会把"暂停"
            // 误当成"播放"，用户按一下反而又起播一次。
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
        // 不注册 ±15s 快进快退，并显式关掉 —— 否则系统会在锁屏多塞两颗按钮，
        // 与安卓端、与 Web 端播放器都不一致。
        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false

        refreshRemoteCommandAvailability()
    }

    /// 锁屏 / 控制中心按钮的可用性。
    ///
    /// 系统不会替我们判断"还有没有下一首"，它只看 `isEnabled`。
    /// 不刷这个，队尾的"下一首"也会亮着，用户点了没反应 —— 比直接灰掉更糟。
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
    /// 刷新策略是**事件驱动**，不在进度心跳里逐帧覆写：
    /// 系统会拿 `MPNowPlayingInfoPropertyPlaybackRate` 自己推算进度条位置，
    /// 我们再每 500ms 覆写一次 `ElapsedPlaybackTime` 反而会让进度条抖动 / 回跳
    /// （Apple 的 Now Playing 指南把"每秒刷新 elapsed"明确列为反模式）。
    /// 所以在 play / pause / seek / 换曲 / 队列重建 时各写一次即可，
    /// 另外用 `resyncNowPlayingIfStale()` 做低频校准兜底。
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
            MPNowPlayingInfoPropertyElapsedPlaybackTime: max(0, player.currentTime().seconds),
            // 意图，不是瞬时 rate（理由见 `playingIntent` 注释）
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

    /// 低频校准：流被服务端掐断时（日志里的 `MEDIA_PLAYBACK_STALL`），
    /// 系统按 rate 推算的进度会跑在实际音频前面，久了会漂。
    /// 每 10s 拿真实播放位置正面覆盖一次即可，不需要更密。
    private func resyncNowPlayingIfStale() {
        guard Date().timeIntervalSince(lastNowPlayingUpdate) >= 10 else { return }
        updateNowPlaying()
    }

    /// Now Playing 自检：把系统侧真正生效的状态打到 Xcode 控制台。
    ///
    /// 存在意义：锁屏 / 灵动岛由系统渲染，而**模拟器不渲染**它们，
    /// 所以"代码跑没跑对"没法从屏幕上看出来。有了这行日志，
    /// 只要在 Xcode 里跑一次、按一下播放，就能判断数据源是否已就绪。
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
                // artworkCache 只在主线程读写。之前写在工作线程、读在主线程，
                // 是一次真实（虽然大概率不炸）的字典数据竞争。
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
            // WiFi↔蜂窝切换时 satisfied 始终为 true，只靠连通性翻转报不出
            // "切网"事件；接口类型变化也要报 —— 停在旧路径上的请求
            //（缓存下载、Web 端探测）等的就是这个信号
            guard satisfied != lastSatisfied || interfaceType != self.lastInterfaceType else { return }
            self.lastSatisfied = satisfied
            self.lastInterfaceType = interfaceType
            self.onChange?(satisfied ? "available" : "lost")
        }
        monitor.start(queue: DispatchQueue.global(qos: .utility))
    }
}