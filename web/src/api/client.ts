/**
 * HTTP 客户端。
 *
 * 承担四件事（PLAN.md 5.1）：
 *   1. 注入 `Authorization: Bearer <accessToken>`
 *   2. 访问令牌**只放内存**，刷新令牌放 localStorage
 *   3. 收到 401 → 刷新 → 重放原请求**一次**；并发 401 时刷新动作**去重**
 *   4. 刷新令牌**是轮换的**，每次必须覆盖保存，否则下次刷新必失败
 *
 * 为什么令牌状态放在这个模块而不是 Pinia store：
 * 刷新发生在请求拦截层，如果令牌存在 store 里，client 就要 import store，
 * 而 store 又要 import client 发请求 —— 形成循环依赖，Vite 下表现为运行时
 * `undefined`。这里让 client 独占令牌的读写，store 只做**响应式镜像**
 * （通过 `onSessionChanged` 订阅），依赖是单向的。
 */

import { isNativeShell } from '@/native/platform.ts';
import type { ApiErrorBody, AuthSession } from './types.ts';

// ---------------------------------------------------------------------------
// 常量与存储键
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'suenmusic.refresh';
const BASE_URL_KEY = 'suenmusic.baseUrl';

/** 访问令牌剩余寿命低于这个值就提前续期，省掉一次必然 401 的往返 */
const REFRESH_AHEAD_MS = 60_000;

/** 普通请求超时。音源解析要等 B 站搜索，给足时间；流媒体不走这里 */
const DEFAULT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * 统一的 API 错误。
 *
 * `message` 直接用服务端给的中文文案 —— 服务端的 `error.message` 本来就是
 * 面向用户写的（见 server/src/http/errors.ts 的注释），前端不该再维护一张
 * "错误码 → 中文"的映射表，那必然会和服务端脱节。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** 上游限流时的建议等待毫秒数 */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  /** 网络层失败（断网、DNS、超时），完全没有 HTTP 状态码 */
  get isNetworkError(): boolean {
    return this.status === 0;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** 上游被限流 —— 客户端必须走"稍后恢复"的空态，而不是"无结果"（PLAN.md 5.3） */
  get isDegraded(): boolean {
    return this.code === 'degraded' || this.code === 'upstream_unavailable';
  }
}

// ---------------------------------------------------------------------------
// 基地址
// ---------------------------------------------------------------------------

/**
 * 基地址可配置（设置页）。默认空串 = 同源 —— 开发期由 Vite 代理接管，
 * 生产期前端与服务端同域部署时也成立。
 *
 * 线上是 `https://<域名>:<非标端口>`，硬编码会让安卓端与局域网访问都要改代码，
 * 所以它必须是运行时可变的。
 */
let baseUrl = readBaseUrl();

function readBaseUrl(): string {
  try {
    return localStorage.getItem(BASE_URL_KEY) || '';
  } catch {
    return '';
  }
}

export function getBaseUrl(): string {
  return baseUrl;
}

/**
 * 有没有后端。
 *
 * 浏览器里**同源就是后端**：前端本来就是服务端的一部分，
 * 由它自己的静态资源服务发出，`/api` 直接打同源即可，不需要填地址。
 * 原生壳没有同源概念，必须显式配置基地址；没配才是「直连模式」。
 *
 * ⚠️ 「原生壳」= Capacitor（Android/iOS）**∪ 鸿蒙 ArkTS 桥**，判定见
 * `native/platform.ts`。曾经只看 Capacitor，鸿蒙因此被判成浏览器、
 * 地址框被藏起来、`/api` 打回 WebView 自身 —— 整端连不上服务端。
 */
/** 浏览器（同源、cookie 会话） */
export const isWebPlatform = !isNativeShell;

export function hasBackend(): boolean {
  return isNativeShell ? baseUrl.trim().length > 0 : true;
}

export function setBaseUrl(url: string): void {
  const normalized = url.trim().replace(/\/+$/, '');
  baseUrl = normalized;
  try {
    if (normalized) localStorage.setItem(BASE_URL_KEY, normalized);
    else localStorage.removeItem(BASE_URL_KEY);
  } catch {
    /* 隐私模式下写不进去，本次会话仍然生效 */
  }
  // 基地址变了，之前解析出来的 streamUrl 全部作废
  notifyBaseUrlChanged();
}

