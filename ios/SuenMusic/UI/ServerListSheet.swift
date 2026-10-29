import SwiftUI

/**
 * 服务端管理（底部浮层）—— **对齐鸿蒙端 `pages/ServerListPage.ets`**。
 *
 * 列出全部候选 + 可达状态（四态：未知 / 检测中 / 可达 / 不可达，不用布尔红绿灯防进页闪红）、
 * 新增（名称 / 地址）、编辑（改名 / 改地址）、删除（删当前在用的先自动切到剩余第一个）、
 * 「切换」二次确认后走探测 → 换 base → 验证账号 → 失败整笔回滚，成功再让播放内核重建队列。
 *
 * 存储方案：**不另起一份列表**。本机列表与当前地址本来就落在 `ServerRouter`
 * （`suenmusic.servers` / `suenmusic.baseUrl`，`AppState.login` 与自动选路都在用），
 * 这里只是 UI 层小 store，负责状态机 + 校验文案 + 探活 + 切服回滚，读写都经它，
 * 两份存储会让自动选路和这个面板互相看不见对方的修改。
 */

// MARK: - 探测四态

/// hw `ST_UNKNOWN / ST_CHECKING / ST_OK / ST_BAD`
enum ServerProbeState {
    case unknown, checking, ok, bad
}

// MARK: - 视图模型

@MainActor
final class ServerStore: ObservableObject {

    /// 刷新令牌键（与 `APIClient`/`AppState` 同一个键；只读，不写）
    static let refreshKey = "suenmusic.refreshToken"
    /// 切换失败且原因是鉴权时给用户看的文案（hw `switchServer` 的 401 分支同句）
    static let unauthorizedMessage = "该服务器上你的账号需要重新登录"
    /// 切服验证的请求超时（与 hw `APIClient.request` 默认 15000ms 同值）
    private static let verifyTimeout: TimeInterval = 15

    /// 待确认的动作（hw 用系统 `showAlertDialog`，iOS 用自绘 `ConfirmDialog`）
    struct Ask: Identifiable {
        let id = UUID()
        let title: String
        let message: String
        let confirmTitle: String
        let run: () -> Void
    }

    @Published private(set) var servers: [ServerCandidate] = []
    /// 与 servers 平行的探测状态
    @Published private(set) var status: [ServerProbeState] = []
    @Published private(set) var currentBase: String = ""
    /// 切换中：禁止再次发起切换 / 删除，防止半切换状态叠加
    @Published private(set) var busy = false
    @Published private(set) var notice = ""
    /// >= 0 = 表单处于编辑模式（正在编辑该下标的服务器）；-1 = 新增模式
    @Published private(set) var editingIndex = -1
    @Published var adding = false
    @Published var newName = ""
    @Published var newUrl = ""
    @Published private(set) var ask: Ask?

    /// 切换成功后回调宿主：队列里存的是绝对 URL，换服必须重建队列（保曲目/位置/播放意图）
    var onSwitched: ((String) -> Void)?

    init() { load() }

    // MARK: 载入与探活

    func load() {
        servers = ServerRouter.shared.candidates
        currentBase = ServerRouter.shared.currentBaseURL
        status = Array(repeating: .checking, count: servers.count)
    }

    /// 进页：先全部置「检测中」，再并发探测（对齐 hw `aboutToAppear`）
    func start() async {
        load()
        await probeAll()
    }

    func probeAll() async {
        let list = servers
        guard !list.isEmpty else { return }
        status = Array(repeating: .checking, count: list.count)
        let flags = await withTaskGroup(of: (String, Bool).self, returning: [String: Bool].self) {
            group in
            for server in list {
                let url = server.url
                group.addTask { (url, await APIClient.shared.health(base: url)) }
            }
            var out: [String: Bool] = [:]
            for await (url, ok) in group { out[url] = ok }
            return out
        }
        // 探测期间列表可能被增删：按地址回填，回填不到的保持「检测中」
        var next = status
        for (i, server) in servers.enumerated() where next.indices.contains(i) {
            if let ok = flags[server.url] { next[i] = ok ? .ok : .bad }
        }
        status = next
    }

    func probeOne(_ i: Int) async {
        guard servers.indices.contains(i) else { return }
        setStatus(.checking, at: i)
        let ok = await APIClient.shared.health(base: servers[i].url)
        setStatus(ok ? .ok : .bad, at: i)
    }

