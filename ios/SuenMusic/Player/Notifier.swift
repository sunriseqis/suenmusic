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

    /// App 在前台时 iOS **默认不弹**本地通知 —— 必须实现 `willPresent` 才会显示横幅。
    /// 而我们的场景（列表连播失败自动跳过、连续失败暂停）几乎都发生在用户正看着 App 的时候，
    /// 不做这一步等于「通知发了但永远看不见」。
    private final class Presenter: NSObject, UNUserNotificationCenterDelegate {
        func userNotificationCenter(_ center: UNUserNotificationCenter,
                                   willPresent notification: UNNotification,
                                   withCompletionHandler completionHandler:
                                   @escaping (UNNotificationPresentationOptions) -> Void) {
            completionHandler([.banner, .sound])
        }
    }

    private static let presenter = Presenter()

    /// 启动时调一次：装上前台展示代理 + 申请授权（授权早问，别等到失败那一刻才弹系统框）
    static func bootstrap() {
        UNUserNotificationCenter.current().delegate = presenter
        requestIfNeeded()
        UNUserNotificationCenter.current().getNotificationSettings { s in
            NSLog("[Notify] 授权状态=%d（0未决 1拒绝 2已授权 3临时 4临时授权）",
                  s.authorizationStatus.rawValue)
        }
    }

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
