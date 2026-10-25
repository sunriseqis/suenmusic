import Foundation
import AppIntents
import AVFoundation

/**
 * Live Activity / 灵动岛的遥控按钮 —— **点按钮不打开 App**（AudioPlaybackIntent 的语义），
 * 系统会在后台唤醒 App 进程执行 perform()，UI 不动。
 *
 * ⚠️ 这个文件要**同时属于 App 与 SuenWidgets 两个 target**：
 *   widget 侧要能引用 Intent 类型（Button(intent:)），执行时由系统回到 App 进程。
 */

/// 播放 / 暂停（切换）
struct PlayPauseIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "播放/暂停"

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await MainActor.run { PlaybackService.shared.toggle() }
        #endif
        return .result()
    }
}

/// 上一首
struct PrevTrackIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "上一首"

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await MainActor.run { PlaybackService.shared.prev() }
        #endif
        return .result()
    }
}

/// 下一首
struct NextTrackIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "下一首"

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await MainActor.run { PlaybackService.shared.next() }
        #endif
        return .result()
    }
}