    private func setStatus(_ value: ServerProbeState, at i: Int) {
        guard status.indices.contains(i) else { return }
        status[i] = value
    }

    /// 当前在用服务端的显示名（列表只显名称；找不到就回退地址本身，再没有就是「未设置」）
    var currentName: String {
        if let hit = servers.first(where: { $0.url == currentBase }) { return hit.name }
        return currentBase.isEmpty ? "未设置" : currentBase
    }

    private static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    // MARK: 确认框

    func dismissAsk() { ask = nil }

    func confirmAsk() {
        let action = ask?.run
        ask = nil
        action?()
    }

    // MARK: 表单

    /// 右上「+」：展开/收起新增表单（收起时清空输入与编辑态）
    func toggleAddForm() {
        if adding {
            cancelForm()
            return
        }
        editingIndex = -1
        newName = ""
        newUrl = ""
        adding = true
    }

    func cancelForm() {
        adding = false
        editingIndex = -1
        newName = ""
        newUrl = ""
    }

    /// 进入编辑模式：预填该条的名称 / 地址
    func startEdit(_ i: Int) {
        guard !busy, servers.indices.contains(i) else { return }
        editingIndex = i
        newName = servers[i].name
        newUrl = servers[i].url
        adding = true
    }

    func saveForm() async {
        if editingIndex >= 0 {
            await saveEdit()
            return
        }
        await addServer()
    }

    /// 新增（hw `addServer`）：空 / 非 http(s) / 重复 三种校验文案逐字照搬
    private func addServer() async {
        let url = Self.normalize(newUrl)
        guard !url.isEmpty else {
            notice = "请输入服务器地址"
            return
        }
        guard url.hasPrefix("http://") || url.hasPrefix("https://") else {
            notice = "地址需以 http:// 或 https:// 开头"
            return
        }
        guard !servers.contains(where: { $0.url == url }) else {
            notice = "该地址已在列表中"
            return
        }
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmed.isEmpty ? "服务器 \(servers.count + 1)" : trimmed
        let list = servers + [ServerCandidate(url: url, name: name)]
        persist(list)
        status.append(.checking)
        cancelForm()
        notice = "已添加，正在检测可达性…"
        await probeOne(list.count - 1)
    }

    private func saveEdit() async {
        let i = editingIndex
        guard servers.indices.contains(i) else { return }
        let url = Self.normalize(newUrl)
        guard !url.isEmpty else {
            notice = "请输入服务器地址"
            return
        }
        guard url.hasPrefix("http://") || url.hasPrefix("https://") else {
            notice = "地址需以 http:// 或 https:// 开头"
            return
        }
        let old = servers[i]
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmed.isEmpty ? old.name : trimmed
        let urlChanged = url != old.url
        if urlChanged, servers.enumerated().contains(where: { $0.offset != i && $0.element.url == url }) {
            notice = "该地址已在列表中"
            return
        }
        var list = servers
        list[i] = ServerCandidate(url: url, name: name)

        // 改的是当前在用服务器的地址：后果等同切换 —— 先说清后果，再走同一条切换链路
        if urlChanged, old.url == currentBase {
            ask = Ask(
                title: "修改当前服务器地址",
                message: "该服务器正在使用，保存后将连接新地址，并从当前位置继续播放。",
                confirmTitle: "保存并切换",
                run: { [weak self] in
                    Task { await self?.applyEdit(list, at: i, old: old) }
                }
            )
            return
        }
        await applyEdit(list, at: i, old: old)
    }

    /**
     * 落盘编辑结果。改了地址会重探测；
     * 若改的是当前在用服务器的地址，先走 `switchBase`（探测 → 验证 → 落盘 base），
     * 切换失败则**整笔回滚**：列表不落盘、面板不更新，只把原因写进 notice。
     */
    private func applyEdit(_ list: [ServerCandidate], at i: Int, old: ServerCandidate) async {
        guard !busy, list.indices.contains(i) else { return }
        let urlChanged = list[i].url != old.url
        if urlChanged, old.url == currentBase {
            busy = true
            notice = "正在切换到 \(list[i].url) …"
            do {
                try await switchBase(to: list[i].url)
            } catch {
                notice = "保存失败：" + errText(error)
                busy = false
                return
            }
            busy = false
        }
        persist(list)
        if urlChanged { await probeOne(i) }
        notice = "已保存"
        cancelForm()
    }

    // MARK: 切换

