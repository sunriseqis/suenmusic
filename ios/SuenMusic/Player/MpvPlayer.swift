/**
 * libmpv 播放内核（P1：把播放内核从 AVPlayer 换成 libmpv）。
 *
 * 职责只有一件事：**让一首音源出声**，并把「位置 / 时长 / 状态 / 自然播完 / 错误」报给上层。
 * 队列、播放顺序、缓存预约、Now Playing、音频会话全在 AudioEngine，本类不碰。
 *
 * 线程模型：
 *   · 公开方法（load / play / pause / seek / setVolume / stop）可在任意线程调用 ——
 *     libmpv 的 client API 本身线程安全（内部有锁）；
 *   · **事件循环独占一条线程**：mpv_wait_event 只允许单线程调用，多线程调会丢事件；
 *   · 所有回调都切回主线程再发，上层不必自己 dispatch。
 *
 * 事件 id / 属性格式用**裸数值**比较（22 = PROPERTY_CHANGE、8 = FILE_LOADED ...）：
 * C 枚举在 Swift 里可能被导入成 struct，也可能被导入成 Swift enum，用 rawValue 比数字
 * 在两种形态下都成立，比直接引用枚举常量稳。
 */
import Foundation
import Libmpv

final class MpvPlayer {

    /// 对上层可见的播放状态（与 AudioEngine 的 playing/paused/buffering/idle 一一对应）
    enum PlaybackState: String {
        case idle
        case playing
        case paused
        case buffering
    }

    // MARK: 对外回调（全部在主线程触发）

    /// 播放位置（秒）。高频回调，内部已按 timeEmitInterval 节流。
    var onTime: ((Double) -> Void)?
    /// 媒体总时长（秒），解析出来后回调（重载/换源会再来一次）
    var onDuration: ((Double) -> Void)?
    /// 状态变化（只在**变化**时回调）
    var onState: ((PlaybackState) -> Void)?
    /// 自然播完（EOF）。被 stop / 换源打断**不会**走到这里
    var onEnded: (() -> Void)?
    /// 文件真的装载完成（只用于日志与诊断，不参与状态机）
    var onFileLoaded: (() -> Void)?
    /// 播放失败（CDN 403 / 解码失败 / 文件不存在…），参数是人类可读原因
    var onError: ((String) -> Void)?

    // MARK: 只读状态（任意线程可读）

    private(set) var currentTime: Double = 0
    private(set) var duration: Double = 0
    private(set) var state: PlaybackState = .idle

    var isPaused: Bool {
        lock.lock(); defer { lock.unlock() }
        return paused
    }

    // MARK: 内部

    private var handle: OpaquePointer?
    private let lock = NSRecursiveLock()
    private var eventThread: Thread?
    private let exitSignal = DispatchSemaphore(value: 0)
    private var stopping = false
    private var paused = false
    private var idleActive = true
    private var coreIdle = true
    private var pausedForCache = false
    private var lastTimeEmit = Date.distantPast
    /// 最近一次 time-pos **真的变化**的时刻（nil = 本轮装载还没出过第一次推进）。
    ///
    /// core-idle 既可能表示缓冲、也可能只是核心在等处：单看它判缓冲会误伤正常播放
    /// （误判的代价是 UI 上一个永不消失的 loading），所以要用「确实没在推进」交叉确认。
    private var lastAdvanceAt: Date?

    /// time-pos 的节流间隔：mpv 自己的属性回调频率不可控，UI 只要 4Hz 就够
    private static let timeEmitInterval: TimeInterval = 0.25

    // MARK: 构造 / 销毁