/**
 * 把服务端返回的**相对路径**拼成可用的绝对地址。
 * `streamUrl` 是相对路径，直接喂给 `<audio>` 会被当成前端路由。
 */
export function resolveUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

type BaseUrlListener = () => void;
const baseUrlListeners = new Set<BaseUrlListener>();

export function onBaseUrlChanged(fn: BaseUrlListener): () => void {
  baseUrlListeners.add(fn);
  return () => baseUrlListeners.delete(fn);
}

function notifyBaseUrlChanged(): void {
  for (const fn of baseUrlListeners) fn();
}

// ---------------------------------------------------------------------------
// 令牌状态
// ---------------------------------------------------------------------------

let accessToken: string | null = null;
let accessExpiresAt = 0;
let refreshToken: string | null = readStoredRefresh();
let refreshExpiresAt = 0;
/**
 * 当前登录用户。
 *
 * ⚠️ 必须**持久化**：冷启动时这个模块变量会重建，若只存内存里就会变成 null，
 * 于是 `isLoggedIn=false` → 路由守卫直接把人送去登录页 —— 离线冷启动"登不进 App"
 * 的真因（与在线离线无关，在线冷启动只是被随后的续期请求盖过去了）。
 */
const USER_KEY = 'suenmusic.auth.user';

function readCachedUser(): AuthSession['user'] | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as AuthSession['user'];
    return u && typeof u === 'object' ? u : null;
  } catch {
    return null;
  }
}

let currentUser: AuthSession['user'] | null = readCachedUser();

function readStoredRefresh(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredRefresh(token: string | null, expiresAt: number): void {
  try {
    if (token) {
      localStorage.setItem(STORAGE_KEY, token);
      if (expiresAt) localStorage.setItem(`${STORAGE_KEY}.exp`, String(expiresAt));
    } else {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(`${STORAGE_KEY}.exp`);
    }
  } catch {
    /* 写不进去也不影响本次会话 */
  }
}

/** 启动时读一次刷新令牌的过期时刻，用于判断"还有没有必要尝试刷新" */
function readStoredRefreshExpiry(): number {
  try {
    return Number(localStorage.getItem(`${STORAGE_KEY}.exp`) || 0);
  } catch {
    return 0;
  }
}
refreshExpiresAt = readStoredRefreshExpiry();

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

export function getCachedUser(): AuthSession['user'] | null {
  return currentUser;
}

/** 离线模式下把本地登录快照重新挂上（冷启动 + 服务端不可达时用） */
export function restoreCachedUser(): AuthSession['user'] | null {
  if (!currentUser) currentUser = readCachedUser();
  return currentUser;
}

/** 有没有"值得一试"的刷新凭据。过期了就不要再发请求了 */
export function hasUsableRefreshToken(): boolean {
  if (!refreshToken) return false;
  // 没有记录过期时刻（旧版本存下来的）时，仍然尝试一次，让服务端裁决
  if (!refreshExpiresAt) return true;
  return refreshExpiresAt > Date.now();
}

/** 写入新会话。**必须走这里**，否则轮换后的刷新令牌不会被保存 */
export function setSession(session: AuthSession): void {
  accessToken = session.accessToken;
  accessExpiresAt = session.accessExpiresAt;
  refreshToken = session.refreshToken;
  refreshExpiresAt = session.refreshExpiresAt;
  currentUser = session.user;
  try {
    // 登录态落盘：冷启动（尤其离线）要靠它恢复 isLoggedIn
    if (session.user) localStorage.setItem(USER_KEY, JSON.stringify(session.user));
  } catch {
    /* 写不进去不影响在线使用 */
  }
  writeStoredRefresh(session.refreshToken, session.refreshExpiresAt);
  emitSession(session);
}

export function clearSession(): void {
  accessToken = null;
  accessExpiresAt = 0;
  refreshToken = null;
  refreshExpiresAt = 0;
  currentUser = null;
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* 忽略 */
  }
  writeStoredRefresh(null, 0);
  emitSession(null);
}

/** 访问令牌是否已过期（或即将过期） */
function accessTokenStale(): boolean {
  if (!accessToken) return true;
  if (!accessExpiresAt) return false;
  return accessExpiresAt - Date.now() < REFRESH_AHEAD_MS;
}