    /// 切换确认：后果必须说清，不写「确定要切换吗」这种没信息量的话
    func confirmSwitch(to url: String) {
        guard !busy, url != currentBase else { return }
        ask = Ask(
            title: "切换服务器",
            message: "切换后将重新加载当前播放，队列会从当前位置继续播放。",
            confirmTitle: "切换",
            run: { [weak self] in
                Task { await self?.doSwitch(to: url) }
            }
        )
    }

    func doSwitch(to url: String) async {
        guard !busy else { return }
        busy = true
        notice = "正在切换服务器…"
        do {
            try await switchBase(to: url)
            notice = "已切换到 " + currentBase
        } catch {
            let text = errText(error)
            notice = text.isEmpty ? "切换失败，已回滚到原服务器" : text
        }
        busy = false
    }

    /**
     * 切换当前服务端（对齐 hw `APIClient.switchServer`）：
     * 探测 → 换 base 并**清访问令牌、保留刷新令牌**（用刷新令牌去新服务器换一次会话，
     * 旧 accessToken 一个字都不发）→ `GET /api/auth/me` 验证账号 →
     * 成功才落盘 `base_url`；任一步失败**整笔回滚**（地址与令牌状态都不动）。
     */
    func switchBase(to raw: String) async throws {
        let target = Self.normalize(raw)
        guard !target.isEmpty else {
            throw ApiError(status: 0, code: "invalid", message: "服务器地址不能为空")
        }
        guard target != Self.normalize(ServerRouter.shared.currentBaseURL) else { return }
        guard await APIClient.shared.health(base: target) else {
            throw ApiError(status: 0, code: "unreachable", message: "连不上该服务器，请检查地址或网络")
        }
        // 验证期间只碰局部变量：换服没有半成品状态，失败自然就是回滚
        let session = try await Self.verifyAccount(on: target)
        APIClient.shared.adopt(session)
        ServerRouter.shared.currentBaseURL = target
        currentBase = ServerRouter.shared.currentBaseURL
        onSwitched?(currentBase)
    }

    /// 在目标服务器上验证「这台服务器上你的账号还在」：刷新令牌换会话 + `/api/auth/me`
    ///
    /// ## 两步的顺序与失败语义（2026-10-29 修正）
    ///
    /// ① 刷新令牌换会话 —— 走 `APIClient.rotateTokens(on:)`：
    ///   · **刷新成功即落盘**（与 hw `refresh()` 同语义），不等第 ② 步；
    ///   · 与常规 401 刷新**共用单飞槽位**，不会两边并发轮换同一个令牌。
    /// ② `/api/auth/me` 验证账号确实在这台服务器上。
    ///
    /// 为什么 ① 必须自己落盘：服务端刷新时会**立刻吊销旧令牌**。若把新令牌攒到 ② 成功
    /// 才保存，那么 ② 一失败（典型：域名同时有 IPv4/IPv6 记录，iOS 对连续两个请求可能选不同
    /// 地址族，① 走通的那条、② 撞上不通的那条）新令牌就永久丢失 —— 客户端只剩已吊销的旧令牌，
    /// 之后切**任何**服务器都 401，等于被静默登出。hw 端从没这个问题的原因就在这。
    private static func verifyAccount(on base: String) async throws -> AuthSession {
        guard let refresh = UserDefaults.standard.string(forKey: refreshKey), !refresh.isEmpty else {
            throw ApiError(status: 401, code: "unauthorized", message: unauthorizedMessage)
        }
        struct MeReply: Decodable { let user: PublicUser }
        NSLog("[Switch] verifyAccount base=%@ tokenLen=%d", base, refresh.count)
        // ① 刷新（内部已单飞 + 成功即落盘）；失败按切服文案映射
        let session: AuthSession
        do {
            session = try await APIClient.shared.rotateTokens(on: base)
        } catch let e as ApiError where e.isUnauthorized {
            throw ApiError(status: 401, code: "unauthorized", message: unauthorizedMessage)
        } catch let e as ApiError where e.isNetwork {
            throw ApiError(status: 0, code: "network", message: "切换失败：连不上该服务器")
        }
        // ② 验证账号（失败时新令牌已落盘，回滚地址也不会把账号废掉）
        let me: MeReply = try await send(base + "/api/auth/me", method: "GET",
                                         body: nil, token: session.accessToken)
        return AuthSession(user: me.user,
                           accessToken: session.accessToken,
                           refreshToken: session.refreshToken,
                           accessExpiresAt: session.accessExpiresAt,
                           refreshExpiresAt: session.refreshExpiresAt)
    }

