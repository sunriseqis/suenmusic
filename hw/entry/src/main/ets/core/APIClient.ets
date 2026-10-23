/**
 * HTTP 客户端（原生）。
 *
 * 与 iOS 端 `APIClient.swift`、Web 端 `client.ts` 语义一致：
 * 访问令牌只在内存、401 单飞刷新重放一次、网络失败触发多服务端选路、
 * 私有 IP 4 秒快速失败（出门后内网是黑洞路由）。
 *
 * 注意：`http.request` 单次响应默认上限 **5MB**（API 23 起 50MB），
 * 本项目所有 JSON 接口都远小于它；音频走 AVPlayer 直连，不经过这里。
 */

import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import {
  AuthConfig, AuthSession, FavoritePage, HomeData, PublicUser,
  ResolveResponse, ServerCandidate, StreamSessionToken, ApiErrorBody, LyricResult,
  SearchResult, DailyRecommend, FavoritesCheckReply, FavoriteUpsertReply, FavoriteRemoveReply,
  DislikeReply, Track, DislikeListReply, DislikeRow, QQImportReply, DedupePreviewReply,
  DedupeReply, FavoriteTracksReply, ImportFavoritesReply, PersonaDetail, TuneReply,
  SourceStatus, OkReply, AlbumDetail, ArtistSongs, ArtistAlbums, SimilarArtists,
  QQPlaylistResult, ToplistDetail, BiliCandidatesResult, AnchorBody, TrackAnchorReply,
  UpdateCheckReply
} from './Models';

const TAG = 'SuenMusic_API';
const DOMAIN = 0x0000;
const PREF_NAME = 'suenmusic';
const KEY_TOKEN = 'refreshToken';
const KEY_SERVERS = 'servers';
const KEY_BASE = 'baseUrl';
/** 自动选路开关（默认开）：关掉后网络失败不再探测/切换备用服务端 */
const KEY_AUTO_FAILOVER = 'auto_failover';

/** 统一错误：`status = 0` 表示网络层失败 */
/** `/api/health` 的返回体（探测选路要校验它，门户劫持也会回 200） */
interface HealthReply {
  ok: boolean;
}

/** 刷新请求体（ArkTS 禁止无类型对象字面量，必须显式声明） */
interface RefreshBody {
  refreshToken: string;
}

/** 登录请求体 */
interface LoginBody {
  username: string;
  password: string;
}

/** 收藏请求体（带 track 顺带写快照，省后续补全） */
interface FavoritePostBody {
  trackId: string;
  track: Track | null;
}

/** 批量查询收藏状态请求体（ids ≤ 500） */
interface IdsBody {
  ids: string[];
}

/** 不喜欢请求体（`/api/recommend/dislike`，type = track | artist） */
interface DislikeBody {
  type: string;
  id: string;
  name: string;
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  get isNetwork(): boolean { return this.status === 0; }
  get isUnauthorized(): boolean { return this.status === 401; }
}

export class APIClient {
  private static instance: APIClient | null = null;
  static shared(): APIClient {
    if (APIClient.instance === null) { APIClient.instance = new APIClient(); }
    return APIClient.instance;
  }

  private accessToken: string = '';
  private refreshToken: string = '';
  private baseUrl: string = '';
  private servers: ServerCandidate[] = [];
  private pref: preferences.Preferences | null = null;
  private refreshing: Promise<void> | null = null;
  private lastFailoverAt: number = 0;
  /** 访问令牌过期时刻（epoch ms）：请求前提前续期用（T4 第 8 项） */
  private accessExpiresAt: number = 0;
  /** 自动选路开关（持久化，默认开）：设置页可关 */
  private autoFailover: boolean = true;

