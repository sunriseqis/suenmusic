import Foundation

/**
 * 轻量离线缓存：**只缓存完整文件**，不参与播放链路。
 *
 * 与上一轮被删掉的那版（1515 行、绑定 `LocalStreamProxy` 本地回环代理）的根本差别：
 *   · 那一版播什么都要从本地代理里过一遍 —— 用户不要的就是这一层；
 *   · 这一版只做三件事：**直链下载落盘 → 播放时命中本地文件 → 超配额按 LRU 淘汰**。
 *     播放由 `AudioEngine` 直接交给 AVURLAsset，本类型不接管任何网络请求。
 *
 * 落盘规则（规格 5.1 / 5.2 / 5.3）：
 *   URLSession 临时文件 →（字节数与 Content-Length 相等，或流正常结束）→ `.bin` + 同名 `.json` meta。
 *   不留 `.part`、不做断点续传（规格 3.2）：取消 / 失败 / 不完整一律直接丢弃临时文件，
 *   不写索引。只有 `.bin` 真的在**且** meta 能读出来，`cachedFileURL` 才返回路径。
 *
 * 下载源只能是 CDN 直链（带 directHeaders）。**绝不接受 `/api/stream` 代理 URL**：
 * 那正是本轮要去掉的服务端中转。没有直链就不缓存，宁可不缓存。
 *
 * 「什么时候开始下」不在这里：规格 2.1 的 25 秒延时与规格 3.1 的取消都由
 * `AudioEngine` 的预约任务决定，本类型只负责「一旦被调用就一口气下完」（2.3）。
 */
final class AudioCacheStore: @unchecked Sendable {

    static let shared = AudioCacheStore()

    /// 配额 1GB（规格 6.2）
    static let maxBytes: Int64 = 1 * 1024 * 1024 * 1024
    /// 落盘目录名（**Application Support** 下：持久目录，系统不回收 —— 规格 6.1）
    static let directoryName = "SuenAudioCache"
    /// 旧版把缓存落在 caches 下，那份文件在新目录里永远是孤儿 → 一次性整目录清掉
    private static let legacyPurgeKey = "suenmusic.audioCache.legacyCachesPurged.v1"

    /// 缓存条目（对外快照；UI 只读这一份，不碰文件系统）
    struct Entry: Identifiable {
        let trackId: String
        let name: String
        let artist: String
        let bytes: Int64
        let createdAt: Date
        let lastAccessAt: Date

        var id: String { trackId }
    }

    /// 落盘 meta（`.json`，与 `.bin` 同名）
    private struct Meta: Codable {
        let trackId: String
        let name: String
        let artist: String
        let bytes: Int64
        let createdAt: Double
        var lastAccessAt: Double
    }

    /// meta 索引（全部状态都在这里，磁盘是唯一真相，索引只是它的镜像）
    private let lock = NSLock()
    private var index: [String: Meta] = [:]
    private var indexLoaded = false
    /// 同一首正在下载时不重复发起
    private var inflight: Set<String> = []

    private static let defaultUserAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
        + "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    private init() {}

    // MARK: - 对外查询

    /// 命中返回**本地完整文件**的 URL；`.bin` 不在或 meta 缺失即 nil（宁可重下一次，也不给半截文件）。
    func cachedFileURL(_ trackId: String) -> URL? {
        guard !trackId.isEmpty else { return nil }
        let hit: URL? = locked {
            loadIndexLocked()
            guard let meta = index[trackId], meta.trackId == trackId else { return nil }
            let bin = binURL(trackId)
            // 体积门槛不是完整性判据（规格 5.1/5.2 在落盘前已判定），这里只要文件非空
            guard let size = fileSize(bin), size > 0 else { return nil }
            return bin
        }
        return hit
    }

    func isCached(_ trackId: String) -> Bool {
        cachedFileURL(trackId) != nil
    }