    /**
     * 文件内的最小 HTTP：刻意**不走** `APIClient.send` —— 那套管线读的是「当前 base」，
     * 切服期间正好是半成品状态，而且它自带选路重放，会把验证请求打到别的候选上去。
     * 只做「目标 base 的直连 + 状态码到文案的映射」。
     */
    private static func send<T: Decodable>(_ urlString: String, method: String,
                                           body: Data?, token: String?) async throws -> T {
        guard let url = URL(string: urlString) else {
            throw ApiError(status: 0, code: "bad_url", message: "服务器地址无效")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = verifyTimeout
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("Accept", forHTTPHeaderField: "application/json")
        if let token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw ApiError(status: 0, code: "network", message: "切换失败：连不上该服务器")
        }
        guard let http = resp as? HTTPURLResponse else {
            throw ApiError(status: 0, code: "bad_response", message: "切换失败：服务端返回异常")
        }
        // 诊断：把「哪个 URL 返回了什么码 + 响应体前 200 字」打出来，
        // 400 这类契约级失败靠状态码本身定位不了。
        if !(200..<300).contains(http.statusCode) {
            NSLog("[Switch] %@ %@ → HTTP %d body=%@",
                  method, urlString, http.statusCode,
                  String(data: data.prefix(200), encoding: .utf8) ?? "(binary)")
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw ApiError(status: 401, code: "unauthorized", message: unauthorizedMessage)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ApiError(status: http.statusCode, code: "http_\(http.statusCode)",
                           message: "切换失败：服务端返回 HTTP \(http.statusCode)")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ApiError(status: http.statusCode, code: "decode", message: "切换失败：响应解析失败")
        }
    }

    // MARK: 删除

    /// 删除（hw `deleteServer`）：删当前在用的先切到剩余第一个，**切失败不删**；
    /// 只剩一个 → 「这是最后一个服务器，不能删除」。
    func delete(_ i: Int) async {
        guard !busy, servers.indices.contains(i) else { return }
        let target = servers[i]
        let rest = servers.enumerated().filter { $0.offset != i }.map(\.element)
        if target.url == currentBase {
            guard !rest.isEmpty else {
                notice = "这是最后一个服务器，不能删除"
                return
            }
            busy = true
            notice = "正在切换到 \(rest[0].url) …"
            do {
                try await switchBase(to: rest[0].url)
            } catch {
                notice = "切换失败，未删除：" + errText(error)
                busy = false
                return
            }
            busy = false
        }
        persist(rest)
        status = status.enumerated().filter { $0.offset != i }.map(\.element)
        notice = "已删除 " + target.name
    }

    // MARK: 落盘

    private func persist(_ list: [ServerCandidate]) {
        ServerRouter.shared.save(candidates: list)
        ServerRouter.shared.currentBaseURL = currentBase
        servers = list
    }

    private func errText(_ error: Error) -> String {
        (error as? ApiError)?.message ?? "连不上服务端，请检查网络或服务器地址"
    }
}

// MARK: - 浮层

/**
 * 底部浮层：scrim 背板 + panel 卡片（上两角 radiusLg）。
 * 承载方以 `.fullScreenCover` + `.presentationBackground(.clear)` 呈现即是 hw 的
 * 「底部上滑转场、只占内容区」；点背板**不关浮层**（避免误触丢输入）。
 */
struct ServerListSheet: View {
    @Environment(\.colorScheme) private var scheme

    /// 收起回调（hw `onClose`：右上 chevron-down / 承载方背板）
    var onClose: () -> Void = {}

    @StateObject private var store = ServerStore()

    private var p: Palette { Palette(scheme) }

