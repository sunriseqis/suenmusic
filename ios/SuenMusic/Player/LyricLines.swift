import Foundation

/// LRC 歌词的一行
struct LyricLine: Equatable {
    let atMs: Int
    let text: String
    /// 译文（网易云/QQ 的 tlyric，可能为空）
    let translation: String
}

/// LRC 解析 + 「当前行」查询。
///
/// 为什么不放在 widget 里算：Live Activity 渲染进程不能联网、也不该做时间轴计算，
/// 由主 App 按 `positionMs` 算好一行随状态推过去（见 ContentState.lyricLine）。
enum LyricParser {
    /// 解析 `[mm:ss.xx]文本` 时间标签；忽略 `[ti:]`/`[ar:]` 等元信息行。
    static func parse(_ lrc: String, translation trans: String = "") -> [LyricLine] {
        var lines: [LyricLine] = []
        for raw in lrc.split(separator: "\n") {
            var rest = Substring(raw)
            var stamps: [Int] = []
            while rest.hasPrefix("["), let close = rest.firstIndex(of: "]") {
                let tag = rest[rest.index(after: rest.startIndex)..<close]
                rest = rest[rest.index(after: close)...]
                if let ms = parseStamp(String(tag)) { stamps.append(ms) }
            }
            let text = rest.trimmingCharacters(in: .whitespaces)
            guard !stamps.isEmpty, !text.isEmpty else { continue }
            for ms in stamps { lines.append(LyricLine(atMs: ms, text: text, translation: "")) }
        }
        lines.sort { $0.atMs < $1.atMs }
        guard !trans.isEmpty else { return lines }
        // 译文按时间戳对齐过来（两个文件的行时间一般一一对应）
        var map: [Int: String] = [:]
        for line in parse(trans) { map[line.atMs] = line.text }
        return lines.map { line in
            guard let t = map[line.atMs] else { return line }
            return LyricLine(atMs: line.atMs, text: line.text, translation: t)
        }
    }

    /// `mm:ss.xx` / `mm:ss:xx`（部分曲库用冒号）→ 毫秒
    private static func parseStamp(_ tag: String) -> Int? {
        let parts = tag.replacingOccurrences(of: ":", with: ".").split(separator: ".")
        guard parts.count >= 2,
              let m = Int(parts[0]), let s = Int(parts[1]) else { return nil }
        let frac = parts.count > 2 ? (Int(parts[2]) ?? 0) : 0
        let scale = parts.count > 2 ? (parts[2].count == 3 ? 1 : 10) : 1000
        return (m * 60 + s) * 1000 + frac * scale
    }

    /// 当前位置对应的歌词行（没有歌词返回空串）。带译文时用换行拼成两行。
    static func line(atMs ms: Int, in lines: [LyricLine]) -> String {
        guard !lines.isEmpty, ms >= 0 else { return "" }
        var lo = 0, hi = lines.count - 1, found: LyricLine?
        while lo <= hi {
            let mid = (lo + hi) / 2
            if lines[mid].atMs <= ms { found = lines[mid]; lo = mid + 1 } else { hi = mid - 1 }
        }
        guard let hit = found else { return "" }
        return hit.translation.isEmpty ? hit.text : hit.text + "\n" + hit.translation
    }
}