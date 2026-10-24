import Foundation
import ActivityKit

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

    /// 进度类更新的地板间隔（与 hw 卡片同值）
    private static let minIntervalMs = 1000

    private var activity: Activity<PlaybackActivityAttributes>?
    private var lastPushAt: Date = .distantPast

    private init() {}

    /// 同步一次状态。`force = true` 用于换歌/播放暂停/音源变化这类必须即时生效的变更。
    func sync(state: PlaybackActivityAttributes.ContentState, force: Bool = false) {
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
        } catch {
            // 权限被拒 / 系统限制：静默降级
            activity = nil
        }
    }

    /// 播放结束或退出登录时收摊
    func end() {
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
}