    /// 真实占用（按磁盘上 `.bin` 的实际大小累加，不是 meta 里的旧数字）
    var usedBytes: Int64 {
        let total: Int64 = locked {
            loadIndexLocked()
            var sum: Int64 = 0
            for id in index.keys { sum += fileSize(binURL(id)) ?? 0 }
            return sum
        }
        return total
    }

    var entryCount: Int {
        let count: Int = locked {
            loadIndexLocked()
            var n = 0
            for id in index.keys where fileSize(binURL(id)) != nil { n += 1 }
            return n
        }
        return count
    }

    /// 一次遍历同时给出「列表 + 总占用 + 条数」（N-6）。
    ///
    /// 缓存页刷新原来要 `usedBytes` + `entries()` 各 stat 一遍全部 `.bin`（条目上百时
    /// 一次 onAppear 就是两百多次同步 stat，而且还在主线程）；这里只 stat 一遍，
    /// 调用方把整个调用挪到后台即可。
    struct Snapshot {
        let entries: [Entry]
        let usedBytes: Int64
        var count: Int { entries.count }
    }

    /// 一次遍历产出快照（磁盘 stat 都发生在这里，调用方负责别在主线程调）
    func snapshot() -> Snapshot {
        let snap: Snapshot = locked {
            loadIndexLocked()
            var out: [Entry] = []
            var total: Int64 = 0
            for meta in index.values {
                guard let size = fileSize(binURL(meta.trackId)), size > 0 else { continue }
                total += size
                out.append(Entry(trackId: meta.trackId,
                                 name: meta.name,
                                 artist: meta.artist,
                                 bytes: size,
                                 createdAt: Date(timeIntervalSince1970: meta.createdAt),
                                 lastAccessAt: Date(timeIntervalSince1970: meta.lastAccessAt)))
            }
            return Snapshot(entries: out.sorted { $0.lastAccessAt > $1.lastAccessAt }, usedBytes: total)
        }
        return snap
    }

    /// 列表（最近听过的在前）—— 缓存页逐条删除用
    func entries() -> [Entry] {
        let list: [Entry] = locked {
            loadIndexLocked()
            var out: [Entry] = []
            for meta in index.values {
                guard let size = fileSize(binURL(meta.trackId)), size > 0 else { continue }
                out.append(Entry(trackId: meta.trackId,
                                 name: meta.name,
                                 artist: meta.artist,
                                 bytes: size,
                                 createdAt: Date(timeIntervalSince1970: meta.createdAt),
                                 lastAccessAt: Date(timeIntervalSince1970: meta.lastAccessAt)))
            }
            return out.sorted { $0.lastAccessAt > $1.lastAccessAt }
        }
        return list
    }

    // MARK: - 维护

    /// 播放命中缓存时刷新 LRU 时间戳（配额淘汰按它排序）
    func setAccess(_ trackId: String) {
        guard !trackId.isEmpty else { return }
        locked {
            loadIndexLocked()
            guard var meta = index[trackId] else { return }
            meta.lastAccessAt = Date().timeIntervalSince1970
            index[trackId] = meta
            writeMetaLocked(meta)
        }
    }

    /// 删单条（同步完成：调用方删完立刻读用量就是新值）
    func evict(_ trackId: String) {
        guard !trackId.isEmpty else { return }
        locked { removeLocked(trackId) }
    }

    func clearAll() {
        locked {
            loadIndexLocked()
            let ids = Array(index.keys)
            for id in ids { removeLocked(id) }
            index.removeAll()
            // 顺手清掉孤儿文件（残片 / 没有 meta 的旧文件）
            let fm = FileManager.default
            if let names = try? fm.contentsOfDirectory(atPath: dirURL.path) {
                for name in names { try? fm.removeItem(at: dirURL.appendingPathComponent(name)) }
            }
        }
    }

    // MARK: - 下载（唯一入口；只接受 CDN 直链）

