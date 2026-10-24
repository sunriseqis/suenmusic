import Foundation
import UserNotifications

/**
 * 系统通知落地口 —— **对齐 hw `common/Notifier.ets`**（切歌失败/无音源时提示）。
 *
 * 只在"用户不在页面上"的场景用（列表连播失败自动跳过、连续失败暂停）；
 * 手动点播失败**不发通知**（用户就在页面上，只在 eyebrow 显示「无音源」）。
 * 授权被拒时静默降级 —— 通知只是补充，不影响播放。
 */
enum Notifier {
    private static var didRequest = false

    /// 首次使用前请求授权（幂等）
    static func requestIfNeeded() {
        guard !didRequest else { return }
        didRequest = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// 发一条立即呈现的本地通知
    static func notify(title: String, body: String) {
        requestIfNeeded()
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }
}
