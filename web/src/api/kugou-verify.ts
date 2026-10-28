/**
 * 酷狗「人机验证」五接口：pending / state / refresh / send-sms / submit。
 *
 * 两份鉴权，别混：
 *   · pending 走**登录态**（不发 t）—— 设置页/App 启动时主动问「服务端有没有活跃验证事件」，
 *     不要求本机先撞过 20028；
 *   · state / refresh / send-sms / submit 只认 URL 上的 `t` —— 验证页会在**手机系统
 *     浏览器**里被直接打开（链接由移动端通知带过来），那里没有登录态，也不该带登录令牌。
 *
 * 带 t 的调用一律走 publicRequest：不发 Authorization，且 401 不会触发全局
 * 续期/登出（验证链接过期是常态，绝不能把用户踢下线）。
 *
 * 字段名是服务端契约，不可改（见任务单）：needed / provider / providerName /
 * supported / eventId / txAppId / sessionId / message / createdAt / expiresAt /
 * verifyUrl / smsMobileHint。
 */

import { ApiError, http, publicRequest } from './client.ts';

/**
 * 酷狗下发的验证方式。
 * 只有 TX / SMS / LOGIN 是 supported=true；其余一律显示服务端 message，不给操作。
 */
export type KugouVerifyProvider =
  | 'TX'
  | 'GT'
  | 'KG'
  | 'KG2'
  | 'SM'
  | 'YD'
  | 'SMS'
  | 'LOGIN'
  | 'BIND_PHONE'
  | 'REAL_NAME'
  | 'ACCOUNT_RISK'
  | 'UNKNOWN';

export interface KugouVerifyState {
  /** 当前是否真的需要验证（false = 已解除 / 无待处理事件） */
  needed: boolean;
  provider: KugouVerifyProvider;
  /** 服务端给的中文名，前端不再维护「provider → 中文」映射表 */
  providerName: string;
  /** 只有 TX / SMS / LOGIN 为 true */
  supported: boolean;
  eventId: string;
  txAppId: string;
  sessionId: string;
  message: string;
  /** 时间字段：服务端可能给 ISO 字符串或秒/毫秒时间戳，这里只声明可能的值域 */
  createdAt: string | number;
  expiresAt: string | number;
  /** /verify/kugou?t=<token>（相对路径） */
  verifyUrl: string;
  /** SMS 验证时上游带的**脱敏**手机号（如 138****8000）；为空则该页让用户自己填 */
  smsMobileHint: string;
}

/** send-sms 的回执：ok=false 时 message 就是给用户看的原因 */
export interface KugouVerifySmsResult {
  ok: boolean;
  message: string;
}

export interface KugouVerifySubmitResult {
  ok: boolean;
  message: string;
  state: KugouVerifyState;
}

/** 上次验证页用过的 t —— 设置页探测时带上它，服务端若要 t 也不会白跑 */
const TOKEN_KEY = 'suenmusic.kugou.verifyToken';

export function readVerifyToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function saveVerifyToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 隐私模式写不进去：只是少了设置页探测的机会，不影响验证流程 */
  }
}

/** 票据被服务端否掉（过期/事件已清）就丢掉，免得设置页每次打开都白跑一次 401 */
export function clearVerifyToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 同上 */
  }
}

/** verifyUrl 里的 t。服务端把它拼在相对路径上，这里按相对 URL 解析 */
export function extractVerifyToken(verifyUrl: string): string {
  if (!verifyUrl) return '';
  try {
    const url = new URL(verifyUrl, window.location.origin);
    return (url.searchParams.get('t') || '').trim();
  } catch {
    return '';
  }
}

/**
 * 腾讯验证码通过后拼票据 —— 格式照酷狗登录链路（KGCodeTX|{ticket,randstr,txappid}），
 * 少一个字段酷狗就回 20028，所以字段名与顺序都不要动。
 */
