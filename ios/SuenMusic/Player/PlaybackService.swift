/**
 * 把播放内核接进 SwiftUI。
 *
 * 职责边界（原生化最重要的一条纪律）：
 *   · **播放状态机的 owner 是 AudioEngine**，本类只做三件事：
 *     ① 把用户意图翻译成引擎调用；② 把引擎事件翻译成 `@Published`；③ 解析/令牌/地址拼接。
 *   · 绝不在本类里保存第二份"队列/下标"的真相 —— `queue` 只是为了 UI 渲染而镜像的副本。
 */

import Foundation
import SwiftUI

@MainActor
final class PlaybackService: ObservableObject, AudioEngineEvents {

    static let shared = PlaybackService()

    @Published private(set) var queue: [Track] = []
    @Published private(set) var currentIndex: Int = -1
    @Published private(set) var playing: Bool = false
    @Published private(set) var positionMs: Int = 0
    @Published private(set) var durationMs: Int = 0
    @Published private(set) var loading: Bool = false
    @Published var errorMessage: String?
    /// 音源角标：bilibili / netease
    @Published private(set) var source: String = "bilibili"

    private var engine: AudioEngine?
    private var sessionToken: String?
    private var tokenExpiresAt: Date = .distantPast

    var currentTrack: Track? {
        guard queue.indices.contains(currentIndex) else { return nil }
        return queue[currentIndex]
    }

    private init() {}

    private func ensureEngine() -> AudioEngine? {
        if let engine { return engine }
        do {
            let created = try AudioEngine(events: self)
            engine = created
            return created
        } catch {
            errorMessage = "音频初始化失败：\(error.localizedDescription)"
            return nil
        }
    }

    // MARK: 令牌

    /// 流会话令牌：6 小时有效，提前 5 分钟续。拿不到就退回"无令牌"（服务端会 401，由引擎自愈）
    private func validToken(force: Bool = false) async -> String {
        if !force, let t = sessionToken, Date() < tokenExpiresAt { return t }
        struct Reply: Decodable { let token: String; let expiresInMs: Double }
        do {
            let r: Reply = try await APIClient.shared.get("/api/stream/session-token")
            sessionToken = r.token
            tokenExpiresAt = Date().addingTimeInterval(r.expiresInMs / 1000 - 300)
            return r.token
        } catch {
            return sessionToken ?? ""
        }
    }

    // MARK: 用户意图

    func play(tracks: [Track], startingAt index: Int) async {
        guard !tracks.isEmpty, tracks.indices.contains(index) else { return }
        guard let engine = ensureEngine() else { return }
        loading = true
        errorMessage = nil
        queue = tracks
        currentIndex = index

        let token = await validToken()
        let mapped = tracks.map(Self.toNative)
        do {
            try engine.setQueue(
                baseUrl: APIClient.shared.baseURL,
                token: token,
                tracks: mapped,
                startIndex: index,
                startPositionMs: 0,
                autoplay: true,
                tailOnly: false
            )
        } catch {
            loading = false
            errorMessage = "无法装载音源：\(error.localizedDescription)"
        }
    }

    func toggle() {
        guard let engine, engine.currentIndex >= 0 else { return }
        if playing { engine.pause() } else { engine.play() }
    }

    func next() { _ = engine?.skipToNext() }
    func prev() { _ = engine?.skipToPrevious() }
    func seek(to ms: Int) { engine?.seek(to: max(0, ms)) }

    func setRepeat(_ mode: String) { engine?.setRepeatMode(mode) }

    /// 切服/改地址后：把队列重发到新地址（原生队列里存的是绝对 URL，换 base 即全失效）
    func rebind(baseUrl: String) {
        guard let engine, !queue.isEmpty, currentIndex >= 0 else { return }
        Task {
            let token = await validToken(force: true)
            try? engine.setQueue(
                baseUrl: APIClient.shared.baseURL,
                token: token,
                tracks: queue.map(Self.toNative),
                startIndex: currentIndex,
                startPositionMs: positionMs,
                autoplay: playing,
                tailOnly: false
            )
        }
    }

    static func toNative(_ t: Track) -> SuenTrack {
        SuenTrack(id: t.id, title: t.name, artist: t.artistLine,
                  album: t.al.name, coverUrl: t.al.picUrl, durationMs: t.dt)
    }

    // MARK: AudioEngineEvents（引擎在主线程回调，这里可直接改 @Published）

    nonisolated func emitProgress(index: Int, positionMs: Int, durationMs: Int, playing: Bool) {
        Task { @MainActor in
            if self.currentIndex != index { self.currentIndex = index }
            self.positionMs = positionMs
            if durationMs > 0 { self.durationMs = durationMs }
            self.playing = playing
            self.loading = false
        }
    }

    nonisolated func emitTrackChange(index: Int, id: String, reason: Int) {
        Task { @MainActor in
            self.currentIndex = index
            // 时长先落元数据值，等流的精确值（X-Audio-Duration-Ms）回来再覆盖
            if self.queue.indices.contains(index) { self.durationMs = self.queue[index].dt }
        }
    }

    nonisolated func emitState(playing: Bool) {
        Task { @MainActor in
            self.playing = playing
            if playing { self.loading = false }
        }
    }

    nonisolated func emitError(message: String) {
        Task { @MainActor in
            self.errorMessage = message
            self.loading = false
        }
    }
}