    init() throws {
        guard let h = mpv_create() else {
            throw NSError(domain: "SuenMusic.MpvPlayer", code: -1, userInfo: [
                NSLocalizedDescriptionKey: "mpv_create 失败",
            ])
        }
        handle = h

        // ① 选项：**全部在 mpv_initialize 之前**设置
        let options: [(String, String)] = [
            ("config", "no"),               // 不读用户 mpv.conf / 脚本，行为只由本文件决定
            ("terminal", "no"),             // 不接管 stdout（日志走 NSLog）
            ("vo", "null"),                 // 音频播放器，不要视频输出
            ("audio-display", "no"),        // 有封面轨也不当视频显示
            ("idle", "yes"),                // 文件播完不退出核心，方便接着 loadfile 下一首
            ("keep-open", "no"),            // 播完立刻结束 → 靠 END_FILE 接续
            // osc / input-* 这类已随 mpv 0.40 迁进脚本体系，这里只留仍然有效的两行
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("load-scripts", "no"),
            ("audio-client-name", "SuenMusic"),
        ]
        for (key, value) in options where mpv_set_option_string(h, key, value) < 0 {
            NSLog("[Mpv] 选项设置失败 %@=%@", key, value)
        }
        // ao 单独试：iOS/macOS 上 libmpv 的音频输出模块叫 audiounit。
        // 万一这版打包没编进去，**不静默失败** —— 退给 mpv 自动选，并把错误打出来。
        let aoRC = mpv_set_option_string(h, "ao", "audiounit")
        if aoRC < 0 {
            NSLog("[Mpv] ao=audiounit 不可用（%@），改用自动选择", Self.errorText(aoRC))
        } else {
            NSLog("%@", "[Mpv] 已选择音频输出 ao=audiounit")
        }

        let initRC = mpv_initialize(h)
        guard initRC >= 0 else {
            let text = Self.errorText(initRC)
            mpv_terminate_destroy(h)
            handle = nil
            throw NSError(domain: "SuenMusic.MpvPlayer", code: Int(initRC), userInfo: [
                NSLocalizedDescriptionKey: "mpv_initialize 失败：\(text)",
            ])
        }
        NSLog("[Mpv] 初始化完成 client_api=%d", Int32(mpv_client_api_version() >> 16))
        // 打开 mpv 自己的日志（info 级）：HTTP 403 / 解封装失败的**真实原因**只在
        // mpv 日志里，NSLog 里只剩一句 "loading failed"，排障时等于没有信息。
        // SUEN_MPV_TRACE=1 时升到 trace（含 ffmpeg 的请求行/头），只在排障时用
        let logLevel = DebugHooks.string("SUEN_MPV_TRACE") == "1" ? "trace" : "info"
        mpv_request_log_messages(h, logLevel)

        // ② 观察属性（全装上，否则事件里收不到）
        observe("time-pos", format: Self.formatDouble)
        observe("duration", format: Self.formatDouble)
        observe("pause", format: Self.formatFlag)
        observe("idle-active", format: Self.formatFlag)
        observe("core-idle", format: Self.formatFlag)
        observe("paused-for-cache", format: Self.formatFlag)

        // ③ 事件循环
        let thread = Thread { [weak self] in self?.eventLoop() }
        thread.name = "suen.mpv.events"
        thread.qualityOfService = .userInitiated
        eventThread = thread
        thread.start()
    }

    deinit {
        shutdown()
    }

    /// 停事件线程 → 销毁句柄。可重入（AudioEngine.deinit 也会调）。
    func shutdown() {
        lock.lock()
        if stopping {
            lock.unlock()
            return
        }
        stopping = true
        let h = handle
        handle = nil
        lock.unlock()

        if let h = h {
            mpv_wakeup(h)               // 让阻塞在 wait_event 的线程立刻返回
        }
        // 等事件线程收尾（最多 3s）：**必须先确认它退出**，否则 terminate_destroy
        // 会 free 掉它还在用的句柄 → 释放后使用（崩溃点看起来在完全无关的地方）
        if exitSignal.wait(timeout: .now() + 3) == .timedOut {
            NSLog("%@", "[Mpv] 事件线程 3s 内未退出，继续销毁（可能泄漏一个线程）")
        }
        if let h = h {
            mpv_terminate_destroy(h)
        }
        NSLog("%@", "[Mpv] 已销毁")
    }

    // MARK: 播放控制