    var body: some View {
        ZStack(alignment: .bottom) {
            p.scrim
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture {
                    onClose()
                }
            panel
                .contentShape(Rectangle())
                .onTapGesture {}
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .task {
            store.onSwitched = { base in
                // 队列非空才需要重建：内核会重新取流令牌，按当前曲目/位置/播放意图续播
                guard !PlaybackService.shared.queue.isEmpty else { return }
                PlaybackService.shared.rebind(baseUrl: base)
            }
            await store.start()
        }
        .overlay {
            if let ask = store.ask {
                ConfirmDialog(title: ask.title, message: ask.message, cancelTitle: "取消",
                              confirmTitle: ask.confirmTitle,
                              onCancel: { store.dismissAsk() },
                              onConfirm: { store.confirmAsk() })
            }
        }
    }

    // MARK: 面板

    private var panel: some View {
        VStack(spacing: Dim.s3) {
            grip
            head
            Text("当前：" + store.currentName)
                .font(.system(size: Dim.fsMinor))
                .foregroundStyle(p.text2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !store.notice.isEmpty {
                Text(store.notice)
                    .font(.system(size: Dim.fsMinor))
                    .foregroundStyle(p.accentText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if store.servers.isEmpty { emptyHint } else { serverList }
            if store.adding { addForm }
        }
        .padding(.horizontal, Dim.s4)
        .padding(.top, Dim.s3)
        .padding(.bottom, Dim.s4)
        .background(
            UnevenRoundedRectangle(topLeadingRadius: Dim.radiusLg, topTrailingRadius: Dim.radiusLg,
                                   style: .continuous)
                .fill(p.panel)
        )
    }

    /// 弹层顶把手（hw `sheetGrip`：web Sheet 的 .grip 同款）
    private var grip: some View {
        Capsule()
            .fill(p.line)
            .frame(width: Dim.gripW, height: Dim.gripH)
    }

    private var head: some View {
        HStack(spacing: Dim.s2) {
            Text("服务端管理")
                .font(.system(size: Dim.fsSection, weight: .medium))
                .foregroundStyle(p.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
            // hw：+ 用 accentText、收起用 chevron-down text2（第 ⑱ 条 web 图标语言）
            sheetGlyphButton(.plus, tint: p.accentText, label: "新增服务器") {
                store.toggleAddForm()
            }
            sheetGlyphButton(.chevronDown, tint: p.text2, label: "收起") {
                onClose()
            }
        }
    }

    /**
     * hw `WebIconButton(chromeKind: PLAIN, glyphColor: xxx)` 的等价物。
     *
     * 不复用 `WebIconButton` 是因为它按样式定死字形色（.plain → text1），
     * 而 hw 这里要 accentText / text2 两种；未选中未按下时 PLAIN 的 chrome 本来就是透明，
     * 所以视觉上只剩字形色差别，按下反馈沿用同一套（panel2 底 + 顶沿高光 + 下沉 1）。
     */
    private func sheetGlyphButton(_ name: WebIconName, tint: Color, label: String,
                                  action: @escaping () -> Void) -> some View {
        Button(action: action) {
            WebIcon(name, size: Dim.icon18)
                .foregroundStyle(tint)
        }
        .buttonStyle(SheetGlyphStyle())
        .accessibilityLabel(label)
    }

    // MARK: 列表

    private var serverList: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(Array(store.servers.enumerated()), id: \.element.id) { i, server in
                    row(server, i)
                }
            }
        }
        .frame(maxHeight: Dim.serverListMax)
        .background(p.bg)
        .clipShape(RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
    }

    private func row(_ server: ServerCandidate, _ i: Int) -> some View {
        VStack(spacing: Dim.s2) {
            HStack(spacing: Dim.s2) {
                Circle()
                    .fill(statusColor(i))
                    .frame(width: Dim.s2, height: Dim.s2)
                Text(server.name)
                    .font(.system(size: Dim.fsBody))
                    .foregroundStyle(p.text1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if server.url == store.currentBase { currentChip }
                Text(statusText(i))
                    .font(.system(size: Dim.fsCaption))
                    .foregroundStyle(statusColor(i))
            }

            // 行内操作键（hw 第 ⑰ 条统一 WebButton 体系：ghost 切换 / 默认测试编辑 / 红字删除）
            HStack(spacing: Dim.s2) {
                if server.url != store.currentBase {
                    WebButton("切换", variant: .ghost, size: .sm) {
                        store.confirmSwitch(to: server.url)
                    }
                    .accessibilityLabel("切换到 \(server.name)")
                }
                WebButton("测试", size: .sm) {
                    Task { await store.probeOne(i) }
                }
                .accessibilityLabel("测试 \(server.name) 的连接")
                WebButton("编辑", size: .sm) {
                    store.startEdit(i)
                }
                .accessibilityLabel("编辑 \(server.name)")
                Spacer(minLength: 0)
                WebButton("删除", variant: .danger, size: .sm) {
                    Task { await store.delete(i) }
                }
                .accessibilityLabel("删除服务器 \(server.name)")
            }
        }
        .padding(.horizontal, Dim.s4)
        .padding(.vertical, Dim.s3)
        .overlay(alignment: .top) {
            // 行间只用一条发丝线（首行没有）
            if i > 0 {
                Rectangle().fill(p.line).frame(height: Dim.hairline)
            }
        }
    }

    private var currentChip: some View {
        Text("当前")
            .font(.system(size: Dim.fsCaption))
            .foregroundStyle(p.accentText)
            .padding(.horizontal, Dim.s2)
            .padding(.vertical, Dim.s0)
            .background(p.panel2)
            .clipShape(RoundedRectangle(cornerRadius: Dim.radiusPill, style: .continuous))
    }

    private var emptyHint: some View {
        VStack(alignment: .leading, spacing: Dim.s1) {
            Text("还没有配置服务器")
                .font(.system(size: Dim.fsBody))
                .foregroundStyle(p.text2)
            Text("点右上角「+」添加一个")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: 新增 / 编辑表单

    private var addForm: some View {
        VStack(spacing: Dim.s2) {
            Text(store.editingIndex >= 0 ? "编辑服务器" : "新增服务器")
                .font(.system(size: Dim.fsSub, weight: .medium))
                .foregroundStyle(p.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
            NeuInput($store.newName, placeholder: "名称（可选，如：客厅主机）")
            NeuInput($store.newUrl, placeholder: "地址，如 http://IP:端口 或 https://域名")
            HStack(spacing: Dim.s2) {
                WebButton("取消", size: .md, block: true) {
                    store.cancelForm()
                }
                .accessibilityLabel("取消编辑")
                WebButton(store.editingIndex >= 0 ? "保存" : "保存并检测",
                          variant: .primary, size: .md, block: true) {
                    Task { await store.saveForm() }
                }
                .accessibilityLabel("保存服务器")
            }
        }
        .padding(Dim.s4)
        .background(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous).fill(p.bg)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
                .stroke(p.line, lineWidth: Dim.hairline)
        )
    }

    // MARK: 四态渲染

    private func state(_ i: Int) -> ServerProbeState {
        store.status.indices.contains(i) ? store.status[i] : .unknown
    }

    private func statusText(_ i: Int) -> String {
        switch state(i) {
        case .checking: return "检测中"
        case .ok: return "可达"
        case .bad: return "不可达"
        case .unknown: return "未知"
        }
    }

    private func statusColor(_ i: Int) -> Color {
        switch state(i) {
        case .ok: return p.accent
        case .bad: return p.danger
        case .checking, .unknown: return p.text2
        }
    }
}

/// hw `WebIconButton` PLAIN 档的按下反馈（透明底 → panel2 + 顶沿高光 + 下沉 1）
private struct SheetGlyphStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme

    private var p: Palette { Palette(scheme) }
    /// 盒 36（hw 头部两个图标钮的 boxSize）
    private let box: CGFloat = Dim.btnMd

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Dim.radiusMd, style: .continuous)
        return configuration.label
            .frame(width: box, height: box)
            .background(shape.fill(configuration.isPressed ? p.panel2 : Color.clear))
            .overlay(alignment: .top) {
                if configuration.isPressed {
                    Rectangle().fill(p.hi).frame(height: Dim.hairline)
                }
            }
            .clipShape(shape)
            .offset(y: configuration.isPressed ? Dim.hairline : 0)
            .animation(.easeOut(duration: Motion.fast), value: configuration.isPressed)
            .contentShape(shape)
    }
}
// MARK: - 底部浮层呈现

extension View {
    /**
     * 以 hw 的「底部浮层」形态呈现浮层页（设置页的服务端管理浮层用这条）。
     *
     * `fullScreenCover` 自带的下滑转场就是 hw 的 `translate({ y: '100%' })`；
     * 但系统默认会铺一层不透明背板，把浮层自己的 scrim 与上两角圆角盖掉 —— 必须置空。
     *
     * 用法（承载方，例如设置页的两个入口）：
     * ```swift
     * .suenBottomOverlay(isPresented: $showServers) {
     *     ServerListSheet(onClose: { showServers = false })
     * }
     * ```
     */
    func suenBottomOverlay<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        fullScreenCover(isPresented: isPresented) {
            content().presentationBackground(.clear)
        }
    }
}