    /// 后台下载一首完整曲目并落盘。同一首并发调用只发起一次；已缓存直接忽略。
    ///
    /// 返回值是这个下载任务的句柄：**调用方负责在切歌 / 播完时 cancel 它**（规格 3.1）。
    /// 取消会让 `URLSession.download` 直接抛错，临时文件被系统删掉、`.bin` 与 meta 都不会写
    /// —— 这就是规格 3.2「已下载的部分直接丢弃、不保留 .part、不续传」。
    ///
    /// - Parameters:
    ///   - headers: 直链鉴权头（B 站 CDN 无 Referer/UA 会 403）
    /// - Returns: nil = 本次没有发起（已在缓存 / 已在下载 / 参数不合法）
    @discardableResult
    func download(trackId: String, name: String, artist: String,
                  url: String, headers: [String: String]?) -> Task<Void, Never>? {
        guard !trackId.isEmpty, let remote = URL(string: url), remote.scheme != nil else { return nil }
        // 防御：代理流 URL 永远不是下载源（本轮需求就是不让数据经过服务端中转，规格 4.2）
        guard !url.contains("/api/stream/") else {
            NSLog("%@", "[AudioCache] 拒绝代理流下载源 id=\(trackId)")
            return nil
        }
        // N-1：入口守卫必须是「真的可播」，不能只看 index 里有没有 meta。
        // 只看 meta 的话，meta 还在、`.bin` 被系统清理（或用户删掉）之后，这首歌永远进不了
        // 下载分支 —— isCached() 说没缓存、download() 又说「已缓存」，只能手动清空整个缓存。
        // cachedFileURL 内部已经 locked，而 NSLock 不可重入：先算出布尔再进 locked，
        // 绝不能在 locked 闭包里调 cachedFileURL（会死锁）。
        if cachedFileURL(trackId) != nil { return nil }
        let begin: Bool = locked {
            loadIndexLocked()
            // 去重优先且语义不变：正在下就直接返回，绝不在这条路径上动任何文件
            // （否则可能删掉 fetch 刚落盘、还没登记完的 .bin）。
            if inflight.contains(trackId) { return false }
            // 能走到这里只有两种可能：没有 meta，或 meta 在但文件不可用。
            // 后者是陈旧 meta（索引里的垃圾），顺手清掉，免得它永远挡着重新下载。
            // removeLocked 内部只是 FileManager + 字典操作，不加锁，不会重入。
            if index[trackId] != nil { removeLocked(trackId) }
            inflight.insert(trackId)
            return true
        }
        guard begin else { return nil }
        return Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            await self.fetch(trackId: trackId, name: name, artist: artist,
                             remote: remote, headers: headers)
            self.locked { _ = self.inflight.remove(trackId) }
        }
    }

    /// Content-Length 就是「应该有」的字节数；拿不到（分块传输）返回 0 = 以流正常结束为准（规格 5.2）。
    private static func expectedBytes(_ http: HTTPURLResponse) -> Int64 {
        if let raw = http.value(forHTTPHeaderField: "Content-Length"),
           let declared = Int64(raw), declared > 0 {
            return declared
        }
        if http.expectedContentLength > 0 { return http.expectedContentLength }
        return 0
    }

    private func fetch(trackId: String, name: String, artist: String,
                       remote: URL, headers: [String: String]?) async {
        let fm = FileManager.default
        Self.ensureDirectory(dirURL)

        var request = URLRequest(url: remote)
        request.timeoutInterval = 60
        for (field, value) in headers ?? [:] { request.setValue(value, forHTTPHeaderField: field) }
        if request.value(forHTTPHeaderField: "User-Agent") == nil {
            request.setValue(Self.defaultUserAgent, forHTTPHeaderField: "User-Agent")
        }

        // 取消（切歌 / 播完）与失败都从这里抛出：临时文件由 URLSession 自己回收，
        // 本类型没有 .part、也不写索引 —— 规格 3.2 / 5.3 的「不留残余」就是这条路径。
        let tmp: URL
        let response: URLResponse
        do {
            (tmp, response) = try await URLSession.shared.download(for: request)
        } catch {
            NSLog("%@", "[AudioCache] 下载中断/失败，丢弃 id=\(trackId) err=\(error.localizedDescription)")
            return
        }
        // 无论后面走哪条分支都删掉临时文件（成功已移走，这里删是 no-op）
        defer { try? fm.removeItem(at: tmp) }

        guard let http = response as? HTTPURLResponse else {
            NSLog("%@", "[AudioCache] 非 HTTP 响应，丢弃 id=\(trackId)")
            return
        }
        guard (200..<300).contains(http.statusCode) else {
            NSLog("%@", "[AudioCache] HTTP \(http.statusCode) 放弃 id=\(trackId)")
            return
        }
        guard let bytes = fileSize(tmp), bytes > 0 else {
            NSLog("%@", "[AudioCache] 收到 0 字节，丢弃 id=\(trackId)")
            return
        }
        // 规格 5.1：有 Content-Length 就必须相等，差一个字节都不算完整 → 直接丢弃（5.3）
        let expected = Self.expectedBytes(http)
        guard expected <= 0 || bytes == expected else {
            NSLog("%@", "[AudioCache] 字节数不完整丢弃 id=\(trackId) got=\(bytes) expected=\(expected)")
            return
        }

        let bin = binURL(trackId)
        try? fm.removeItem(at: bin)
        do {
            try fm.moveItem(at: tmp, to: bin)
        } catch {
            NSLog("%@", "[AudioCache] 改名失败 id=\(trackId) err=\(error.localizedDescription)")
            return
        }

        let now = Date().timeIntervalSince1970
        let meta = Meta(trackId: trackId, name: name, artist: artist,
                        bytes: bytes, createdAt: now, lastAccessAt: now)
        locked {
            index[trackId] = meta
            writeMetaLocked(meta)
        }
        NSLog("%@", "[AudioCache] 落盘 id=\(trackId) \(bytes)B")
        enforceQuota()
    }

    /// 超配额按 `lastAccessAt` **最旧优先**淘汰（规格 6.3）：升序排，先删最久未用的。
    private func enforceQuota() {
        locked {
            loadIndexLocked()
            var total: Int64 = 0
            for id in index.keys { total += fileSize(binURL(id)) ?? 0 }
            guard total > Self.maxBytes else { return }
            let victims = index.values.sorted { $0.lastAccessAt < $1.lastAccessAt }
            for victim in victims {
                guard total > Self.maxBytes else { break }
                let freed = fileSize(binURL(victim.trackId)) ?? 0
                removeLocked(victim.trackId)
                total -= freed
                NSLog("%@", "[AudioCache] 超配额淘汰 id=\(victim.trackId)")
            }
        }
    }

    // MARK: - 私有：路径与索引

    /// 存储根目录（规格 6.1）：**Application Support**，不是 caches。
    ///
    /// cachesDirectory 是系统在存储紧张时**整目录回收**的地方，音频缓存落在那里会「莫名消失」，
    /// 索引与文件随之失配。这里在首次访问时 ensure 目录存在（iOS 上 Application Support
    /// 不保证已创建），并标记 `isExcludedFromBackup`：1GB 音频缓存不该占用户的 iCloud 备份。
    private static let directoryURL: URL = {
        let fm = FileManager.default
        // iOS 上一定有 applicationSupportDirectory；拿不到时手工拼同一条持久路径，
        // 绝不退回临时目录（同样可回收，违反 6.1）。
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        let dir = base.appendingPathComponent(AudioCacheStore.directoryName, isDirectory: true)
        AudioCacheStore.ensureDirectory(dir)
        AudioCacheStore.purgeLegacyCachesDirectoryOnce()
        return dir
    }()

    /// 必须先 ensure 再使用（Application Support 在 iOS 上可能不存在），
    /// 并保证 `isExcludedFromBackup` 已置位：目录的该标记对其全部内容生效，
    /// 1GB 音频缓存不该进用户的 iCloud 备份。
    private static func ensureDirectory(_ dir: URL) {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            NSLog("%@", "[AudioCache] 建目录失败 " + dir.path + " err=" + error.localizedDescription)
            return
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = dir
        do { try target.setResourceValues(values) } catch {
            NSLog("%@", "[AudioCache] 设置排除备份失败 " + dir.path + " err=" + error.localizedDescription)
        }
    }

    /// 旧位置（cachesDirectory/SuenAudioCache）的历史文件一次性清理：
    /// 旧索引在新目录下并不存在，旧文件在这里永远是孤儿 —— 不删只是白占空间。
    private static func purgeLegacyCachesDirectoryOnce() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: legacyPurgeKey) else { return }
        let fm = FileManager.default
        guard let legacyBase = fm.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            defaults.set(true, forKey: legacyPurgeKey)
            return
        }
        let legacy = legacyBase.appendingPathComponent(AudioCacheStore.directoryName, isDirectory: true)
        guard fm.fileExists(atPath: legacy.path) else {
            defaults.set(true, forKey: legacyPurgeKey)
            return
        }
        do {
            try fm.removeItem(at: legacy)
            defaults.set(true, forKey: legacyPurgeKey)
            NSLog("%@", "[AudioCache] 已清理旧 caches 目录 " + legacy.path)
        } catch {
            // 删除失败就不落标记位，下次启动再试一次（只是一次 fileExists，不扫目录）
            NSLog("%@", "[AudioCache] 清理旧 caches 目录失败 err=" + error.localizedDescription)
        }
    }

    private var dirURL: URL { Self.directoryURL }

    /// trackId 带冒号等字符，落文件名必须安全化；同时附加 id 的短摘要，
    /// 避免两条不同 id 安全化后撞成同一个文件名（原 id 另外完整存在 meta 里）。
    private func safeStem(_ trackId: String) -> String {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        var stem = String(trackId.map { allowed.contains($0) ? $0 : "_" })
        if stem.isEmpty || stem == "." || stem == ".." { stem = "track" }
        if stem.count > 80 { stem = String(stem.prefix(80)) }
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in trackId.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return stem + "-" + String(hash & 0xffff_ffff, radix: 16)
    }

    private func binURL(_ trackId: String) -> URL {
        dirURL.appendingPathComponent(safeStem(trackId) + ".bin")
    }

    /// 不再写 `.part`（规格 3.2 不留残片）；保留这个路径只为了删除旧版本留下的残片。
    private func partURL(_ trackId: String) -> URL {
        dirURL.appendingPathComponent(safeStem(trackId) + ".part")
    }

    private func metaURL(_ trackId: String) -> URL {
        dirURL.appendingPathComponent(safeStem(trackId) + ".json")
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    /// 首用时把磁盘上的 meta 读进内存（磁盘是真相，进程被杀也不丢）
    private func loadIndexLocked() {
        guard !indexLoaded else { return }
        indexLoaded = true
        index.removeAll()
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dirURL.path) else { return }
        for name in names where name.hasSuffix(".json") {
            let url = dirURL.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url),
                  let meta = try? JSONDecoder().decode(Meta.self, from: data),
                  !meta.trackId.isEmpty else { continue }
            index[meta.trackId] = meta
        }
    }

    private func writeMetaLocked(_ meta: Meta) {
        guard let data = try? JSONEncoder().encode(meta) else { return }
        try? data.write(to: metaURL(meta.trackId), options: .atomic)
    }

    private func removeLocked(_ trackId: String) {
        let fm = FileManager.default
        try? fm.removeItem(at: binURL(trackId))
        try? fm.removeItem(at: metaURL(trackId))
        try? fm.removeItem(at: partURL(trackId))
        index.removeValue(forKey: trackId)
    }

    private func fileSize(_ url: URL) -> Int64? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber else { return nil }
        return size.int64Value
    }
}