    /// 装载一首（本地文件或 http(s) 直链）并可选起播。
    ///
    /// - Parameters:
    ///   - headers: 必须在 loadfile **之前**写进 http-header-fields，
    ///     B 站 CDN 缺 Referer 直接 403（这是它防盗链的全部要求）。
    ///   - startAt: 起播位置（秒）。用 mpv 的 file-local 选项 start 交给核心在装载时定位，
    ///     比「loadfile 之后再 seek」稳（后者在文件还没解析出时长时可能被丢掉）。
    func load(url: String, headers: [String: String]?, startAt: Double = 0, autoplay: Bool = true) {
        guard let h = handle else { return }

        // ① HEADERS —— 关键，必须早于 loadfile
        //
        // 分两路写：User-Agent / Referer 用 mpv 自己的**专用选项**（user-agent / referrer），
        // 其余头走 http-header-fields（逗号分隔的字符串列表）。为什么不用一个列表塞全部：
        // mpv 对字符串列表只按 ',' 切分且不 trim，且 UA 与 Referer 在 ffmpeg 里各有一等公民位，
        // 混在一起时出现过 CDN 回 400 的实例（见 MpvPlayer.headerFields 注释与 P1 报告）。
        let fields = Self.headerFields(headers)
        let ua = headers?["User-Agent"] ?? headers?["user-agent"]
        let referer = headers?["Referer"] ?? headers?["referrer"] ?? headers?["Referer"]
        if let ua = ua {
            let rc = mpv_set_property_string(h, "user-agent", ua)
            if rc < 0 { NSLog("[Mpv] user-agent 写入失败：%@", Self.errorText(rc)) }
        }
        if let referer = referer {
            let rc = mpv_set_property_string(h, "referrer", referer)
            if rc < 0 { NSLog("[Mpv] referrer 写入失败：%@", Self.errorText(rc)) }
        }
        let headerRC = mpv_set_property_string(h, "http-header-fields", fields)
        if headerRC < 0 {
            NSLog("[Mpv] http-header-fields 写入失败：%@", Self.errorText(headerRC))
        }
        NSLog("[Mpv] headers 已设 referrer=%@ user-agent=%@ fields=%@",
              referer ?? "-", ua == nil ? "-" : "(设)", fields.isEmpty ? "(空)" : fields)

        // ② 起点
        _ = mpv_set_option_string(h, "start", String(format: "%.3f", max(0, startAt)))

        lock.lock()
        currentTime = max(0, startAt)
        duration = 0
        lastTimeEmit = .distantPast
        lastAdvanceAt = nil          // 新文件：推进基准从零开始算
        lock.unlock()

        // ③ 装载（replace：换掉当前文件，而不是排队）
        let quoted = "\"" + url
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
        let rc = commandString("loadfile \(quoted) replace")
        if rc < 0 {
            NSLog("[Mpv] loadfile 失败：%@", Self.errorText(rc))
            emitMain { $0.onError?("装载失败：\(Self.errorText(rc))") }
        }
        // ④ 起播意图：autoplay=false 时先立成暂停，等上层 play()
        setPaused(!autoplay)
    }

    func play() {
        setPaused(false)
    }

    func pause() {
        setPaused(true)
    }

    /// 停止并回到 idle（保留句柄，下一次 load 无需重建核心）
    func stop() {
        _ = commandString("stop")
        lock.lock()
        currentTime = 0
        lock.unlock()
    }

    /// 绝对定位（秒）
    func seek(to seconds: Double) {
        let target = max(0, seconds)
        lock.lock()
        currentTime = target
        lock.unlock()
        let rc = commandString(String(format: "seek %.3f absolute exact", target))
        if rc < 0 {
            NSLog("[Mpv] seek 失败：%@", Self.errorText(rc))
        }
    }

    /// 音量 0…1（mpv 的 volume 是 0…100）
    func setVolume(_ volume: Double) {
        let clamped = min(1, max(0, volume)) * 100
        _ = mpv_set_property_string(handle, "volume", String(format: "%.1f", clamped))
    }

    private func setPaused(_ value: Bool) {
        guard let h = handle else { return }
        let rc = mpv_set_property_string(h, "pause", value ? "yes" : "no")
        if rc < 0 {
            NSLog("[Mpv] pause 设置失败 %@：%@", value ? "yes" : "no", Self.errorText(rc))
        }
    }

    // MARK: 事件循环

    private func eventLoop() {
        defer { exitSignal.signal() }
        while true {
            lock.lock()
            let stop = stopping
            let h = handle
            lock.unlock()
            guard !stop, let h = h else { return }
            // 0.1s 超时而不是 0：0 是纯轮询，会把一个核烧满；0.1s 对音频事件毫无延迟感
            guard let eventPtr = mpv_wait_event(h, 0.1) else { continue }
            let event = eventPtr.pointee
            handleEvent(event)
        }
    }

