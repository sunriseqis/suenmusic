import Foundation
import ActivityKit

/**
 * Live Activity / 灵动岛的数据契约。
 *
 * ⚠️ **这个文件必须同时加入两个 target**（主 App 与 Widget Extension）：
 *    ActivityAttributes 的声明要两边一致，否则 ActivityKit 编译不过。
 *
 * 与 hw 桌面卡片的对应关系：
 *   hw `SuenFormCard`（2×2 / 2×4，封面 + 歌名 + 歌手 + 进度 + 三键）
 *   → 这里拆成「锁屏卡」+「灵动岛 compact/minimal/expanded」三态。
 */
struct PlaybackActivityAttributes: ActivityAttributes {
    /// 一动不动的部分（本次会话固定）
    var startedAt: Date

    public struct ContentState: Codable, Hashable {
        var title: String
        var artist: String
        var album: String
        var coverUrl: String
        var positionMs: Int
        var durationMs: Int
        var playing: Bool
        /// bilibili / 网易云 / 未匹配 —— 与 hw 音源行同口径
        var sourceLabel: String
        /// 封面小图（64×64 JPEG，~1–2KB，base64 后随状态传输）。
        /// widget 进程**不能联网取图**，所以必须由主 App 把图塞进来。
        var coverJPEG: Data?
    }
}