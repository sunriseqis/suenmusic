//
//  AudioCacheStore.swift
//  SuenMusic
//
//  Created on 2026-10-28.
//  纯直链流式播放重构：彻底移除本地回环代理与全量后台缓存管道。
//  保留基础缓存清理接口，对齐系统纯直连 CDN 流式体验。
//

import Foundation

final class AudioCacheStore {
    static let shared = AudioCacheStore()
    static let maxBytes: Int64 = 4 * 1024 * 1024 * 1024 // 4GB

    private init() {}

    func usedBytes() -> Int64 {
        // 直链模式下无本地预缓存音频
        return 0
    }

    func entryCount() -> Int {
        return 0
    }

    func clearAll() {
        // 清理系统 URLCache 与临时缓存
        URLCache.shared.removeAllCachedResponses()
        if let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: cacheDir.appendingPathComponent("SuenAudioCache"))
        }
    }

    func clear() {
        clearAll()
    }

    func evict(id: String) {
        // 直链流式模式下无需逐首清理磁盘
    }

    func invalidateForServerSwitch() {
        clearAll()
    }

    func retryStalledDownloads() {
        // 直链模式由 AVPlayer 自带重试接管
    }

    func realDurationMs(_ id: String) -> Int {
        return 0
    }
}