    private func handleEvent(_ event: mpv_event) {
        switch Int32(event.event_id.rawValue) {
        case 22:   // MPV_EVENT_PROPERTY_CHANGE
            guard let raw = event.data else { return }
            let prop = raw.assumingMemoryBound(to: mpv_event_property.self).pointee
            guard let namePtr = prop.name else { return }
            onPropertyChange(name: String(cString: namePtr),
                             format: Int32(prop.format.rawValue),
                             data: prop.data)

        case 8:    // MPV_EVENT_FILE_LOADED
            refreshDuration()
            let d = duration
            NSLog("[Mpv] file-loaded dur=%.2fs", d)
            emitMain { player in
                player.onDuration?(d)
                player.onFileLoaded?()
            }
            refreshState()

        case 7:    // MPV_EVENT_END_FILE
            var reason: Int32 = 0
            var errCode: Int32 = 0
            if let raw = event.data {
                let ef = raw.assumingMemoryBound(to: mpv_event_end_file.self).pointee
                reason = Int32(ef.reason.rawValue)
                errCode = ef.error
            }
            // 4 = MPV_END_FILE_REASON_ERROR，0 = EOF，2 = STOP（被 stop / 换源打断），3 = QUIT
            if reason == 4 || (errCode < 0 && reason != 2) {
                let text = Self.errorText(errCode)
                NSLog("[Mpv] end-file 失败 reason=%d err=%@", reason, text)
                emitMain { $0.onError?(text) }
            } else if reason == 0 {
                NSLog("%@", "[Mpv] end-file 自然播完")
                emitMain { $0.onEnded?() }
            } else {
                NSLog("[Mpv] end-file reason=%d（打断/停止，不上报）", reason)
            }

        case 2:    // MPV_EVENT_LOG_MESSAGE
            if let raw = event.data {
                let msg = raw.assumingMemoryBound(to: mpv_event_log_message.self).pointee
                let prefix = msg.prefix.map { String(cString: $0) } ?? ""
                let text = msg.text.map { String(cString: $0) } ?? ""
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { NSLog("[MpvLog/%@] %@", prefix, trimmed) }
            }

        case 1:    // MPV_EVENT_SHUTDOWN
            NSLog("%@", "[Mpv] 核心 shutdown 事件")

        default:
            break
        }
    }

    private func onPropertyChange(name: String, format: Int32, data: UnsafeMutableRawPointer?) {
        guard let data = data else { return }
        switch name {
        case "time-pos":
            guard format == 5 else { return }          // 5 = MPV_FORMAT_DOUBLE
            let value = data.assumingMemoryBound(to: Double.self).pointee
            lock.lock()
            // 推进判定：往前走了才算（seek 造成的倒退不算推进）
            if value > currentTime + 0.01 { lastAdvanceAt = Date() }
            currentTime = value
            let emit = Date().timeIntervalSince(lastTimeEmit) >= Self.timeEmitInterval
            if emit { lastTimeEmit = Date() }
            lock.unlock()
            if emit { emitMain { $0.onTime?(value) } }

        case "duration":
            guard format == 5 else { return }
            let value = data.assumingMemoryBound(to: Double.self).pointee
            lock.lock()
            duration = value
            lock.unlock()
            emitMain { $0.onDuration?(value) }

        case "pause":
            guard format == 3 else { return }          // 3 = MPV_FORMAT_FLAG
            let value = data.assumingMemoryBound(to: Int32.self).pointee != 0
            lock.lock()
            paused = value
            lock.unlock()
            refreshState()

        case "idle-active":
            guard format == 3 else { return }
            let value = data.assumingMemoryBound(to: Int32.self).pointee != 0
            lock.lock()
            idleActive = value
            lock.unlock()
            refreshState()

        case "core-idle":
            guard format == 3 else { return }
            let value = data.assumingMemoryBound(to: Int32.self).pointee != 0
            lock.lock()
            coreIdle = value
            lock.unlock()
            refreshState()

        case "paused-for-cache":
            guard format == 3 else { return }
            let value = data.assumingMemoryBound(to: Int32.self).pointee != 0
            lock.lock()
            pausedForCache = value
            lock.unlock()
            NSLog("[Mpv] paused-for-cache=%@", value ? "yes" : "no")
            refreshState()

        default:
            break
        }
    }

