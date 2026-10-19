import AppIntents
import Foundation

/**
 * 卡片播放控制。
 *
 * 用 `AudioPlaybackIntent` 而不是普通 `AppIntent`：它告诉系统这颗按钮
 * "是播音频的"，于是系统允许它在后台直接执行，`perform()` 跑在 App 进程里
 * —— 这是 WidgetKit 扩展碰不到 App 那个 AVAudioPlayer、而 intent 可以的原因。
 *
 * `openAppWhenRun = false`：点了不把 App 拽到前台，只换歌 / 暂停。
 *
 * 可用性：`Button(intent:)` 与交互式 Widget 都是 iOS 17+；
 * 15/16 的 Widget 只能读，界面上不渲染按钮（调用处已做 #available 分流）。
 */
@available(iOS 17.0, *)
struct SuenPlayPauseIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "播放或暂停"
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        await MainActor.run {
            PlaybackCommand.shared.dispatch(.playPause)
        }
        return .result()
    }
}

@available(iOS 17.0, *)
struct SuenNextTrackIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "下一首"
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        await MainActor.run {
            PlaybackCommand.shared.dispatch(.next)
        }
        return .result()
    }
}

@available(iOS 17.0, *)
struct SuenPreviousTrackIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "上一首"
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        await MainActor.run {
            PlaybackCommand.shared.dispatch(.previous)
        }
        return .result()
    }
}
