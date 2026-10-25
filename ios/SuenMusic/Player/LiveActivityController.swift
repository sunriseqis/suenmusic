import Foundation
import ActivityKit
import UIKit

/**
 * Live Activity 生命周期（主 target 侧）。
 *
 * 与 hw 桌面卡片推送同一条纪律：**元数据变更立刻推，进度类走 1s 地板**
 * （hw：`CARD_PUSH_MIN_INTERVAL_MS = 1000`）。逐秒刷新既费电也会被系统限流。
 *
 * 系统未开启「实时活动」权限时静默降级（不报错、不影响播放）。
 *
 * ⚠️ 三条踩过的坑（2026-10-25 实测，模拟器日志为证）：
 *   ① `Activity.request` **要求 App 在前台**，后台/启动瞬间会抛 "Target is not foreground"。
 *      旧实现失败后把 `activity` 置 nil 就再没人管 → 每 tick 重试、失败、再重试，
 *      锁屏/灵动岛全程没有卡。现在失败时**暂存状态**，回前台（或下一次推送）立刻补推。
 *   ② 进程重启后系统里还留着上一场的活动。旧实现只认自己进程内那个引用 → 重新 request 出**第二张卡**，
 *      而灵动岛只会显示其中一张（往往是先创建的旧卡）→「岛屿里不是当前曲」。
 *      现在写之前先 `reconcile`：接管系统里最新的那个活动、结束多余的。
 *   ③ `update` 是异步的，连发会**乱序落地**（后推的旧状态盖掉新歌）。现在串行化 + 只推最新。
 */
@MainActor
final class LiveActivityController {
    static let shared = LiveActivityController()

    /// **开启**（2026-10-25 用户定案：这种形态正好）。
    ///
    /// 背景：iOS 会把 Live Activity 放到锁屏上该 App 的媒体槽位，于是系统媒体卡不再单独出现。
    /// 换句话说——**锁屏只剩我们这一张卡**，它必须自己承担全部信息（封面/歌名/歌手/专辑/歌词/进度/三键）。
    ///
    /// 代价（已确认接受）：Apple 要求 all presentations，所以灵动岛与锁屏卡并存，锁屏会多这一张卡；
    /// 因为系统卡被顶掉，这不是「重复」，而是「取代」。
    static let enabled = true

    /// 进度类更新的地板间隔（与 hw 卡片同值）
    private static let minIntervalMs = 1000

    private var activity: Activity<PlaybackActivityAttributes>?
    private var lastPushAt: Date = .distantPast

    /// 想推但没推上去的状态（App 不在前台时 request 会被拒 → 暂存，回前台立刻补推）
    private var pendingState: PlaybackActivityAttributes.ContentState?
    /// 上一次真正交给系统的状态（同一状态不重复写，省 ActivityKit 预算）
    private var lastWritten: PlaybackActivityAttributes.ContentState?
    /// 正在写的 update（串行化：保证最后落地的一定是最新状态）
    private var writing = false
    /// 正在结束的活动 id（end 是异步的，避免 reconcile 又把它们接回来）
    private var retiring: Set<String> = []
    /// 启动清理只做一次（`prewarm()` 在 RootView 出现时调用，可能不止一次）
    private var didLaunchCleanup = false
    /// 上一次 request 失败的时间（同一个原因不刷屏）
    private var requestFailedAt: Date = .distantPast
    private var foregroundObserver: NSObjectProtocol?

    // MARK: 封面小图（widget 不能联网 → 主 App 下好、缩到 64×64 JPEG 塞进状态）

    private var coverCache: [String: Data] = [:]
    /// 已经发起过下载的 URL：进度类推送 ~1s 一次，没有这层去重，一条 404 的封面会被每秒重下一次
    private var coverTried: Set<String> = []

    /// 取某首歌的封面小图；没缓存就异步下（下完回调一次，触发 force 推送）
    func coverJPEG(for urlString: String, completion: @escaping (Data?) -> Void) -> Data? {
        if urlString.isEmpty { return nil }
        if let hit = coverCache[urlString] { return hit }
        guard !coverTried.contains(urlString) else { return nil }
        coverTried.insert(urlString)
        Task { [weak self] in
            guard let target = URL(string: urlString) else { return }
            do {
                let (data, _) = try await URLSession.shared.data(from: target)
                guard let small = Self.downscaleJPEG(data, side: 64) else { return }
                await MainActor.run {
                    self?.coverCache[urlString] = small
                    completion(small)
                }
            } catch {
                // 封面拿不到不影响主流程
            }
        }
        return nil
    }