export function buildTencentVerifyCode(input: {
  ticket?: string;
  randstr?: string;
  txAppId: string;
}): string {
  return `KGCodeTX|${JSON.stringify({
    ticket: input.ticket,
    randstr: input.randstr,
    txappid: input.txAppId,
  })}`;
}

/** 验证页：按 URL 上的 t 取状态 */
export function fetchVerifyStateByToken(
  token: string,
  signal?: AbortSignal,
): Promise<KugouVerifyState> {
  return publicRequest<KugouVerifyState>('/api/kugou/verify/state', {
    method: 'GET',
    query: { t: token },
    signal,
  });
}

/** 验证页：事件过期后换一个新的 */
export function refreshVerifyStateByToken(
  token: string,
  signal?: AbortSignal,
): Promise<KugouVerifyState> {
  return publicRequest<KugouVerifyState>('/api/kugou/verify/refresh', {
    method: 'POST',
    query: { t: token },
    signal,
    timeoutMs: 15_000,
  });
}

/** 验证页：给 SMS 验证发一条短信（body 字段名是 `mobile`，契约不可改） */
export function sendVerifySms(token: string, mobile: string): Promise<KugouVerifySmsResult> {
  return publicRequest<KugouVerifySmsResult>('/api/kugou/verify/send-sms', {
    method: 'POST',
    query: { t: token },
    body: { mobile },
    timeoutMs: 20_000,
  });
}

/**
 * 验证页：提交验证码。
 *
 * body 字段名是 `code`（契约 v2，旧名 verifyCode 一律不用）：
 *   · TX → `KGCodeTX|{ticket,randstr,txappid}`
 *   · SMS → 用户输入的短信验证码
 */
export function submitVerifyCode(token: string, code: string): Promise<KugouVerifySubmitResult> {
  return publicRequest<KugouVerifySubmitResult>('/api/kugou/verify/submit', {
    method: 'POST',
    query: { t: token },
    body: { code },
    timeoutMs: 20_000,
  });
}

/**
 * 设置页：探测「是否需要验证」。
 *
 * 首选 GET /api/kugou/verify/pending —— 走登录态、不要 t。这样只要服务端手上还有
 * 活跃的验证事件，「需要验证」与按钮就会出现，**不要求本机先撞过 20028**（上一轮的
 * 缺口：旧逻辑没票据就彻底看不到提示）。
 *
 * 兜底仍是老路子：pending 不可用（旧服务端 404 / 网络抖动）时回退到「缓存票据 + state」，
 * 票据来自 resolve 撞到 20028 时下发的 verifyUrl。两条都拿不到 → null（提示不出现）。
 *
 * 401/403 → 未登录或无可用事件，直接 null（不要再去试票据，避免徒增一次失败请求）。
 * 带 t 的兜底走 publicRequest，401 不会触发全局续期/登出。
 */
export async function fetchVerifyStateIfAvailable(
  signal?: AbortSignal,
): Promise<KugouVerifyState | null> {
  try {
    const pending = await http.get<KugouVerifyState | null>('/api/kugou/verify/pending', {
      signal,
      timeoutMs: 15_000,
    });
    if (pending) return pending;
  } catch (err) {
    if (err instanceof ApiError && (err.isUnauthorized || err.status === 403)) return null;
    /* 其余（404 旧服务端 / 网络）交给下面的票据兜底 */
  }
  return fetchVerifyStateByCachedToken(signal);
}

/** 兜底探测：用上次缓存的 t 问 state；票据被否掉就当「无事件」并清掉它 */
async function fetchVerifyStateByCachedToken(
  signal?: AbortSignal,
): Promise<KugouVerifyState | null> {
  const token = readVerifyToken();
  if (!token) return null;
  try {
    return await fetchVerifyStateByToken(token, signal);
  } catch (err) {
    if (err instanceof ApiError && (err.isUnauthorized || err.status === 403 || err.status === 404)) {
      clearVerifyToken();
      return null;
    }
    throw err;
  }
}