// ---------------------------------------------------------------------------
// 会话事件：store 订阅它来保持响应式
// ---------------------------------------------------------------------------

type SessionListener = (session: AuthSession | null) => void;
const sessionListeners = new Set<SessionListener>();

export function onSessionChanged(fn: SessionListener): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

function emitSession(session: AuthSession | null): void {
  for (const fn of sessionListeners) fn(session);
}

/**
 * 会话彻底失效（刷新也失败）时的回调。
 * 路由守卫靠它把用户送回登录页 —— 请求层不该直接操作路由。
 */
type AuthLostListener = (reason: ApiError) => void;
let authLostListener: AuthLostListener | null = null;

export function onAuthLost(fn: AuthLostListener): void {
  authLostListener = fn;
}

function emitAuthLost(reason: ApiError): void {
  if (authLostListener) authLostListener(reason);
}

// ---------------------------------------------------------------------------
// 请求实现
// ---------------------------------------------------------------------------

export interface RequestOptions {
  method?: string;
  /** 会被 JSON.stringify。传 undefined 表示无请求体 */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 内部使用：标记这是重放请求，避免 401 后无限循环 */
  _retried?: boolean;
  /**
   * 不被「换路径重放」接管。
   *
   * 用于**耗时很长、且服务端可能已经在执行的**请求（如 AI 生成画像）。
   * 默认行为是：任何 status=0 的失败（含超时）都当成「这条路径不可达」→ 换路径**重放整个请求**。
   * 对普通请求这很划算（几秒的重试换来可用性），但对长任务有两个坏处：
   *   1. 用户白等两轮（180s × 2）；
   *   2. 服务端的 AI 任务被重复触发，白烧 token。
   * 所以这类请求显式关掉它，失败就把错误如实交给调用方。
   */
  noFailover?: boolean;
  /** 内部使用：标记"已因换路径重放过一次"，避免失败时反复重试 */
  _switched?: boolean;
  /**
   * 内部使用：不发 `Authorization`。
   * 与 `_retried` 是两回事 —— 重放请求**恰恰要带新令牌**，
   * 只有登录/注册/刷新这类"还没有身份"的请求才需要它。
   */
  _noAuth?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = resolveUrl(path);
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

function joinSignals(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || '请求失败';
  let retryAfterMs: number | undefined;

  try {
    const body = (await res.json()) as Partial<ApiErrorBody> & {
      degraded?: { retryAfterMs?: number };
    };
    if (body?.error) {
      code = body.error.code || code;
      message = body.error.message || message;
    }
    if (body?.degraded?.retryAfterMs) retryAfterMs = body.degraded.retryAfterMs;
  } catch {
    /* 响应不是 JSON（例如反代的 502 HTML）—— 保留状态码兜底文案 */
  }

  return new ApiError(res.status, code, message, retryAfterMs);
}

/** 判断 URL 是否指向局域网私有 IP 或本地回环 */
export function isPrivateIpUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.includes('://') ? url : `http://${url}`);
    const host = parsed.hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      /^192\.168\./.test(host) ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

/** 真正发请求。不含任何鉴权与重试逻辑，供 refresh 复用 */
async function rawFetch(path: string, opts: RequestOptions): Promise<Response> {
  const fullUrl = buildUrl(path, opts.query);
  // 当配置了备选路径（failoverHook 存在）且当前访问局域网私有 IP 时：
  // 离家时内网是黑洞路由，给 4 秒快速失败；在内网正常时几毫秒即响应，绝不在黑洞上傻等 20 秒
  const isPrivate = isPrivateIpUrl(fullUrl);
  const timeoutMs = opts.timeoutMs ?? (failoverHook && isPrivate ? 4_000 : DEFAULT_TIMEOUT_MS);
  const { signal, cleanup } = joinSignals(opts.signal, timeoutMs);

  const headers: Record<string, string> = { Accept: 'application/json' };
  const web = !isNativeShell;
  const method = opts.method ?? 'GET';
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken && !opts._noAuth) headers.Authorization = `Bearer ${accessToken}`;
  // cookie 会话的写请求必须带自定义头，否则服务端按 CSRF 拒绝
  if (web && method !== 'GET' && method !== 'HEAD') {
    headers['X-Requested-With'] = 'suenmusic';
  }

  try {
    return await fetch(fullUrl, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
      // 原生走 Bearer，不带 cookie；浏览器同源会话必须带上 cookie
      credentials: web ? 'same-origin' : 'omit',
      cache: 'no-store',
    });
  } catch (err) {
    // 用户主动取消不算错误，原样抛出让调用方忽略
    if (opts.signal?.aborted) throw err;
    const timedOut = isTimeout(err);
    throw new ApiError(
      0,
      timedOut ? 'timeout' : 'network',
      timedOut ? '请求超时，请检查网络或服务端地址' : '无法连接到服务端，请检查基地址与网络'
    );
  } finally {
    cleanup();
  }
}

