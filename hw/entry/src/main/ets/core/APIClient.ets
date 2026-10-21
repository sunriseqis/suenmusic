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
  SearchResult, DailyRecommend, FavoritesCheckReply, FavoriteUpsertReply, FavoriteRemoveReply, Track
} from './Models';

const TAG = 'SuenMusic_API';
const DOMAIN = 0x0000;
const PREF_NAME = 'suenmusic';
const KEY_TOKEN = 'refreshToken';
const KEY_SERVERS = 'servers';
const KEY_BASE = 'baseUrl';

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

  /** `context` 由调用方传入 —— ArkTS 已弃用 `getContext(this)`，普通类里也拿不到组件上下文 */
  async init(context: common.Context): Promise<void> {
    if (this.pref === null) {
      this.pref = await preferences.getPreferences(context, PREF_NAME);
    }
    const savedServers = this.pref.getSync(KEY_SERVERS, '') as string;
    if (savedServers.length > 0) {
      try {
        this.servers = JSON.parse(savedServers) as ServerCandidate[];
      } catch (e) {
        this.servers = [];
      }
    }
    this.baseUrl = this.pref.getSync(KEY_BASE, '') as string;
    this.refreshToken = this.pref.getSync(KEY_TOKEN, '') as string;
  }

  getBaseUrl(): string { return this.baseUrl; }
  getServers(): ServerCandidate[] { return this.servers; }
  isLoggedIn(): boolean { return this.accessToken.length > 0 || this.refreshToken.length > 0; }

  async setServers(list: ServerCandidate[], current: string): Promise<void> {
    this.servers = list;
    this.baseUrl = APIClient.normalize(current);
    if (this.pref !== null) {
      this.pref.putSync(KEY_SERVERS, JSON.stringify(list));
      this.pref.putSync(KEY_BASE, this.baseUrl);
      await this.pref.flush();
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
    if (this.pref !== null) {
      this.pref.putSync(KEY_TOKEN, session.refreshToken);
      this.pref.flush();
    }
  }

  signOut(): void {
    this.accessToken = '';
    this.refreshToken = '';
    if (this.pref !== null) {
      this.pref.deleteSync(KEY_TOKEN);
      this.pref.flush();
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
        header: this.buildHeaders(authed)
      };
      if (body.length > 0) { options.extraData = body; }
      return await req.request(this.baseUrl + path, options);
    } finally {
      req.destroy();
    }
  }

  private buildHeaders(authed: boolean): Record<string, string> {
    const h: Record<string, string> = { 'Accept': 'application/json' };
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
        readTimeout: timeoutMs
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
    authed: boolean, retried: boolean
  ): Promise<T> {
    const timeout = APIClient.isPrivate(this.baseUrl) ? 4000 : 20000;
    let res: http.HttpResponse;
    try {
      res = await this.raw(path, method, body, authed, timeout);
    } catch (e) {
      if (!retried && await this.failoverIfNeeded()) {
        return this.request<T>(path, method, body, authed, true);
      }
      throw new ApiError(0, 'network', '连不上服务端，请检查网络或服务器地址');
    }

    if (res.responseCode === 401 && authed && !retried) {
      await this.refresh();
      return this.request<T>(path, method, body, authed, true);
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

  /** 每日推荐（只读，歌单由服务端每天 00:30 产出；`shortfall` 不是错误） */
  async dailyRecommend(): Promise<DailyRecommend> {
    return this.request<DailyRecommend>('/api/recommend/daily', http.RequestMethod.GET, '', true, false);
  }
}