    /// 把三个 flag 归并成对外的四态。只在**变化**时上报（缓冲抖动不该刷 UI）。
    ///
    /// core-idle 的映射要保守：它表示「核心当前没有在推进」，缓冲时会置真，但装载 /
    /// 等处时也会短暂置真。直接拿它当 buffering 有把正常播放误判成缓冲的风险，
    /// 所以只在 **time-pos 确实 2s 没动过**（lastAdvanceAt 交叉确认）时才算缓冲。
    private func refreshState() {
        lock.lock()
        let next: PlaybackState
        if idleActive {
            next = .idle
        } else if paused {
            next = .paused
        } else if pausedForCache {
            next = .buffering
        } else if coreIdle && Self.notAdvancing(lastAdvanceAt) {
            next = .buffering
        } else {
            next = .playing
        }
        let changed = next != state
        state = next
        lock.unlock()
        guard changed else { return }
        NSLog("[Mpv] state=%@", next.rawValue)
        emitMain { $0.onState?(next) }
    }

    /// 距上次真实推进超过 2s 视为「没在推进」（nil = 本轮还没出过推进，同样算）
    private static func notAdvancing(_ lastAdvanceAt: Date?) -> Bool {
        guard let lastAdvanceAt = lastAdvanceAt else { return true }
        return Date().timeIntervalSince(lastAdvanceAt) >= 2.0
    }

    private func refreshDuration() {
        guard let h = handle else { return }
        var value: Double = 0
        let data = withUnsafeMutablePointer(to: &value) { UnsafeMutableRawPointer($0) }
        let rc = mpv_get_property(h, "duration", Self.formatDouble, data)
        guard rc >= 0, value.isFinite, value > 0 else { return }
        lock.lock()
        duration = value
        lock.unlock()
    }

    // MARK: 小工具

    private func observe(_ name: String, format: mpv_format) {
        guard let h = handle else { return }
        let rc = mpv_observe_property(h, 0, name, format)
        if rc < 0 {
            NSLog("[Mpv] 观察属性失败 %@：%@", name, Self.errorText(rc))
        }
    }

    @discardableResult
    private func commandString(_ command: String) -> Int32 {
        guard let h = handle else { return -1 }
        lock.lock()
        defer { lock.unlock() }
        return mpv_command_string(h, command)
    }

    private func emitMain(_ body: @escaping (MpvPlayer) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            body(self)
        }
    }

    /// http-header-fields 是 mpv 的「字符串列表」选项：**元素之间用逗号分隔**，
    /// mpv 会在每个元素后各补一个 CRLF（等价命令行 --http-header-fields='A: 1','B: 2'）。
    /// 所以这里必须用 ", " 连接；直接塞 CRLF 会让整串被当成**一个**元素，
    /// 结果是一个非法头字段 —— B 站 CDN 随即 403（实测）。
    /// UA / Referer 的值里没有逗号，不会被拆开。
    private static func headerFields(_ headers: [String: String]?) -> String {
        guard let headers = headers, !headers.isEmpty else { return "" }
        // User-Agent / Referer 已由专用选项承担，不进这个列表
        let skip: Set<String> = ["User-Agent", "user-agent", "Referer", "referrer"]
        let ordered = headers
            .filter { !skip.contains($0.key) }
            .sorted { $0.key < $1.key }
        // ⚠️ 分隔符**只能是逗号本身**，不能是 ", "：mpv 对字符串列表只按 ',' 切分、**不 trim**，
        // 写成逗号+空格会让第二个头变成 " User-Agent: ..."（前导空格）→ 请求直接 400。
        return ordered
            .map { "\($0.key): \($0.value)" }
            .joined(separator: ",")
    }

    private static func errorText(_ code: Int32) -> String {
        if code >= 0 { return "ok" }
        if let cString = mpv_error_string(code) {
            return String(cString: cString)
        }
        return "错误码 \(code)"
    }

    /// MPV_FORMAT_DOUBLE = 5 / MPV_FORMAT_FLAG = 3。
    ///
    /// 不直接引用 C 常量：C 枚举在 Swift 里可能被导入成 struct 也可能被导入成 enum，
    /// 用 rawValue 构造在两种形态下都成立（同一个 UInt32 位模式）。
    private static let formatDouble = mpv_format(rawValue: 5)
    private static let formatFlag = mpv_format(rawValue: 3)
}
