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
        /// **当前这一行歌词**（含可选翻译，用换行分隔）。
        ///
        /// widget 进程不能联网、也不能自己算时间轴，所以歌词必须由主 App 按播放位置算好后随状态推；
        /// 只推一行（ContentState 上限 4KB），且只在**换行时**推（ActivityKit 有更新预算）。
        var lyricLine: String = ""
        /// **是否深色**（true = 深色主题）。
        ///
        /// 为什么要把主题塞进状态里：widget / Live Activity 是独立进程，`@Environment(\.colorScheme)`
        /// 拿到的是**系统**的深浅色，而 App 里可以单独设「浅色/深色」（theme_mode）——
        /// 不传这个字段，用户把 App 设成深色、系统是浅色时，锁屏卡与灵动岛会一直是浅色（用户实测反馈）。
        var dark: Bool = false
    }
}