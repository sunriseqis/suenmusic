import Foundation
import UIKit
import UserNotifications

/**
 * 系统通知落地口 —— **对齐 hw `common/Notifier.ets`**（切歌失败/无音源时提示）。
 *
 * 只在"用户不在页面上"的场景用（列表连播失败自动跳过、连续失败暂停）；
 * 手动点播失败**不发通知**（用户就在页面上，只在 eyebrow 显示「无音源」）。
 * 授权被拒时静默降级 —— 通知只是补充，不影响播放。
 *
 * 第二个用途（酷狗 20028 风控）：`reason == "need_verification"` 时发一条**点得动**的
 * 通知，点开用系统浏览器打开服务端下发的验证页（userInfo 里带 url，见 PlaybackService
 * 的 promptVerify）。这条是用户必须动手才能恢复的状态，所以**授权被拒不能静默**：
 * `notifyVerify` 会用 onDenied 回调退到应用内 Toast。
 */
enum Notifier {
    private static var didRequest = false
    /// 验证类通知的固定标识：同一次验证只留一条，不在通知中心堆一串
    private static let verifyIdentifier = "verify-kugou"

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

        /// 点通知：验证类通知带 userInfo["url"]，直接交给**系统浏览器**（Safari / 默认浏览器）。
        /// 系统在后台线程回调，UIApplication.open 必须回主线程。
        func userNotificationCenter(_ center: UNUserNotificationCenter,
                                   didReceive response: UNNotificationResponse,
                                   withCompletionHandler completionHandler: @escaping () -> Void) {
            if let raw = response.notification.request.content.userInfo["url"] as? String,
               let url = URL(string: raw) {
                // 系统在后台线程回调；open 必须回主线程（UIApplication 是 @MainActor）
                Task { @MainActor in _ = UIApplication.shared.open(url) }
            }
            completionHandler()
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
        post(title: title, body: body, url: nil, identifier: UUID().uuidString)
    }

    /// 发一条「点开用系统浏览器打开 url」的本地通知。
    /// 授权未通过时不发通知，改走 `onDenied`（调用方退应用内提示）—— 绝不静默吞掉。
    static func notifyVerify(title: String, body: String, url: String,
                             onDenied: @escaping () -> Void) {
        requestIfNeeded()
        UNUserNotificationCenter.current().getNotificationSettings { s in
            let allowed = (s.authorizationStatus == .authorized
                           || s.authorizationStatus == .provisional
                           || s.authorizationStatus == .ephemeral)
            if allowed {
                post(title: title, body: body, url: url, identifier: verifyIdentifier)
            } else {
                DispatchQueue.main.async { onDenied() }
            }
        }
    }

    /// 真正落地：url 非空时写进 userInfo，并由 delegate 在点击时取出
    private static func post(title: String, body: String, url: String?, identifier: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let url, !url.isEmpty {
            content.userInfo = ["url": url]
        }
        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }
}
