import Foundation

/// LRC 歌词的一行
struct LyricLine: Equatable {
    let atMs: Int
    let text: String
    /// 译文（网易云/QQ 的 tlyric，可能为空）
    let translation: String
}

/// 一首曲目解析后的完整歌词：原文行 + 对齐到每行的译文（空串 = 该行无译文）
///
/// 与 hw `pages/LyricView.ets` 的 `LyricDoc` 同构：**原文与译文分开存**，
/// 翻译开关只管显示，不再重拉一次服务端。
struct LyricDoc: Equatable {
    let lines: [LyricLine]
    let trans: [String]
}

/// LRC 解析 + 「当前行」查询 + 译文对齐。
///
/// 为什么不放在 widget 里算：Live Activity 渲染进程不能联网、也不该做时间轴计算，
/// 由主 App 按 `positionMs` 算好一行随状态推过去（见 ContentState.lyricLine）。
enum LyricParser {
    /// 译文行与原文行的时间戳容差（毫秒）：两套 LRC 的时间标签必有细微出入
    /// （hw `TRANS_ALIGN_TOLERANCE_MS` 同值）
    static let transToleranceMs = 300

    /// 解析 `[mm:ss.xx]文本` 时间标签；忽略 `[ti:]/`[ar:]` 等元信息行。
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
        let idx = activeIndex(atMs: ms, in: lines)
        guard idx >= 0 else { return "" }
        let hit = lines[idx]
        return hit.translation.isEmpty ? hit.text : hit.text + "\n" + hit.translation
    }

    /// 当前位置的行下标（-1 = 还没到第一句 / 无歌词），与 hw `activeLyricIndex` 同口径
    static func activeIndex(atMs ms: Int, in lines: [LyricLine]) -> Int {
        guard !lines.isEmpty, ms >= 0 else { return -1 }
        var lo = 0
        var hi = lines.count - 1
        var found = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if lines[mid].atMs <= ms {
                found = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return found
    }

    /// 译文对齐（hw `alignTranslation` 逐行同口径）：两边都按时间升序，双指针一次扫完；
    /// |Δt| ≤ 300ms 视为同一行；命中不前移译文指针（相邻原文行可能共享同一条译文）。
    static func aligned(_ lines: [LyricLine], _ transLines: [LyricLine]) -> [String] {
        var out: [String] = []
        var j = 0
        for line in lines {
            var text = ""
            while j < transLines.count,
                  transLines[j].atMs < line.atMs - transToleranceMs {
                j += 1
            }
            if j < transLines.count, abs(transLines[j].atMs - line.atMs) <= transToleranceMs {
                text = transLines[j].text
            }
            out.append(text)
        }
        return out
    }
}

/// 歌词缓存 + peek（hw `pages/LyricView.ets` 的 `LYRIC_CACHE` / `peekLyric`）。
///
/// 面板与 peek 共用同一份缓存：面板没打开时 peek 也会预热，打开面板不再走一次网络。
/// 缓存满 60 条按写入顺序淘汰最旧的一条（hw `CACHE_LIMIT` 同值）。
@MainActor
final class LyricStore {
    static let shared = LyricStore()

    /// 缓存条数上限：长会话里换很多歌也不会无限涨
    static let limit = 60

    private var cache: [String: LyricDoc] = [:]
    /// 写入顺序（淘汰用；Swift 的 Dictionary 无序，不能靠它猜"最旧"）
    private var order: [String] = []
    /// 同曲并发请求合并（面板与 peek 同时要一首时只发一次）
    private var inflight: [String: Task<LyricDoc?, Never>] = [:]

    private init() {}

    /// 同步读缓存（peek 每个进度 tick 都要读，不能等网络）
    func cached(_ id: String) -> LyricDoc? { cache[id] }

    /// 取一首的完整歌词：缓存优先，未命中拉服务端并解析 + 对齐译文。失败返回 nil。
    func doc(for id: String) async -> LyricDoc? {
        guard !id.isEmpty else { return nil }
        if let hit = cache[id] { return hit }
        if let running = inflight[id] { return await running.value }
        let task = Task<LyricDoc?, Never> { [weak self] in
            guard let self else { return nil }
            return await self.fetch(id)
        }
        inflight[id] = task
        let doc = await task.value
        inflight[id] = nil
        return doc
    }

    /// 当前行附近 3 行（web FullPlayer lyric-peek 同口径；-1 = 无歌词/还没到第一句）
    func peek(_ id: String, positionMs: Int) -> (lines: [LyricLine], active: Int) {
        guard let doc = cache[id], !doc.lines.isEmpty else { return ([], -1) }
        let idx = LyricParser.activeIndex(atMs: positionMs, in: doc.lines)
        let from = max(0, idx - 1)
        let to = min(doc.lines.count - 1, idx + 1)
        guard from <= to else { return ([], -1) }
        return (Array(doc.lines[from...to]), idx - from)
    }

    private func fetch(_ id: String) async -> LyricDoc? {
        guard let reply = await APIClient.shared.lyrics(trackId: id) else {
            NSLog("[Lyric] 拉取失败 %@", id)
            return nil
        }
        let lines = LyricParser.parse(reply.lrc?.lyric ?? "")
        let transLines = LyricParser.parse(reply.lrc?.tlyric?.lyric ?? "")
        let doc = LyricDoc(lines: lines, trans: LyricParser.aligned(lines, transLines))
        put(id, doc)
        return doc
    }

    /// 写入（带上限淘汰：满 60 条就丢最早写入的那条）
    private func put(_ id: String, _ doc: LyricDoc) {
        if cache[id] == nil {
            if order.count >= Self.limit, let oldest = order.first {
                order.removeFirst()
                cache.removeValue(forKey: oldest)
            }
            order.append(id)
        }
        cache[id] = doc
    }
}
