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
 */
@MainActor
final class LiveActivityController {
    static let shared = LiveActivityController()

    /// **开启**（2026-10-25 用户定案：这种形态正好）。
    ///
    /// 背景：iOS 会把 Live Activity 放到锁屏上该 App 的媒体槽位，于是系统媒体卡不再单独出现。
    /// 换句话说——**锁屏只剩我们这一张卡**，它必须自己承担全部信息（封面/歌名/歌手/歌词/进度/三键）。
    /// 这也让「锁屏歌词」成为可能（系统媒体卡不带歌词），而桌面 widget 做不到（15-60 分钟一次刷新）。
    ///
    /// 代价（已确认接受）：Apple 要求 all presentations，所以灵动岛与锁屏卡并存，锁屏会多这一张卡；
    /// 因为系统卡被顶掉，这不是「重复」，而是「取代」。
    static let enabled = true

    /// 进度类更新的地板间隔（与 hw 卡片同值）
    private static let minIntervalMs = 1000

    private var activity: Activity<PlaybackActivityAttributes>?
    private var lastPushAt: Date = .distantPast

    // MARK: 封面小图（widget 不能联网 → 主 App 下好、缩到 64×64 JPEG 塞进状态）

    private var coverCache: [String: Data] = [:]
    private var coverTask: Task<Void, Never>?

    /// 取某首歌的封面小图；没缓存就异步下（下完回调一次，触发 force 推送）
    func coverJPEG(for urlString: String, completion: @escaping (Data?) -> Void) -> Data? {
        if urlString.isEmpty { return nil }
        if let hit = coverCache[urlString] { return hit }
        coverTask?.cancel()
        coverTask = Task { [weak self] in
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

    private init() {}

    /// 同步一次状态。`force = true` 用于换歌/播放暂停/音源变化这类必须即时生效的变更。
    func sync(state: PlaybackActivityAttributes.ContentState, force: Bool = false) {
        guard Self.enabled else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let now = Date()
        if !force, now.timeIntervalSince(lastPushAt) * 1000 < Double(Self.minIntervalMs) {
            return
        }
        lastPushAt = now

        let content = ActivityContent(state: state, staleDate: now.addingTimeInterval(300))
        if let activity {
            Task { await activity.update(content) }
            return
        }
        do {
            activity = try Activity.request(
                attributes: PlaybackActivityAttributes(startedAt: now),
                content: content,
                pushType: nil
            )
            NSLog("[LiveActivity] 已请求 activity id=\(activity?.id ?? "-") title=\(state.title)")
        } catch {
            // 权限被拒 / 系统限制：静默降级
            activity = nil
            NSLog("[LiveActivity] 请求失败（静默降级）：\(error.localizedDescription)")
        }
    }

    /// 播放结束或退出登录时收摊
    func end() {
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
}