    private static func downscaleJPEG(_ data: Data, side: CGFloat) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
        let thumb = renderer.image { _ in
            let scale = max(side / image.size.width, side / image.size.height)
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            image.draw(in: CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2,
                                  width: size.width, height: size.height))
        }
        return thumb.jpegData(compressionQuality: 0.5)
    }

    private init() {
        // App 回前台：request 的「Target is not foreground」失败要在这里补上
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.flushPending() }
        }
    }

    // MARK: 推送

    /// 同步一次状态。`force = true` 用于换歌/播放暂停/歌词换行这类必须即时生效的变更。
    func sync(state: PlaybackActivityAttributes.ContentState, force: Bool = false) {
        guard Self.enabled else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let now = Date()
        if !force, now.timeIntervalSince(lastPushAt) * 1000 < Double(Self.minIntervalMs) {
            pendingState = state   // 被地板吞掉：留最新的一份，等下一次推或回前台补
            return
        }
        lastPushAt = now
        pendingState = state
        deliver(state)
    }

    private func deliver(_ state: PlaybackActivityAttributes.ContentState) {
        guard let target = liveActivity() else {
            request(state)
            return
        }
        if lastWritten == state, pendingState == state {
            pendingState = nil
            return   // 完全没变：不浪费一次 update
        }
        write(state, to: target)
    }

    /// 当前该写的活动：进程内持有的优先；没有就**接管**系统里还活着的那个。
    ///
    /// 为什么必须接管：杀进程 / 后台起播后，上一场的活动还在系统里活着，
    /// 而新进程的 `activity` 是 nil。旧实现直接 request 出第二张卡 —— 灵动岛只显示其中一张，
    /// 且往往不是刚建的那张，于是「岛屿里不是当前曲」。接管后一次 update 就纠正回当前曲。
    private func liveActivity() -> Activity<PlaybackActivityAttributes>? {
        if let activity, !retiring.contains(activity.id) { return activity }
        activity = nil
        let alive = Activity<PlaybackActivityAttributes>.activities.filter { !retiring.contains($0.id) }
        guard let newest = alive.max(by: { $0.attributes.startedAt < $1.attributes.startedAt }) else { return nil }
        activity = newest
        for extra in alive where extra.id != newest.id { retire(extra) }
        NSLog("[LiveActivity] 接管残留 activity id=\(newest.id) title=\(newest.content.state.title) 结束多余=\(alive.count - 1)")
        return newest
    }

    private func request(_ state: PlaybackActivityAttributes.ContentState) {
        do {
            let created = try Activity.request(
                attributes: PlaybackActivityAttributes(startedAt: Date()),
                content: content(state),
                pushType: nil
            )
            activity = created
            lastWritten = state
            pendingState = nil
            NSLog("[LiveActivity] 已请求 activity id=\(created.id) title=\(state.title) artist=\(state.artist)")
        } catch {
            // 权限被拒 / App 不在前台（"Target is not foreground"）：静默降级，状态留在 pendingState，
            // 回前台或下一次推送自动重试（不打日志刷屏）
            activity = nil
            pendingState = state
            let now = Date()
            if now.timeIntervalSince(requestFailedAt) > 5 {
                requestFailedAt = now
                NSLog("[LiveActivity] 请求失败（暂存待重试）：\(error.localizedDescription) title=\(state.title)")
            }
        }
    }

    /// 串行写：写完再看有没有更新的状态要写（旧实现每次 push 各起一个 Task，落地顺序不保证）
    private func write(_ state: PlaybackActivityAttributes.ContentState,
                       to activity: Activity<PlaybackActivityAttributes>) {
        if writing {
            pendingState = state
            return
        }
        writing = true
        lastWritten = state
        pendingState = nil
        let payload = content(state)
        Task { [weak self] in
            await activity.update(payload)
            guard let self else { return }
            NSLog("[LiveActivity] update id=\(activity.id) title=\(state.title) artist=\(state.artist) "
                + "album=\(state.album) lyric=\(Self.oneLine(state.lyricLine)) "
                + "pos=\(state.positionMs)/\(state.durationMs) playing=\(state.playing ? 1 : 0) "
                + "dark=\(state.dark ? 1 : 0) cover=\(state.coverJPEG?.count ?? 0)B")
            self.writing = false
            if let next = self.pendingState, self.activity?.id == activity.id, next != state {
                self.write(next, to: activity)
            }
        }
    }

    private func content(_ state: PlaybackActivityAttributes.ContentState)
        -> ActivityContent<PlaybackActivityAttributes.ContentState> {
        ActivityContent(state: state, staleDate: Date().addingTimeInterval(300))
    }

    /// App 回前台：把暂存的状态补推一次（request 只在前台能成功）
    private func flushPending() {
        guard let state = pendingState else { return }
        lastPushAt = .distantPast
        sync(state: state, force: true)
    }

    private static func oneLine(_ text: String) -> String {
        text.replacingOccurrences(of: "\n", with: " / ")
    }

    // MARK: 收摊

    /// 启动时清掉**残留的旧活动**（杀进程/换版本后系统会留着上一次的面板）。
    /// 不做这一步，锁屏会挂着与当前播放无关的僵尸卡 —— 而 Live Activity 现在是正式形态，
    /// 系统媒体卡已被它顶掉，一张错的面板等于「锁屏信息全错」。
    ///
    /// **只做一次，且只在本进程还没建过活动时做**：`prewarm()` 挂在 RootView 的 `.task` 上，
    /// 视图身份变化会再调一次；旧实现每次都把当前卡一起结束掉（播放中锁屏卡凭空消失）。
    func endAllStale() {
        guard !didLaunchCleanup, activity == nil else { return }
        didLaunchCleanup = true
        let alive = Activity<PlaybackActivityAttributes>.activities
        for stale in alive { retire(stale) }
        if !alive.isEmpty { NSLog("[LiveActivity] 启动清理残留 activity 个数=\(alive.count)") }
    }

    private func retire(_ target: Activity<PlaybackActivityAttributes>) {
        retiring.insert(target.id)
        Task { await target.end(nil, dismissalPolicy: .immediate) }
    }

    /// 播放结束或退出登录时收摊
    func end() {
        guard let activity else { return }
        self.activity = nil
        pendingState = nil
        lastWritten = nil
        retire(activity)
    }
}
