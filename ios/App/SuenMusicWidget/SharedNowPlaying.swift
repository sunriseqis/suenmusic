/**
 * App 与 Widget 共享的「正在播放」快照。
 *
 * 数据放在 App Group 的 UserDefaults 里；封面单独落成 jpg 文件
 * （UserDefaults 不适合塞图片）。App 侧写入，Widget 侧只读。
 */
import Foundation
import WidgetKit

struct WidgetLyricLine: Codable {
    let ms: Int
    let text: String
}

/// 卡片 / 反代命令要播放器做的事。
enum PlaybackAction: String {
    case playPause
    case play
    case pause
    case next
    case previous
}

/// Widget 命令的落地桥。
///
/// `AudioPlaybackIntent.perform()` 在 **App 进程**执行，但插件可能还没
/// 被 Capacitor 实例化（冷启动去后台跑 intent 时）。所以：
///   - 有 handler  → 立即执行
///   - 没有        → 写进 App Group 排队，插件 `load()` 时补执行
/// 这个类型同时编进 Widget target（intent 文件要引用它），但只有 App 那份
/// 真正会跑 perform。
final class PlaybackCommand {
    static let shared = PlaybackCommand()
    private init() {}

    private static let queueKey = "widget.playbackCommand"

    var handler: ((PlaybackAction) -> Void)?

    private var defaults: UserDefaults? {
        UserDefaults(suiteName: SharedNowPlaying.groupId)
    }

    func dispatch(_ action: PlaybackAction) {
        if handler != nil {
            handler?(action)
            return
        }
        defaults?.set(action.rawValue, forKey: Self.queueKey)
    }

    /// 插件注册时调用：补执行冷启动期间积压的命令。
    func drainQueue() {
        guard
            let raw = defaults?.string(forKey: Self.queueKey),
            let action = PlaybackAction(rawValue: raw)
        else { return }
        defaults?.removeObject(forKey: Self.queueKey)
        handler?(action)
    }
}

struct WidgetNowPlaying: Codable {
    var title: String
    var artist: String
    var album: String
    var playing: Bool
    var positionMs: Int
    var durationMs: Int
    var lyrics: [WidgetLyricLine]
    var updatedAt: TimeInterval
    /// 当前封面文件对应的远端 URL，用来判断要不要重新下载
    var coverUrl: String

    /// 从未写入过快照：卡片按空态渲染，控制键置灰。
    var isEmpty: Bool { updatedAt == 0 }

    static let empty = WidgetNowPlaying(
        title: "暂无歌曲播放",
        artist: "",
        album: "",
        playing: false,
        positionMs: 0,
        durationMs: 0,
        lyrics: [],
        updatedAt: 0,
        coverUrl: ""
    )
}

enum SharedNowPlaying {
    static let groupId = "group.com.suenmusic.app"
    private static let key = "widget.nowPlaying"
    private static var lastReload = Date.distantPast

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: groupId)
    }

    static var coverURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: groupId)?
            .appendingPathComponent("widget-cover.jpg")
    }

    static func read() -> WidgetNowPlaying {
        guard
            let data = defaults?.data(forKey: key),
            let snap = try? JSONDecoder().decode(WidgetNowPlaying.self, from: data)
        else {
            return .empty
        }
        return snap
    }

    /// 写入快照并请求刷新时间线。reload 做节流，避免进度心跳把系统打烦。
    static func publish(_ snap: WidgetNowPlaying) {
        guard let data = try? JSONEncoder().encode(snap) else { return }
        defaults?.set(data, forKey: key)

        if Date().timeIntervalSince(lastReload) > 20 {
            lastReload = Date()
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    static func clear() {
        publish(.empty)
    }

    static func saveCover(_ data: Data) {
        guard let url = coverURL else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// 封面按 URL 去重后异步下载，失败保留旧图。
    static func syncCover(urlString: String) {
        guard let url = URL(string: urlString), url.scheme == "https" || url.scheme == "http" else {
            return
        }
        if defaults?.string(forKey: "widget.coverSource") == urlString,
           let path = coverURL?.path,
           FileManager.default.fileExists(atPath: path) {
            return
        }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, !data.isEmpty else { return }
            saveCover(data)
            defaults?.set(urlString, forKey: "widget.coverSource")
            WidgetCenter.shared.reloadAllTimelines()
        }.resume()
    }
}
