import Foundation

/// **DEBUG 专用**的自动化开关：优先读 UserDefaults（一次写入永久生效），其次环境变量。
/// Release 构建里所有调用都返回 nil，不影响行为。
///
/// 用法（模拟器/真机都一样）：
///   xcrun simctl spawn booted defaults write com.suenmusic.app SUEN_TAB daily
///   xcrun simctl spawn booted defaults write com.suenmusic.app SUEN_AUTOPLAY 1
///   xcrun simctl spawn booted defaults write com.suenmusic.app SUEN_AUTOPLAY_INDEX 27
enum DebugHooks {
    static func string(_ key: String) -> String? {
        #if DEBUG
        if let v = UserDefaults.standard.string(forKey: key), !v.isEmpty { return v }
        if let v = ProcessInfo.processInfo.environment[key], !v.isEmpty { return v }
        return nil
        #else
        return nil
        #endif
    }

    static func int(_ key: String) -> Int? {
        guard let raw = string(key) else { return nil }
        return Int(raw)
    }
}