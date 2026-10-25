import Foundation

/**
 * 用户可见文案（对齐 hw `common/Copy.ets`）：空态话术 + 错误话术统一出口。
 *
 * 页面禁止自造文案，一律从这里取；错误话术与服务端 message 的优先级同 hw。
 */
enum Copy {
    // ---- 空态（S4 §五，统一走 EmptyState） ----
    static let searchEmptyTitle = "没找到相关歌曲"
    static let searchEmptySub = "换个关键词试试"
    static let favEmptyTitle = "还没有收藏"
    static let favEmptySub = "在播放页点心形就能收藏"
    static let dailyEmptyTitle = "曲库还太少"
    static let dailyEmptySub = "先多听几首再来看"
    static let lyricEmpty = "这首歌暂无歌词"
    static let queueEmptyTitle = "队列是空的"
    static let queueEmptySub = "去首页挑一首"

    /// 错误 → 用户可读文案（`Copy.describeError` 的 Swift 版）。
    /// 网络层用 status 0 表达，与 `ApiError.isNetwork` 同口径。
    static func describe(status: Int, code: String?, message: String?) -> String {
        if status == 0 {
            return "连不上服务端，请检查网络或服务器地址"
        }
        if status == 401 {
            return "登录已失效，请重新登录"
        }
        if code == "shortfall" {
            return "曲库还太少，先多听几首再来看看"
        }
        if status == 503, code == "source_unavailable" {
            return "这首暂时找不到可播放音源"
        }
        if status >= 400, status < 500 {
            let detail = message?.isEmpty == false ? message! : "请稍后重试"
            return "请求被拒绝：" + detail
        }
        return "出错了，请稍后重试"
    }
}