  /** `context` 由调用方传入 —— ArkTS 已弃用 `getContext(this)`，普通类里也拿不到组件上下文 */
  async init(context: common.Context): Promise<void> {
    if (this.pref === null) {
      try {
        this.pref = await preferences.getPreferences(context, PREF_NAME);
      } catch (e) {
        // 偏好存储打不开（极端情况）：全部配置退化为内存态默认值，不拦启动
        hilog.warn(DOMAIN, TAG, '打开偏好存储失败: %{public}s', JSON.stringify(e));
        return;
      }
    }
    try {
      const savedServers = this.pref.getSync(KEY_SERVERS, '') as string;
      if (savedServers.length > 0) {
        this.servers = JSON.parse(savedServers) as ServerCandidate[];
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '读取服务端列表失败: %{public}s', JSON.stringify(e));
      this.servers = [];
    }
    try {
      this.baseUrl = this.pref.getSync(KEY_BASE, '') as string;
      this.refreshToken = this.pref.getSync(KEY_TOKEN, '') as string;
      this.autoFailover = this.pref.getSync(KEY_AUTO_FAILOVER, true) as boolean;
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '读取偏好失败（按默认值继续）: %{public}s', JSON.stringify(e));
    }
  }

  getBaseUrl(): string { return this.baseUrl; }
  getServers(): ServerCandidate[] { return this.servers; }
  isLoggedIn(): boolean { return this.accessToken.length > 0 || this.refreshToken.length > 0; }

  /** 自动选路是否开启（设置页开关显示用） */
  isAutoFailover(): boolean { return this.autoFailover; }

  /** 开/关自动选路（持久化）。关闭后网络失败不再探测备用服务端 */
  setAutoFailover(enabled: boolean): void {
    this.autoFailover = enabled;
    if (this.pref !== null) {
      try {
        this.pref.putSync(KEY_AUTO_FAILOVER, enabled);
        this.pref.flush();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, '持久化自动选路开关失败: %{public}s', JSON.stringify(e));
      }
    }
  }

  async setServers(list: ServerCandidate[], current: string): Promise<void> {
    this.servers = list;
    this.baseUrl = APIClient.normalize(current);
    if (this.pref !== null) {
      try {
        this.pref.putSync(KEY_SERVERS, JSON.stringify(list));
        this.pref.putSync(KEY_BASE, this.baseUrl);
        await this.pref.flush();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, '持久化服务端列表失败: %{public}s', JSON.stringify(e));
      }
    }
  }

  private static normalize(raw: string): string {
    let s = raw.trim();
    while (s.endsWith('/')) { s = s.substring(0, s.length - 1); }
    return s;
  }

  static isPrivate(url: string): boolean {
    const m = url.match(/^https?:\/\/([^/:]+)/);
    const host = m === null ? '' : m[1].toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) { return true; }
    if (host.startsWith('192.168.') || host.startsWith('10.')) { return true; }
    const seg = host.split('.');
    if (seg.length === 4 && seg[0] === '172') {
      const n = Number(seg[1]);
      if (n >= 16 && n <= 31) { return true; }
    }
    return false;
  }

  adopt(session: AuthSession): void {
    this.accessToken = session.accessToken;
    this.refreshToken = session.refreshToken;
    this.accessExpiresAt = session.accessExpiresAt;
    if (this.pref !== null) {
      try {
        this.pref.putSync(KEY_TOKEN, session.refreshToken);
        this.pref.flush();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, '持久化刷新令牌失败: %{public}s', JSON.stringify(e));
      }
    }
  }

  signOut(): void {
    this.accessToken = '';
    this.refreshToken = '';
    if (this.pref !== null) {
      try {
        this.pref.deleteSync(KEY_TOKEN);
        this.pref.flush();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, '清除刷新令牌失败: %{public}s', JSON.stringify(e));
      }
    }
  }

  // ---------------- 底层请求 ----------------

  private async raw(
    path: string, method: http.RequestMethod, body: string,
    authed: boolean, timeoutMs: number
  ): Promise<http.HttpResponse> {
    const req = http.createHttp();
    try {
      const options: http.HttpRequestOptions = {
        method: method,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
        header: this.buildHeaders(authed, body)
      };
      if (body.length > 0) { options.extraData = body; }
      try {
        return await req.request(this.baseUrl + path, options);
      } catch (e) {
        // 网络层失败在这里就统一降级成 ApiError(network)：
        // request<T> 的 catch 捕获一切异常做选路重试，不区分类型，
        // 提前规整能让上层（含 refresh 路径）拿到的都是同一个网络错误类型
        const be = e as BusinessError;
        throw new ApiError(0, 'network',
          be.message !== undefined && be.message.length > 0 ? be.message : '连不上服务端，请检查网络或服务器地址');
      }
    } finally {
      req.destroy();
    }
  }

  private buildHeaders(authed: boolean, body: string): Record<string, string> {
    const h: Record<string, string> = { 'Accept': 'application/json' };
    // 鸿蒙 http 栈对不带 extraData 的请求也会默认注入 `Content-Type: application/json`，
    // Fastify 遇到「JSON Content-Type + 空 body」直接 400（FST_ERR_CTP_EMPTY_JSON_BODY，
    // 曾让 DELETE /api/favorites/:trackId 全挂）。显式声明：有 body = JSON，没 body = text/plain
    h['Content-Type'] = body.length > 0 ? 'application/json' : 'text/plain';
    if (authed && this.accessToken.length > 0) {
      h['Authorization'] = 'Bearer ' + this.accessToken;
    }
    return h;
  }

  /**
   * 单飞刷新：并发 401 共用同一次刷新。
   * 刷新令牌是**轮换**的，各自刷新必然互相把对方令牌作废。
   */
  private async refresh(): Promise<void> {
    if (this.refreshToken.length === 0) {
      throw new ApiError(401, 'unauthorized', '登录已失效，请重新登录');
    }
    if (this.refreshing !== null) { await this.refreshing; return; }

    const task: Promise<void> = (async () => {
      const payload: RefreshBody = { refreshToken: this.refreshToken };
      const body = JSON.stringify(payload);
      const res = await this.raw('/api/auth/refresh', http.RequestMethod.POST, body, false, 15000);
      if (res.responseCode !== 200) {
        throw new ApiError(res.responseCode, 'unauthorized', '登录已失效，请重新登录');
      }
      const session = JSON.parse(res.result as string) as AuthSession;
      this.accessToken = session.accessToken;
      this.refreshToken = session.refreshToken;
      this.accessExpiresAt = session.accessExpiresAt;
      if (this.pref !== null) {
        this.pref.putSync(KEY_TOKEN, session.refreshToken);
        this.pref.flush();
      }
    })();
    this.refreshing = task;
    try {
      await task;
    } finally {
      this.refreshing = null;
    }
  }

  /** 多服务端选路：探测 `/api/health` 且**校验 ok 字段**（门户劫持也会回 200） */
  private async probe(base: string, timeoutMs: number): Promise<boolean> {
    const req = http.createHttp();
    try {
      const res = await req.request(base + '/api/health', {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
        // GET 空 body 也必须显式 text/plain：鸿蒙栈默认注入 json 头，
        // Fastify 遇「json Content-Type + 空 body」直接 400，探测会永远失败
        header: { 'Accept': 'application/json', 'Content-Type': 'text/plain' }
      });
      if (res.responseCode !== 200) { return false; }
      const health = JSON.parse(res.result as string) as HealthReply;
      return health.ok === true;
    } catch (e) {
      return false;
    } finally {
      req.destroy();
    }
  }

  private async failoverIfNeeded(): Promise<boolean> {
    // 设置页关掉了自动选路：网络失败也不探测、不切换（用户自己管路由）
    if (!this.autoFailover) { return false; }
    if (this.servers.length < 2) { return false; }
    const now = Date.now();
    if (now - this.lastFailoverAt < 5000) { return false; }
    this.lastFailoverAt = now;

    const current = this.baseUrl;
    if (!APIClient.isPrivate(current) && await this.probe(current, 1000)) { return false; }
    for (let i = 0; i < this.servers.length; i++) {
      const cand = this.servers[i];
      if (cand.url === current) { continue; }
      if (await this.probe(cand.url, 2000)) {
        this.baseUrl = cand.url;
        hilog.warn(DOMAIN, TAG, '已切换到备用服务端: %{public}s', cand.url);
        return true;
      }
    }
    return false;
  }

  private async request<T>(
    path: string, method: http.RequestMethod, body: string,
    authed: boolean, retried: boolean, timeoutOverride: number = 0
  ): Promise<T> {
    // 令牌提前续期（T4 第 8 项）：离过期不足 60 秒就先刷新再发请求，
    // 省掉"必 401 → 刷新 → 重放"一个来回。续期失败（如离线）不拦请求，
    // 继续用旧令牌 —— 真过期了还有 401 单飞刷新这条兜底路径。
    if (authed && !retried && this.refreshToken.length > 0 && this.accessExpiresAt > 0
      && Date.now() > this.accessExpiresAt - 60000) {
      try {
        await this.refresh();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, '令牌提前续期失败（继续用旧令牌）: %{public}s', JSON.stringify(e));
      }
    }
    // timeoutOverride > 0：长任务（AI 调优 700s、QQ 歌单导入上游慢）不走 4s/20s 快失败
    const timeout = timeoutOverride > 0
      ? timeoutOverride
      : (APIClient.isPrivate(this.baseUrl) ? 4000 : 20000);
    let res: http.HttpResponse;
    try {
      res = await this.raw(path, method, body, authed, timeout);
    } catch (e) {
      if (!retried && await this.failoverIfNeeded()) {
        return this.request<T>(path, method, body, authed, true, timeoutOverride);
      }
      throw new ApiError(0, 'network', '连不上服务端，请检查网络或服务器地址');
    }

    if (res.responseCode === 401 && authed && !retried) {
      await this.refresh();
      return this.request<T>(path, method, body, authed, true, timeoutOverride);
    }

    if (res.responseCode < 200 || res.responseCode >= 300) {
      const rawText = typeof res.result === 'string' ? res.result : '';
      if (rawText.length > 0) {
        try {
          const errBody = JSON.parse(rawText) as ApiErrorBody;
          throw new ApiError(res.responseCode, errBody.error.code, errBody.error.message);
        } catch (e) {
          if (e instanceof ApiError) { throw e; }
        }
      }
      throw new ApiError(res.responseCode, 'http_' + res.responseCode,
        '服务端返回 HTTP ' + res.responseCode);
    }

    const text = typeof res.result === 'string' ? res.result : '';
    if (text.length === 0) { throw new ApiError(res.responseCode, 'empty', '服务端返回空响应'); }
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new ApiError(res.responseCode, 'decode', '响应解析失败');
    }
  }

  // ---------------- 多服务端管理（S3 增量 3） ----------------

  /** 探测单个服务端：健康检查 + 校验返回体 ok 字段（门户劫持也会回 200）。空串/非 http(s) 一律不可达 */
  async probeServer(url: string): Promise<boolean> {
    const target = APIClient.normalize(url);
    if (target.length === 0) { return false; }
    if (!target.startsWith('http://') && !target.startsWith('https://')) { return false; }
    return this.probe(target, 2000);
  }

  /** 并行探测全部候选，返回 url → 可达 */
  async probeAll(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    const tasks: Promise<boolean>[] = [];
    for (let i = 0; i < this.servers.length; i++) {
      tasks.push(this.probeServer(this.servers[i].url));
    }
    const results: boolean[] = await Promise.all(tasks);
    for (let i = 0; i < this.servers.length; i++) {
      out[this.servers[i].url] = results[i];
    }
    return out;
  }

  /**
   * 切换当前服务端。
   * 顺序：探测 → 临时切过去 → `me()` 验证鉴权 → 成功则持久化；失败则**回滚**到原地址并抛出原因。
   * 返回 true = 已切换（调用方随后需要 `MediaPlayerCore.rebindServer` 重建播放队列）。
   */
  async switchServer(url: string): Promise<boolean> {
    const target = APIClient.normalize(url);
    if (target.length === 0) {
      throw new ApiError(0, 'invalid', '服务器地址不能为空');
    }
    if (target === this.baseUrl) { return true; }

    if (!await this.probeServer(target)) {
      throw new ApiError(0, 'unreachable', '连不上该服务器，请检查地址或网络');
    }

    const originalBase = this.baseUrl;
    const oldAccess = this.accessToken;
    const oldRefresh = this.refreshToken;
    // 临时切过去；清空访问令牌（新服务器不接受旧令牌），保留 refreshToken
    // 让 request 管线走「401 → 单飞刷新 → 重试」验证账号是否存在
    this.baseUrl = target;
    this.accessToken = '';

    try {
      await this.me();
    } catch (e) {
      // 任何一步失败都回滚：地址恢复原值、令牌状态不变
      this.baseUrl = originalBase;
      this.accessToken = oldAccess;
      this.refreshToken = oldRefresh;
      const err = e as ApiError;
      hilog.warn(DOMAIN, TAG, '切换服务端失败，已回滚到 %{public}s: %{public}s',
        originalBase, err.message);
      if (err.isUnauthorized) {
        throw new ApiError(401, 'unauthorized', '该服务器上你的账号需要重新登录');
      }
      throw new ApiError(0, 'network', '切换失败：' + err.message);
    }

    if (this.pref !== null) {
      try {
        this.pref.putSync(KEY_BASE, target);
        await this.pref.flush();
      } catch (e) {
        // 持久化失败不回滚切换：内存态已生效，代价只是下次启动回旧地址
        hilog.warn(DOMAIN, TAG, '持久化当前服务端失败: %{public}s', JSON.stringify(e));
      }
    }
    hilog.info(DOMAIN, TAG, '已切换服务端: %{public}s', target);
    return true;
  }

  // ---------------- 业务接口 ----------------

  async authConfig(): Promise<AuthConfig> {
    return this.request<AuthConfig>('/api/auth/config', http.RequestMethod.GET, '', false, false);
  }

  async login(username: string, password: string): Promise<AuthSession> {
    const payload: LoginBody = { username: username, password: password };
    return this.request<AuthSession>('/api/auth/login', http.RequestMethod.POST,
      JSON.stringify(payload), false, false);
  }

  async me(): Promise<PublicUser> {
    interface MeReply { user: PublicUser; }
    const r = await this.request<MeReply>('/api/auth/me', http.RequestMethod.GET, '', true, false);
    return r.user;
  }

  async home(): Promise<HomeData> {
    return this.request<HomeData>('/api/home', http.RequestMethod.GET, '', true, false);
  }

  /**
   * 检查更新（T7）。`force=true` 才让服务端去上游核对，否则只读它本地缓存。
   */
  async checkUpdate(versionName: string, versionCode: number, force: boolean): Promise<UpdateCheckReply> {
    const q = '?platform=harmony&version_name=' + encodeURIComponent(versionName)
      + '&version_code=' + versionCode + (force ? '&force=1' : '');
    return this.request<UpdateCheckReply>('/api/update/check' + q,
      http.RequestMethod.GET, '', true, false);
  }

  /** 交给系统浏览器下载的直链（带短期令牌；浏览器发不出请求头） */
  buildUpdateDownloadUrl(downloadPath: string, token: string): string {
    return this.getBaseUrl() + downloadPath + '?platform=harmony&token=' + encodeURIComponent(token);
  }

  async resolve(trackId: string): Promise<ResolveResponse> {
    return this.request<ResolveResponse>('/api/resolve/' + encodeURIComponent(trackId),
      http.RequestMethod.GET, '', true, false);
  }

  async streamSessionToken(): Promise<StreamSessionToken> {
    return this.request<StreamSessionToken>('/api/stream/session-token',
      http.RequestMethod.GET, '', true, false);
  }

  async lyric(trackId: string): Promise<LyricResult> {
    return this.request<LyricResult>('/api/lyrics/' + encodeURIComponent(trackId),
      http.RequestMethod.GET, '', true, false);
  }

  async favorites(limit: number, cursor: string): Promise<FavoritePage> {
    let path = '/api/favorites?limit=' + limit;
    if (cursor.length > 0) { path += '&cursor=' + encodeURIComponent(cursor); }
    return this.request<FavoritePage>(path, http.RequestMethod.GET, '', true, false);
  }

  /**
   * 搜索。`type`：all / song / album / artist / playlist / mv。
   * 单类型只发一次上游请求，比综合搜索省配额。
   */
  async search(query: string, type: string, page: number, limit: number): Promise<SearchResult> {
    const path = '/api/search?q=' + encodeURIComponent(query)
      + '&type=' + encodeURIComponent(type)
      + '&page=' + page + '&limit=' + limit;
    return this.request<SearchResult>(path, http.RequestMethod.GET, '', true, false);
  }

  /** 专辑详情（`GET /api/albums/:id`；notice = 曲目为空时的版权限制说明） */
  async albumDetail(id: string): Promise<AlbumDetail> {
    return this.request<AlbumDetail>('/api/albums/' + encodeURIComponent(id),
      http.RequestMethod.GET, '', true, false);
  }

  /** 歌手热门歌曲（`GET /api/artists/:id/songs`；name 建议一起传，省一次上游详情请求） */
  async artistSongs(id: string, name: string, limit: number, page: number): Promise<ArtistSongs> {
    const path = '/api/artists/' + encodeURIComponent(id) + '/songs'
      + '?name=' + encodeURIComponent(name) + '&limit=' + limit + '&page=' + page;
    return this.request<ArtistSongs>(path, http.RequestMethod.GET, '', true, false);
  }

  /** 歌手专辑列表（`GET /api/artists/:id/albums`；与 songs 分开，限流状态独立） */
  async artistAlbums(id: string, name: string, limit: number, page: number): Promise<ArtistAlbums> {
    const path = '/api/artists/' + encodeURIComponent(id) + '/albums'
      + '?name=' + encodeURIComponent(name) + '&limit=' + limit + '&page=' + page;
    return this.request<ArtistAlbums>(path, http.RequestMethod.GET, '', true, false);
  }

  /** 相似歌手（`GET /api/artists/:id/similar`；上游任何一步失败服务端返回空列表） */
  async similarArtists(id: string, name: string): Promise<SimilarArtists> {
    const path = '/api/artists/' + encodeURIComponent(id) + '/similar'
      + '?name=' + encodeURIComponent(name);
    return this.request<SimilarArtists>(path, http.RequestMethod.GET, '', true, false);
  }

  /** QQ 官方歌单详情（`GET /api/qq/playlist/:tid`） */
  async qqPlaylist(tid: string): Promise<QQPlaylistResult> {
    return this.request<QQPlaylistResult>('/api/qq/playlist/' + encodeURIComponent(tid),
      http.RequestMethod.GET, '', true, false);
  }

  /** 榜单详情（`GET /api/toplist/:id`；limit 默认 200 一次拉齐） */
  async toplistDetail(id: string, limit: number): Promise<ToplistDetail> {
    return this.request<ToplistDetail>('/api/toplist/' + encodeURIComponent(id)
      + '?limit=' + limit, http.RequestMethod.GET, '', true, false);
  }

  /** 收藏（幂等：重复收藏返回 200 且 added=false） */
  async addFavorite(trackId: string, track: Track | null): Promise<FavoriteUpsertReply> {
    const payload: FavoritePostBody = { trackId: trackId, track: track };
    return this.request<FavoriteUpsertReply>('/api/favorites', http.RequestMethod.POST,
      JSON.stringify(payload), true, false);
  }

  /** 取消收藏（幂等：取消不存在的也 200） */
  async removeFavorite(trackId: string): Promise<FavoriteRemoveReply> {
    return this.request<FavoriteRemoveReply>('/api/favorites/' + encodeURIComponent(trackId),
      http.RequestMethod.DELETE, '', true, false);
  }

  /** 批量查询是否已收藏（渲染列表时用，ids ≤ 500） */
  async checkFavorites(ids: string[]): Promise<FavoritesCheckReply> {
    const payload: IdsBody = { ids: ids };
    return this.request<FavoritesCheckReply>('/api/favorites/check', http.RequestMethod.POST,
      JSON.stringify(payload), true, false);
  }

  /**
   * 批量查询这批 id 里**已收藏**的 id 列表（右滑手势的序号染色/文案用）。
   * 服务端单次上限 500，这里自动分批合并；调用方失败静默即可
   * （拉不到标记只是不染色，不值得打断浏览）。
   */
  async favoredIds(ids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (let start = 0; start < ids.length; start += 500) {
      const part = ids.slice(start, start + 500);
      if (part.length === 0) { continue; }
      const res = await this.checkFavorites(part);
      const keys = Object.keys(res.favorites);
      for (let i = 0; i < keys.length; i++) {
        if (res.favorites[keys[i]]) { out.push(keys[i]); }
      }
    }
    return out;
  }

  /** 每日推荐（只读，歌单由服务端每天 00:30 产出；`shortfall` 不是错误） */
  async dailyRecommend(): Promise<DailyRecommend> {
    return this.request<DailyRecommend>('/api/recommend/daily', http.RequestMethod.GET, '', true, false);
  }

  /**
   * 不喜欢调优（服务端立即把它移出当日歌单并永久过滤）。
   * `type = 'track'`：这首歌；`type = 'artist'`：该歌手（id 传 `ar[0].mid`），
   * 服务端还会从用户的曲库归属里删链，建库器不再为其拉这位歌手。
   */
  async dislike(type: string, id: string, name: string): Promise<DislikeReply> {
    const payload: DislikeBody = { type: type, id: id, name: name };
    return this.request<DislikeReply>('/api/recommend/dislike', http.RequestMethod.POST,
      JSON.stringify(payload), true, false);
  }

  // ---------------- 设置页（T10 批次 C：黑名单 / 导入 / 去重 / 备份 / 画像 / 音源） ----------------

  /** 黑名单列表（歌曲 + 歌手两类混排，按 createdAt 倒序） */
  async fetchDislikes(): Promise<DislikeRow[]> {
    const r = await this.request<DislikeListReply>('/api/recommend/dislikes',
      http.RequestMethod.GET, '', true, false);
    return r.dislikes;
  }

  /** 黑名单恢复（DELETE /api/recommend/dislike/:type/:id，幂等） */
  async undoDislike(type: string, id: string): Promise<OkReply> {
    return this.request<OkReply>(
      '/api/recommend/dislike/' + encodeURIComponent(type) + '/' + encodeURIComponent(id),
      http.RequestMethod.DELETE, '', true, false);
  }

  /** QQ 歌单导入收藏（上游拉歌单详情可能慢，60s 预算） */
  async importQQPlaylist(link: string): Promise<QQImportReply> {
    interface LinkBody { link: string; }
    const payload: LinkBody = { link: link };
    return this.request<QQImportReply>('/api/favorites/import-qq-playlist',
      http.RequestMethod.POST, JSON.stringify(payload), true, false, 60000);
  }

  /** 去重预检（服务端扫收藏，按「歌名 + 主歌手」分组，保留最早收藏） */
  async dedupePreview(): Promise<DedupePreviewReply> {
    return this.request<DedupePreviewReply>('/api/favorites/dedup/preview',
      http.RequestMethod.POST, '', true, false);
  }

  /** 执行去重（服务端重扫分组后删除冗余；与预检之间收藏可能已变化，以服务端结果为准） */
  async dedupeApply(): Promise<DedupeReply> {
    return this.request<DedupeReply>('/api/favorites/dedup',
      http.RequestMethod.POST, '', true, false);
  }

  /** 收藏曲目内容（备份导出用，一次拉齐 ≤ 500 首） */
  async favoriteTracks(): Promise<Track[]> {
    const r = await this.request<FavoriteTracksReply>('/api/favorites/tracks?limit=500',
      http.RequestMethod.GET, '', true, false);
    return r.tracks;
  }

  /** 批量回写收藏（备份导入用；服务端单次上限 500，这里自动分批，返回累计新增数） */
  async importFavorites(tracks: Track[]): Promise<number> {
    interface TracksBody { tracks: Track[]; }
    let added = 0;
    for (let start = 0; start < tracks.length; start += 500) {
      const part = tracks.slice(start, start + 500);
      if (part.length === 0) { continue; }
      const payload: TracksBody = { tracks: part };
      const r = await this.request<ImportFavoritesReply>('/api/favorites/import',
        http.RequestMethod.POST, JSON.stringify(payload), true, false);
      added += r.added;
    }
    return added;
  }

  /** 音乐画像（summary 为空串 = 尚未生成） */
  async fetchPersona(): Promise<PersonaDetail> {
    return this.request<PersonaDetail>('/api/ai/persona', http.RequestMethod.GET, '', true, false);
  }

  /**
   * 画像调优。超时预算链：服务端模型调用 600s < 客户端 700s < Fastify 900s
   * （web `api/ai.ts` 同款口径，客户端必须比服务端晚放弃，让服务端先给结论）。
   */
  async tunePersona(guidance: string): Promise<TuneReply> {
    interface GuidanceBody { guidance: string; }
    const payload: GuidanceBody = { guidance: guidance };
    return this.request<TuneReply>('/api/ai/persona/tune', http.RequestMethod.POST,
      JSON.stringify(payload), true, false, 700000);
  }

  /** B 站音源授权状态（只读；扫码/退出是 Web 面板管理员专属） */
  async bilibiliStatus(): Promise<SourceStatus> {
    return this.request<SourceStatus>('/api/bilibili/account', http.RequestMethod.GET, '', true, false);
  }

  /** 网易云音源授权状态（只读，与 B 站同构） */
  async neteaseStatus(): Promise<SourceStatus> {
    return this.request<SourceStatus>('/api/netease/account', http.RequestMethod.GET, '', true, false);
  }

  // ---------------- 手动锚定（播放页修正音源，web api/playback.ts 同契约） ----------------

  /** 搜 B 站候选（keyword 缺省时服务端用「歌名 + 主歌手」构造；要等 B 站搜索，20s 预算） */
  async biliCandidates(trackId: string, keyword: string): Promise<BiliCandidatesResult> {
    let path = '/api/tracks/' + encodeURIComponent(trackId) + '/bili-candidates';
    const kw = keyword.trim();
    if (kw.length > 0) {
      path += '?keyword=' + encodeURIComponent(kw);
    }
    return this.request<BiliCandidatesResult>(path, http.RequestMethod.GET, '', true, false, 20000);
  }

  /** 锚定：把「这首曲 = 这个 B 站视频」永久入库，之后解析直接按锚点取流 */
  async anchorTrack(trackId: string, body: AnchorBody): Promise<OkReply> {
    return this.request<OkReply>('/api/tracks/' + encodeURIComponent(trackId) + '/anchor',
      http.RequestMethod.POST, JSON.stringify(body), true, false);
  }

  /** 查询曲目当前锚点（锚定弹窗回显；未锚定时 anchor 为 null） */
  async fetchTrackAnchor(trackId: string): Promise<TrackAnchorReply> {
    return this.request<TrackAnchorReply>('/api/tracks/' + encodeURIComponent(trackId) + '/anchor',
      http.RequestMethod.GET, '', true, false);
  }

  /** 解除锚定，该曲目回到自动匹配 */
  async unanchorTrack(trackId: string): Promise<OkReply> {
    return this.request<OkReply>('/api/tracks/' + encodeURIComponent(trackId) + '/anchor',
      http.RequestMethod.DELETE, '', true, false);
  }
}
