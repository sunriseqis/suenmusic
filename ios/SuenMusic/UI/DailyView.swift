import SwiftUI

/**
 * 每日推荐（「专属」tab）—— **对齐鸿蒙端 pages/DailyPage.ets**。
 *
 * 只读：歌单由服务端每天 00:30 产出，**没有「换一批」**。
 * 头部：greeting 拆主标题/副题（hw parseAiHeader 同口径）+ 日期 + 首数 + 播放全部；
 * 列表：一律走公共 TrackRow（行尾「不喜欢」钮 → 自绘 DislikeDialog 选范围）；
 * 加载态：SkeletonList；空态：EmptyState + Copy；瞬时错误/收藏，「不喜欢」结果：ToastCenter + Copy.describe。
 */
struct DailyView: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    /// 服务端原始返回（头部/空态判定用；tracks 单独持一份，便于「不喜欢」后就地剪行）
    @State private var data: DailyRecommend?
    /// 列表真相（data.tracks 是不可变的，剪行改这里）
    @State private var tracks: [Track] = []
    @State private var loading = false
    /// 首屏失败文案（Copy.describe 产出）：只在完全没有数据时占屏
    @State private var err = ""
    /// 已收藏曲目 id（右滑收藏的动作区文案 / 序号染色；拉取失败静默）
    @State private var favIds: Set<String> = []
    /// 待确认的「不喜欢」目标（nil = 弹窗关）
    @State private var dislikeAsk: Track?

    /// greeting 拆不出主标题时的回退页名（hw DEFAULT_HEADER_TITLE 同款）
    private static let defaultHeaderTitle = "专属推荐"
    /// 队列来源（hw setQueue 的 origin）
    private static let originDaily = "每日推荐"
    /// 列表预热条数（起播前把前 10 首的音源解析好）
    private static let warmLimit = 10
    /// 空态文案：hw DailyPage 的 generating / error 分支字面量（Copy 表无对应键）
    private static let generatingText = "今日歌单正在生成，稍后再来看看"
    private static let failedText = "今日歌单生成失败"
    /// 「不喜欢该歌手」但没有可识别歌手时的提示（hw 同文案）
    private static let noArtistText = "这首曲目没有可识别的歌手信息"
    /// 主标题候选长度窗口（hw parseAiHeader：2~10 字）
    private static let headerMinLen = 2
    private static let headerMaxLen = 10
    /// 无逗号时整句当主标题的长度上限（hw parseAiHeader：≤8 字）
    private static let headerShortLen = 8
    /// 非 ApiError 的兜底状态码（Copy.describe 按服务端 5xx 出话术）
    private static let fallbackStatus = 500
    /// 首屏骨架列表行数（与真实列表同构的占位行）
    private static let skeletonRows = 8

    private var p: Palette { Palette(scheme) }

    var body: some View {
        ZStack {
            Group {
                if loading && data == nil {
                    SkeletonList(withPoster: false, rows: Self.skeletonRows)
                } else if let data {
                    content(data)
                } else if !err.isEmpty {
                    EmptyState(title: err, actionTitle: "重试") {
                        Task { await load() }
                    }
                } else {
                    SkeletonList(withPoster: false, rows: Self.skeletonRows)
                }
            }
            .background(p.bg)

            // 「不喜欢」选择弹窗（自绘哑光三选，hw 同款）
            if let ask = dislikeAsk {
                DislikeDialog(
                    trackName: ask.name,
                    artistName: ask.ar.first?.name ?? "",
                    onTrack: {
                        dislikeAsk = nil
                        Task { await dislikeTrack(ask) }
                    },
                    onArtist: {
                        dislikeAsk = nil
                        Task { await dislikeArtist(ask) }
                    },
                    onCancel: { dislikeAsk = nil }
                )
            }
        }
        .task {
            if data == nil { await load() } else { await refreshFavMarks(tracks) }
            if !tracks.isEmpty { player.warm(tracks, limit: Self.warmLimit) }
            #if DEBUG
            // 无触摸环境验 Live Activity / 播放页：SUEN_AUTOPLAY=1 进「专属」后自动播第一首
            if DebugHooks.string("SUEN_AUTOPLAY") == "1", !tracks.isEmpty {
                // 可指定从第几首起播（0 基），便于挑"从未播过"的冷门曲测起播耗时
                let idx = DebugHooks.int("SUEN_AUTOPLAY_INDEX") ?? 0
                let start = min(max(0, idx), tracks.count - 1)
                NSLog("[Start] 自动播放 index=\(start) id=\(tracks[start].id)")
                await player.play(tracks: tracks, startingAt: start, origin: Self.originDaily)
            }
            #endif
        }
        // 播放页 dislike 落地后跨页同步（hw K_DAILY_REFRESH 同口径：重拉即最新）
        .onReceive(NotificationCenter.default.publisher(for: PlaybackService.dailyRefreshNeeded)) { _ in
            Task { await load() }
        }
        .onReceive(NotificationCenter.default.publisher(for: PlaybackService.favoritesChanged)) { note in
            guard let id = note.userInfo?["id"] as? String, let fav = note.userInfo?["fav"] as? Bool else { return }
            if fav { favIds.insert(id) } else { favIds.remove(id) }
        }
        .onReceive(NotificationCenter.default.publisher(for: RefreshSignal.name)) { note in
            guard (note.object as? Int) == 1 else { return }
            Task { await load() }
        }
    }

    // MARK: - 主体

    private func content(_ data: DailyRecommend) -> some View {
        VStack(spacing: 0) {
            header(data)
            if tracks.isEmpty {
                emptyState(data)
            } else {
                // 用系统 `List` + `.swipeActions` 承载右滑收藏：
                //   · 方向仲裁由系统做 → 纵向滚动与横向滑动天生不冲突（自绘 DragGesture 会抢滚动；
                //     UIKit pan 在 SwiftUI 扁平化的行上收不到触摸，两条路都试过）；
                //   · hw 的等价实现是 `PanGesture(direction: .Horizontal)`，系统 swipe 就是同一语义。
                List {
                    ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                        TrackRow(
                            track: track,
                            index: index + 1,
                            isFav: favIds.contains(track.id),
                            dislikeable: true,
                            showDur: false,
                            playing: player.currentTrack?.id == track.id,
                            onTap: { Task { await playAt(index) } },
                            onSwipeToggle: { await toggleFav(track) },
                            onDislike: { dislikeAsk = track }
                        )
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        // 右滑收藏用系统 `.swipeActions`：方向仲裁由系统做，纵向滚动不受影响
                        //（与 hw `PanGesture(direction: .Horizontal)` 同语义）。
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            let on = favIds.contains(track.id)
                            Button {
                                Task { await toggleFav(track) }
                            } label: {
                                Label(on ? "取消收藏" : "收藏",
                                      systemImage: on ? "heart.slash" : "heart")
                            }
                            .tint(on ? DesignTokens.swipeFavBg : DesignTokens.accentText)
                        }
                        .id("\(track.id)|\(favIds.contains(track.id))")   // 收藏态进身份：强制重建 UIKit 行的 swipe 配置
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .scrollIndicators(.hidden)
                .refreshable { await load() }
            }
        }
    }

    // MARK: - 头部（hw head-info：greeting 首逗号前为主标题、其后为副题）

    private func header(_ data: DailyRecommend) -> some View {
        // 生成失败时**问候语位置直接显示失败原因**（用户口径：别让用户对着空列表猜）
        let failed = data.status == "failed"
        let head = Self.parseHeader(
            failed ? (data.statusMessage ?? Self.failedText) : (data.greeting ?? ""),
            defaultTitle: Self.defaultHeaderTitle
        )
        return VStack(alignment: .leading, spacing: Dim.s1) {
            Text(head.title)
                .font(.system(size: Dim.fsDisplay, weight: .medium))
                .foregroundStyle(p.text1)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !head.sub.isEmpty {
                Text(head.sub)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text2)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !tracks.isEmpty {
                HStack(spacing: Dim.s3) {
                    if let date = data.date, !date.isEmpty {
                        Text(date)
                            .font(.system(size: Dim.fsCaption))
                            .foregroundStyle(p.text2)
                    }
                    Text("\(tracks.count) 首")
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(p.text2)
                }
                .padding(.top, Dim.s1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s3)
        // hw 第 ⑮ 条：推荐语与曲目列表间距 = sp-4
        .padding(.bottom, Dim.s4)
    }

    // MARK: - 空态（hw DailyPage：shortfall / generating / error / 兜底四分支）

    @ViewBuilder
    private func emptyState(_ data: DailyRecommend) -> some View {
        let message = data.message ?? ""
        switch data.status ?? "" {
        case "shortfall":
            // 曲库不足是正常业务结果：统一空态，不重试、不报错
            EmptyState(
                title: message.isEmpty ? Copy.dailyEmptyTitle : message,
                subtitle: Copy.dailyEmptySub
            )
        case "generating":
            EmptyState(title: message.isEmpty ? Self.generatingText : message)
        case "failed":
            // 生成失败（模型侧问题，服务端给的是可直接上屏的文案）。
            // 不给「重试」：服务端已关闭手动重建口子，重试只会空转。
            EmptyState(title: data.statusMessage ?? Self.failedText)
        case "error":
            EmptyState(
                title: message.isEmpty ? Self.failedText : message,
                actionTitle: "重试",
                action: { Task { await load() } }
            )
        default:
            // ready 但曲目被过滤成空：与 shortfall 同口径
            EmptyState(title: Copy.dailyEmptyTitle, subtitle: Copy.dailyEmptySub)
        }
    }

    // MARK: - 数据

    private func load() async {
        if loading { return }
        loading = true
        err = ""
        defer { loading = false }
        do {
            let reply = try await APIClient.shared.dailyRecommend()
            data = reply
            tracks = reply.tracks
            await refreshFavMarks(reply.tracks)
        } catch {
            // 刷新失败不覆盖已有数据（hw 同口径）
            let text = Self.describe(error)
            if data == nil { err = text }
            ToastCenter.shared.show(text)
        }
    }

    private func playAt(_ index: Int) async {
        await player.play(tracks: tracks, startingAt: index, origin: Self.originDaily)
    }

    /// 播放全部（happy path 从第 0 首起）
    private func playAll() async {
        guard !tracks.isEmpty else { return }
        await player.play(tracks: tracks, startingAt: 0, origin: Self.originDaily)
    }

    // MARK: - 收藏（右滑手势的支撑，失败静默 + toast）

    /// 整批覆盖（不是只补未知）：别处取消收藏后回到本页，旧红心要能被清掉
    private func refreshFavMarks(_ list: [Track]) async {
        guard !list.isEmpty else { return }
        favIds = Set(await player.favoredIds(list.map(\.id)))
    }

    private func setFav(_ trackId: String, _ fav: Bool) {
        if fav { favIds.insert(trackId) } else { favIds.remove(trackId) }
    }

    /// 右滑过阈值：乐观翻转 + 服务端落地，失败回滚 + Copy.describe 文案 toast
    private func toggleFav(_ track: Track) async -> Bool {
        let wasFav = favIds.contains(track.id)
        setFav(track.id, !wasFav)
        guard let next = await player.toggleFavorite(track, currentlyFavored: wasFav) else {
            setFav(track.id, wasFav)
            ToastCenter.shared.show(Copy.describe(status: Self.fallbackStatus, code: nil, message: nil))
            return false
        }
        setFav(track.id, next)
        return true
    }

    // MARK: - 不喜欢调优（hw DailyPage：track / artist 两级，落地后同时摘歌单与队列）

    private func dislikeTrack(_ track: Track) async {
        do {
            try await APIClient.shared.addDislike(type: "track", id: track.id, name: track.name)
        } catch {
            ToastCenter.shared.show(Self.describe(error))
            return
        }
        ToastCenter.shared.show("已不再推荐「\(track.name)」")
        await removeFromList(track)
    }

    private func dislikeArtist(_ track: Track) async {
        guard let first = track.ar.first, !first.id.isEmpty else {
            ToastCenter.shared.show(Self.noArtistText)
            return
        }
        do {
            try await APIClient.shared.addDislike(type: "artist", id: first.id, name: first.name)
        } catch {
            ToastCenter.shared.show(Self.describe(error))
            return
        }
        ToastCenter.shared.show("已不再推荐歌手「\(first.name)」的相关歌曲")
        // 该歌手的所有歌都从当日歌单与队列里摘掉（快照迭代，逐首摘）
        let targets = tracks.filter { $0.ar.first?.id == first.id }
        for target in targets { await removeFromList(target) }
    }

    /// 把一首歌从「当日歌单 + 播放队列」里同时摘掉。自然缩水，不补位。
    private func removeFromList(_ track: Track) async {
        if let index = player.queueSnapshot.firstIndex(where: { $0.id == track.id }) {
            await player.removeAt(index)
        }
        tracks.removeAll { $0.id == track.id }
    }

    // MARK: - 文案

    /// 错误 → 用户可读文案（一律经 Copy.describe，页面不自造错误话术）
    private static func describe(_ error: Error) -> String {
        guard let e = error as? ApiError else {
            return Copy.describe(status: fallbackStatus, code: nil, message: nil)
        }
        return Copy.describe(status: e.status, code: e.code.isEmpty ? nil : e.code, message: e.message)
    }

    // MARK: - AI 导语解析（hw Copy.cleanAiText + parseAiHeader 逐句同口径）

    private struct AiHeader {
        let title: String
        let sub: String
    }

    /// 清 Markdown 残留 / 引号 / 前导杂标点，规范空白（hw cleanAiText 同表）
    private static func cleanAiText(_ raw: String) -> String {
        var s = raw
        for (pattern, replacement) in [
            ("```[\\s\\S]*?```", " "),
            ("`([^`]+)`", "$1"),
            ("(?:^|\\n)\\s*#+\\s*", " "),
            ("#+", ""),
            ("\\*\\*([^*]+)\\*\\*", "$1"),
            ("\\*([^*]+)\\*", "$1"),
            ("__([^_]+)__", "$1"),
            ("_([^_]+)_", "$1"),
            ("~~([^~]+)~~", "$1"),
            ("(?:^|\\n)\\s*>\\s*", " "),
            ("(?:^|\\n)\\s*[-*+]\\s+", " "),
            ("[\"“”'‘’]", ""),
            ("\\s+", " "),
        ] {
            s = s.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: "^[，,：:;；、\\-—\\s]+", with: "", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespaces)
    }

    /// 首个逗号前（2~10 字）作主标题、其后作副题；拆不出主标题时整句落副题、主标题回退页名
    private static func parseHeader(_ raw: String, defaultTitle: String) -> AiHeader {
        let text = cleanAiText(raw)
        if text.isEmpty { return AiHeader(title: defaultTitle, sub: "") }
        if let comma = text.rangeOfCharacter(from: CharacterSet(charactersIn: "，,\n")),
           comma.lowerBound != text.startIndex {
            let head = String(text[text.startIndex..<comma.lowerBound]).trimmingCharacters(in: .whitespaces)
            let tail = String(text[comma.upperBound...])
                .replacingOccurrences(of: "^[，,\\s]+", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            // 严格防御漏网的英文安全/风控标签爬上主标题位
            if head.range(of: "safety|system|assistant", options: [.regularExpression, .caseInsensitive]) != nil {
                return AiHeader(title: defaultTitle, sub: tail)
            }
            if head.count >= headerMinLen, head.count <= headerMaxLen, !tail.isEmpty {
                return AiHeader(title: head, sub: tail)
            }
        }
        if text.count <= headerShortLen,
           text.range(of: "safety", options: .caseInsensitive) == nil {
            return AiHeader(title: text, sub: "")
        }
        return AiHeader(title: defaultTitle, sub: text)
    }
}