function isTimeout(err: unknown): boolean {
  return String((err as Error)?.message || '').includes('timeout');
}

// ---------------------------------------------------------------------------
// 刷新：单飞（single-flight）
// ---------------------------------------------------------------------------

let refreshPromise: Promise<AuthSession> | null = null;

/**
 * 刷新会话。
 *
 * **去重是必须的**：页面初始化时通常并发好几个请求（/api/home、/api/auth/me…），
 * 它们会同时撞 401。若各自发一次刷新，第一个会把刷新令牌轮换掉，
 * 后面几个拿旧令牌去刷新必然失败 —— 表现为"刚登录就被踢下线"。
 */
export function refreshSession(): Promise<AuthSession> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const token = refreshToken;
    if (!token) {
      // Web 面板走同源 cookie 会话，**从来不会**有 refreshToken —— 这里如果只抛错，
      // session store 里的 user 仍然非空：路由守卫继续放行、每个请求都报"登录已失效"、
      // 而 /login 又被守卫弹回首页，用户只能整页刷新才回到登录页（重审 F）。
      // 所以必须走真正的会话失效收尾（清快照 + 通知应用跳登录）。
      const err = new ApiError(401, 'unauthorized', '登录已失效，请重新登录');
      clearSession();
      emitAuthLost(err);
      throw err;
    }

    // 刻意用 rawFetch：刷新本身不能再走"401 就刷新"的逻辑，否则无限递归
    let res: Response;
    try {
      res = await rawFetch('/api/auth/refresh', {
        method: 'POST',
        body: { refreshToken: token },
        timeoutMs: (failoverHook && isPrivateIpUrl(getBaseUrl())) ? 4_000 : 15_000,
        _noAuth: true,
      });
    } catch (err) {
      // 续期请求遇到网络层失败时，若有可用备用路径，切过去后再试一次
      if (err instanceof ApiError && err.isNetworkError && failoverHook) {
        const switched = await failoverHook().catch(() => false);
        if (switched) {
          res = await rawFetch('/api/auth/refresh', {
            method: 'POST',
            body: { refreshToken: token },
            timeoutMs: 15_000,
            _noAuth: true,
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    if (!res.ok) {
      const err = await parseError(res);
      // 只有「服务端明确说这个刷新令牌不行」才清会话。
      // 以前 `!res.ok` 一把抓：反代 502、服务重启、数据库恢复中的 503 都会把
      // refresh+user 从 localStorage 里删掉 —— 用户被静默登出，原生端连离线
      // 冷启动用的登录快照一起丢（重审 F）。
      if (err.isUnauthorized) {
        clearSession();
        emitAuthLost(err);
      }
      throw err;
    }

    const session = (await res.json()) as AuthSession;
    if (!session?.accessToken || !session?.refreshToken) {
      const err = new ApiError(502, 'bad_response', '服务端返回的会话数据不完整');
      clearSession();
      emitAuthLost(err);
      throw err;
    }

    // 轮换：新刷新令牌必须覆盖旧的
    setSession(session);
    return session;
  })();

  // 无论成功失败都要放锁，否则一次失败会把后续所有刷新都挂住
  refreshPromise = refreshPromise.finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

// ---------------------------------------------------------------------------
// 对外请求接口
// ---------------------------------------------------------------------------

/**
 * 发一个已鉴权的请求。
 *
 * 流程：令牌过期就先续期 → 发请求 → 401 就续期后重放一次 → 仍失败则放弃。
 * 「只重放一次」是刻意的：如果服务端持续 401，重放次数再多也没用，
 * 只会把日志刷满。
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  // 提前续期：省掉一次注定 401 的往返
  if (accessTokenStale() && hasUsableRefreshToken() && !opts._retried) {
    try {
      await refreshSession();
    } catch {
      /* 续期失败就让下面的请求自己去撞 401，由统一分支收尾 */
    }
  }

  let res: Response;
  try {
    res = await rawFetch(path, opts);
  } catch (err) {
    /**
     * 网络层失败（路径不可达 / 超时）→ 交给选路钩子：若存在可用路径就换过去
     * 并重放一次请求。这是"多路径自动切换"的落点：用户看到的不是错误，
     * 而是稍慢一点的响应（实测场景：出门时内网路径失效 → 自动走反代）。
     */
    if (!opts._switched && !opts.noFailover && err instanceof ApiError && err.isNetworkError && failoverHook) {
      const switched = await failoverHook().catch(() => false);
      if (switched) return request<T>(path, { ...opts, _switched: true });
    }
    if (err instanceof ApiError && err.isNetworkError) notifyUnreachable();
    throw err;
  }

  if (res.status === 401 && !opts._retried) {
    // 重放请求不能带旧令牌，也不能再触发一次提前续期
    await refreshSession();
    return request<T>(path, { ...opts, _retried: true });
  }

  if (!res.ok) throw await parseError(res);

  // 204 / 空体：直接返回 undefined，调用方按 void 处理
  notifyReachable();
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * 发一个已鉴权的请求并以 Blob 二进制对象返回（导出文件/数据流）。
 */
export async function requestBlob(path: string, opts: RequestOptions = {}): Promise<Blob> {
  if (accessTokenStale() && hasUsableRefreshToken() && !opts._retried) {
    try {
      await refreshSession();
    } catch {
      /* 续期失败让下面去撞 401 */
    }
  }

  let res: Response;
  try {
    res = await rawFetch(path, opts);
  } catch (err) {
    if (!opts._switched && err instanceof ApiError && err.isNetworkError && failoverHook) {
      const switched = await failoverHook().catch(() => false);
      if (switched) return requestBlob(path, { ...opts, _switched: true });
    }
    if (err instanceof ApiError && err.isNetworkError) notifyUnreachable();
    throw err;
  }

  if (res.status === 401 && !opts._retried) {
    await refreshSession();
    return requestBlob(path, { ...opts, _retried: true });
  }

  if (!res.ok) throw await parseError(res);
  notifyReachable();
  return await res.blob();
}

/**
 * 「服务器无法连接」只提示一次（60 秒内不重复）。
 *
 * 只在**曾经登录过**的情况下提示：没配服务端或已登出时，
 * 本地模式本来就该安静工作，不该被一条网络错误打扰。
 * 通过 window 事件交给 UI 层，client 不依赖任何 store。
 */
let lastUnreachableAt = 0;
let downNow = false;
function notifyUnreachable(): void {
  if (!hasBackend()) return;
  if (!refreshToken && !accessToken) return;
  const now = Date.now();
  if (now - lastUnreachableAt < 60_000) return;
  lastUnreachableAt = now;
  downNow = true;
  try {
    window.dispatchEvent(new CustomEvent('suen:server-unreachable'));
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/** 成功响应：把"已断开"状态收回来 */
function notifyReachable(): void {
  if (!downNow) return;
  downNow = false;
  try {
    window.dispatchEvent(new CustomEvent('suen:server-ok'));
  } catch {
    /* 忽略 */
  }
}

/** 登出后重置：下次再登录时第一条失败仍要提示 */
export function resetUnreachableNotice(): void {
  lastUnreachableAt = 0;
  downNow = false;
}

/**
 * 多路径选路钩子。
 *
 * 由 `api/servers.ts` 在导入时注册 —— 用回调而不是直接 import，
 * 是为了避开 `client ⇄ servers` 的循环依赖（servers 要用 setBaseUrl）。
 */
let failoverHook: (() => Promise<boolean>) | null = null;

export function registerFailoverHook(fn: () => Promise<boolean>): void {
  failoverHook = fn;
}

export const http = {
  get: <T>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'GET' }),

  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),

  put: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'PUT', body }),

  delete: <T>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
};

/**
 * 不带鉴权头的公开请求。目前只有 `/api/auth/config` 用得上 ——
 * 登录页在拿到任何令牌之前就要知道该不该显示注册入口。
 */
export async function publicRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await rawFetch(path, { ...opts, _noAuth: true });
  if (!res.ok) throw await parseError(res);
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
