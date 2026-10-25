import Foundation

/// 列表刷新信号：**长按底栏 tab** 触发（取代下拉刷新）。
///
/// 为什么不用 `.refreshable`：它在 scroll view 上与 `TrackRow` 的横向右滑手势抢手势，
/// 实测会导致「行上滑不动、只有空白处能滚」。hw 有刷新，但手势入口改成按键/长按是更稳的做法。
enum RefreshSignal {
    static let name = Notification.Name("suen.refresh")

    /// tab 下标：0 首页 / 1 专属 / 2 收藏 / 3 搜索 / 4 设置
    static func post(_ tab: Int) {
        NotificationCenter.default.post(name: name, object: tab)
    }
}