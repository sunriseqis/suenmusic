/**
 * 酷狗二次安全验证（错误码 20028「本次请求需要验证」）的服务端实现。
 *
 * 链路位置：`sources/kugou/stream.ts` 取流走到 /tracker/v5/url 撞到 20028
 * → 本模块登记一条验证事件（eventid 来自响应头 `ssa-code`）
 * → 客户端拿 /api/kugou/verify/{state,refresh,submit,send-sms,pending} 推进验证
 * → 验证通过后清事件并让缓存失效，下一次解析重新取流。
 *
 * 协议取自参考实现（MakcRe/KuGouMusicApi + hoowhoami/EchoMusic）：
 *   · GET_VERIFY_INFO   POST https://gateway.kugou.com/verifyservice/v3/get_verify_info
 *   · VERIFY_USER_INFO  POST https://verifyservice.kugou.com/v4/verify_user_info（v_type=23/32）
 *   · SEND_MOBILE_CODE  POST http://login.user.kugou.com/v7/send_mobile_code（v_type=32 的短信）
 *
 * 支持自动验证的只有三种：TX（腾讯验证码 23）、SMS（短信 32）、LOGIN（登录确认 38，
 * 只能刷新状态、等用户在客户端点完）。其余 provider 一律 supported=false + 固定文案。
 * 两者参数一律用概念版 lite 签名（与 stream.ts 的 signLite 同款），
 * 且**不能带 x-router**（带上会 404，实测）。
 *
 * 事件只存内存：它就是「刚才这台服务器撞到验证」的瞬时状态，
 * 重启后重新解析一次就会再登记，不需要落库。
 */

import crypto from 'node:crypto';
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import { getSetting } from '../db/repo/settings.ts';
import { getKugouDevice } from './kugou-login.ts';
import { cryptoAesEncrypt, cryptoRSAEncrypt } from '../sources/kugou/crypto.ts';
import { generateSimulate } from '../sources/kugou/simulate.ts';
import { APPID_LITE, CLIENTVER_LITE, SIGN_SALT_LITE, UA_LITE } from '../sources/kugou/source.ts';

const log = createLogger('kugou:verify');

/** 验证事件存活时间：30 分钟。超过就当作过期，客户端需要重新解析触发出新事件 */
const VERIFY_EVENT_TTL_MS = 30 * 60_000;
/** 验证票据（token）有效期：30 分钟，与事件同寿命 */
export const KUGOU_VERIFY_TOKEN_TTL_MS = 30 * 60_000;

const GET_VERIFY_INFO_URL = 'https://gateway.kugou.com/verifyservice/v3/get_verify_info';
const VERIFY_USER_INFO_URL = 'https://verifyservice.kugou.com/v4/verify_user_info';
/** 提交验证码时固定带上的客户端版本（参考实现 module/verify_user_info.js:46） */
const VERIFY_CLIENTVER = '11510';
/** 腾讯验证码：提交 verifycode + AES({}) */
const V_TYPE_TX = 23;
/** 短信验证码：提交 code + AES({ code })（参考实现 module/verify_user_info.js:29-37） */
const V_TYPE_SMS = 32;
/** 登录确认：上游只给 show.msg 文案，没有验证码可提交，只能刷新状态 */
const V_TYPE_LOGIN = 38;
/** 短信验证码下发（参考实现 module/captcha_sent.js） */
const SEND_SMS_URL = 'http://login.user.kugou.com/v7/send_mobile_code';

/**
 * 短信下发频控（S-17）：**同号 60 秒一次 + 每小时最多 5 次**。
 *
 * 为什么必须在服务端做：60 秒冷却以前只存在于 Web 验证页（KugouVerify.vue 的
 * smsCountdown），而拿不到前端的调用者（改几个请求、或原生端/串）可以在票据的
 * 30 分钟窗口内对同一个号码无限触发上游 send_mobile_code —— 短信轰炸机主 +
 * 烧酷狗侧配额 + 给本机 IP 招风控。
 *
 * 内存计数即可：验证事件本身也只存内存、票据 30 分钟就过期，重启丢计数不会放大风险
 * （重启后旧票据也一起失效了）。
 */
const SMS_MIN_INTERVAL_MS = 60_000;
const SMS_MAX_PER_WINDOW = 5;
const SMS_WINDOW_MS = 60 * 60_000;
/** 超限文案。**不返回 429**：三端只认 { ok, message }，非 2xx 会被当成"网络错误"提示 */
export const SMS_RATE_LIMIT_MESSAGE = '发送过于频繁，请稍后再试';

/** mobile → 窗口内每次受理的时间戳（升序） */
const smsSendLog = new Map<string, number[]>();

/** 频控判定：先看 60 秒间隔，再看每小时次数。命中即拒，不写计数 */
function smsRateLimited(mobile: string, now = Date.now()): boolean {
  const hits = (smsSendLog.get(mobile) ?? []).filter(t => now - t < SMS_WINDOW_MS);
  if (hits.length === 0) {
    smsSendLog.delete(mobile);
    return false;
  }
  smsSendLog.set(mobile, hits);
  if (now - hits[hits.length - 1] < SMS_MIN_INTERVAL_MS) return true;
  return hits.length >= SMS_MAX_PER_WINDOW;
}

/**
 * 记一次受理。**在调上游之前记**：上游失败/超时也算一次，
 * 否则「打上游→失败→立刻再打」就是一条绕开频控的免费通道。
 */
function noteSmsSend(mobile: string, now = Date.now()): void {
  const hits = smsSendLog.get(mobile) ?? [];
  hits.push(now);
  smsSendLog.set(mobile, hits.slice(-SMS_MAX_PER_WINDOW));
  // 号码条目无界增长（每个新号码一行）：超过 200 个号就把窗口内已空的清掉
  if (smsSendLog.size > 200) {
    for (const [key, times] of smsSendLog) {
      if (times.every(t => now - t >= SMS_WINDOW_MS)) smsSendLog.delete(key);
    }
  }
}

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

/** 展示名原样取自参考实现 EchoMusic `src/renderer/utils/kugouVerification.ts:36-49` */
export const KUGOU_VERIFY_PROVIDER_NAMES: Record<KugouVerifyProvider, string> = {
  TX: '腾讯验证码',
  GT: '极验验证码',
  KG: '酷狗滑块',
  KG2: '酷狗旋转',
  SM: '数美验证码',
  YD: '网易易盾',
  SMS: '手机验证码',
  LOGIN: '登录确认',
  BIND_PHONE: '绑定手机号',
  REAL_NAME: '实名认证',
  ACCOUNT_RISK: '账号风控',
  UNKNOWN: '未知验证',
};

/**
 * 不支持自动验证时的固定文案（契约 v2：除 TX|SMS|LOGIN 外一律用这句，
 * 三端展示同一行字，前端不再自己拼「当前需要 XX」）
 */
export const KUGOU_VERIFY_UNSUPPORTED_MESSAGE = '账号存在风险，请前往酷狗客户端处理';

/** 支持自动验证的 provider（TX=腾讯验证码 / SMS=短信 / LOGIN=登录确认） */
const SUPPORTED_PROVIDERS: readonly KugouVerifyProvider[] = ['TX', 'SMS', 'LOGIN'];

/**
 * v_type → 验证渠道，**先看 v_type 再看 url**（参考实现 :89-110 的顺序）。
 * 32/34/36/38/51 是「流程阻塞型」：不是验证码，url 里也没有 KGCode 前缀。
 */
const V_TYPE_PROVIDER: Record<number, KugouVerifyProvider> = {
  // 腾讯验证码有时不带 KGCode 前缀（v_type=23 就是它），直接按类型认，别再依赖 url
  23: 'TX',
  32: 'SMS',
  34: 'REAL_NAME',
  36: 'BIND_PHONE',
  38: 'LOGIN',
  51: 'ACCOUNT_RISK',
};

/** url 前缀 `KGCode<TYPE>|` 只认这六家，其余归 UNKNOWN（与参考实现一致） */
const URL_CODE_PROVIDER: Record<string, KugouVerifyProvider> = {
  TX: 'TX',
  GT: 'GT',
  KG: 'KG',
  KG2: 'KG2',
  SM: 'SM',
  YD: 'YD',
};

/** 上游 /get_verify_info 归一化后的验证信息 */
export interface KugouVerifyInfo {
  vType: number;
  /** 形如 KGCodeTX|197787253 */
  url: string;
  /** 腾讯验证码 appid（v_type=23 时用它初始化 TCaptcha） */
  txAppId: string;
  /** wasm 行为指纹（上游给就给，不给就是空串） */
  sid: string;
  edt: string;
  /** 上游 show.msg 文案：v_type=38（登录确认）只有它能告诉用户去做什么 */
  showMsg: string;
}

/** 对外契约（三端一致，字段名不得更改） */
export interface KugouVerifyState {
  needed: boolean;
  provider: KugouVerifyProvider;
  providerName: string;
  supported: boolean;
  eventId: string;
  txAppId: string;
  sessionId: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  verifyUrl: string;
  /** 凭据里的手机号脱敏值（138****8888）；没存手机号就是空串（v_type=32 用） */
  smsMobileHint: string;
}

export interface KugouVerifySubmitResult {
  ok: boolean;
  message: string;
  state: KugouVerifyState;
}

interface VerifyEvent {
  eventId: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  info: KugouVerifyInfo | null;
  /** 最近一次上游失败文案；成功刷新后清空 */
  error: string;
  /**
   * 登记这个事件时的酷狗 userid。事件与「哪套凭据撞的 20028」绑定：
   * 换了账号/退出登录后，旧事件对谁都无用（上游查不到 ev_data），必须自己作废 ——
   * 否则它会因为「不覆盖已有事件」（S-22）而把新账号的验证页堵满 30 分钟。
   */
  userid: string;
}

let currentEvent: VerifyEvent | null = null;

// ---------- 签名与请求（与 stream.ts 的 lite 签名同款算法） ----------

function md5(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

function signLite(params: Record<string, string>, body = ''): string {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('');
  return md5(SIGN_SALT_LITE + sorted + body + SIGN_SALT_LITE);
}

interface KugouCredsLite {
  token: string;
  userid: string;
  /** 登录时留下的手机号（扫码登录通常没有，就是空串）—— v_type=32 的 smsMobileHint 用 */
  mobile: string;
}

/** 热读 app_settings 里的酷狗凭据（本模块不能 import stream.ts：那会构成循环依赖） */
function readCreds(): KugouCredsLite | null {
  const raw = getSetting('kugou.credentials');
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { token?: unknown; userid?: unknown; mobile?: unknown; phone?: unknown };
    if (!p.token || !p.userid) return null;
    return {
      token: String(p.token),
      userid: String(p.userid),
      mobile: String(p.mobile ?? p.phone ?? '').trim(),
    };
  } catch {
    return null;
  }
}

/** 手机号脱敏：138****8888。拿不到/不像手机号就回空串（前端据此藏掉提示行） */
export function maskMobile(mobile: string | undefined): string {
  const m = String(mobile ?? '').trim();
  if (!/^1\d{10}$/.test(m)) return '';
  return `${m.slice(0, 3)}****${m.slice(7)}`;
}

function buildLiteParams(extra: Record<string, string>, body = ''): Record<string, string> {
  const dev = getKugouDevice();
  const creds = readCreds();
  const params: Record<string, string> = {
    dfid: dev.dfid || '-',
    appid: APPID_LITE,
    clientver: CLIENTVER_LITE,
    mid: dev.mid,
    uuid: '-',
    clienttime: String(Math.floor(Date.now() / 1000)),
    ...extra,
  };
  if (creds) {
    params.token = creds.token;
    params.userid = creds.userid;
  }
  params.signature = signLite(params, body);
  return params;
}

function liteHeaders(clienttime: string, extra: Record<string, string> = {}): Record<string, string> {
  const dev = getKugouDevice();
  return {
    'User-Agent': UA_LITE,
    dfid: dev.dfid || '-',
    mid: dev.mid,
    clienttime,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    'Content-Type': 'application/json',
    ...extra,
  };
}

interface UpstreamReply {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}

/** POST JSON：参数进 query（lite 签名覆盖 query 参数 + body 原文），body 为 JSON */
async function postJson(
  url: string,
  body: Record<string, unknown>,
  extraParams: Record<string, string> = {},
  extraHeaders: Record<string, string> = {},
): Promise<UpstreamReply> {
  const bodyStr = JSON.stringify(body);
  const params = buildLiteParams(extraParams, bodyStr);
  const res = await fetch(`${url}?${new URLSearchParams(params)}`, {
    method: 'POST',
    headers: liteHeaders(params.clienttime, extraHeaders),
    body: bodyStr,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
  } catch {
    // 上游偶发返回 WAF/HTML 页，调用方按「非 JSON」处理
  }
  return { status: res.status, json, text };
}

/** 上游可能把内容放在 data 里，也可能平铺在顶层 —— 两处都认 */
function pickPayload(json: Record<string, unknown>): Record<string, unknown> {
  const data = json.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : json;
}

/** 上游判定成功：status=1 且 error_code=0（对齐参考实现 assertKugouVerificationSuccess） */
function upstreamFailed(json: Record<string, unknown>): boolean {
  const status = json.status === undefined ? 1 : Number(json.status);
  const errcode = Number(json.errcode ?? json.error_code ?? 0);
  return status !== 1 || errcode !== 0;
}

function upstreamErrorText(json: Record<string, unknown>, text: string): string {
  const errcode = Number(json.errcode ?? json.error_code ?? 0);
  const detail = String(json.error ?? json.msg ?? json.message ?? '').trim().slice(0, 120);
  if (detail) return errcode ? `${detail}（error_code=${errcode}）` : detail;
  if (errcode) return `上游 error_code=${errcode}`;
  return text.trim().slice(0, 120) || '上游未给出原因';
}

/** 36001 = 上游没有这次验证事件的数据（事件过期或已被消费），实测就是这个码 */
function verifyInfoErrorText(json: Record<string, unknown>, text: string): string {
  const errcode = Number(json.errcode ?? json.error_code ?? 0);
  if (errcode === 36001) return '酷狗未能提供本次验证信息（36001），请重新解析一次曲目';
  return upstreamErrorText(json, text);
}

// ---------- provider 分类 ----------

/** url 形如 `KGCodeTX|197787253` → 'TX'（无 `|` 后缀也认，比参考实现略宽） */
function providerOfUrl(url: string): KugouVerifyProvider | null {
  const m = /^KGCode([A-Z0-9]+)(?:\||$)/i.exec(url.trim());
  if (!m) return null;
  return URL_CODE_PROVIDER[m[1].toUpperCase()] ?? null;
}

/** 把上游验证信息映射成 provider（v_type → url 前缀 → txappid 兜底） */
export function classifyKugouVerifyProvider(info: KugouVerifyInfo | null): KugouVerifyProvider {
  if (!info) return 'UNKNOWN';
  const fromType = V_TYPE_PROVIDER[info.vType];
  if (fromType) return fromType;
  const fromUrl = providerOfUrl(info.url);
  if (fromUrl) return fromUrl;
  // 没有 KGCode 前缀却带着腾讯 appid：就是腾讯验证码（参考实现同款兜底）
  return info.txAppId ? 'TX' : 'UNKNOWN';
}

function supportsProvider(provider: KugouVerifyProvider): boolean {
  return SUPPORTED_PROVIDERS.includes(provider);
}

/**
 * 文案优先级：上游错误 > 该 provider 的引导语 > 固定风控文案。
 * 不支持的 provider 一律固定文案（契约 v2），不再拼「当前需要 XX」。
 */
function stateMessage(provider: KugouVerifyProvider, event: VerifyEvent | null): string {
  if (event?.error) return event.error;
  if (provider === 'TX') return '需要完成腾讯验证码后才能继续获取音频';
  if (provider === 'SMS') return '请输入酷狗下发的短信验证码';
  if (provider === 'LOGIN') return event?.info?.showMsg || '请在酷狗客户端完成登录确认后重试';
  return KUGOU_VERIFY_UNSUPPORTED_MESSAGE;
}

// ---------- 事件读写 ----------

function activeEvent(now = Date.now()): VerifyEvent | null {
  if (!currentEvent) return null;
  if (currentEvent.expiresAt <= now) {
    currentEvent = null;
    return null;
  }
  /**
   * 凭据已不是登记时的那个账号 → 事件作废（惰性过期，不额外挂清理任务）。
   *
   * 为什么必须这么做：S-22 起「已有未过期事件不覆盖」，如果换账号后旧事件还赖着，
   * 新账号撞 20028 也登记不进来，玩家会被引到一张验证的是别人事件的页面（上游回
   * no find ev_data），而且这一堵就是 30 分钟。
   */
  if (currentEvent.userid !== (readCreds()?.userid ?? '')) {
    log.warn(
      `酷狗登录凭据已更换（eventid=${currentEvent.eventId} 登记于 userid=${currentEvent.userid || '(空)'}），作废该验证事件`,
    );
    currentEvent = null;
    return null;
  }
  return currentEvent;
}

/**
 * 取流层撞到 20028 时登记事件。eventid 取响应头 `ssa-code`。
 * 同一事件重复命中只续期，不重置 sessionId（客户端可能正在验证它）。
 */
export function noteKugouVerifyEvent(eventIdRaw: string, via: string): void {
  const eventId = String(eventIdRaw ?? '').trim();
  // 上游没给 ssa-code（响应头缺失或为空）时不登记：没有 eventid 的验证页必然失败。
  // 一旦登记，/api/resolve 就会下发 need_verification + verifyUrl，把用户引到死路；
  // 同时也不覆盖可能仍然有效的旧事件。
  if (!eventId) {
    log.warn(`酷狗要求二次验证（20028 via ${via}），但上游未给 ssa-code，拒绝登记（不下发验证页）`);
    return;
  }
  const now = Date.now();
  const existing = activeEvent(now);
  /**
   * 已有**未过期**事件时一律不覆盖，只续期（S-22）。
   *
   * 旧写法只在 eventId 相同时续期，不同就整体覆盖 —— 多设备/多用户同时撞 20028 时
   * 后来者会顶掉前者：sessionId 重置、正在验证的那张票据指向的事件被换走，
   * 用户表现为「验证页突然说没在验证」。
   *
   * 现在的语义：一个事件在它的 30 分钟寿命内独占，直到它过期（或验证通过被清掉）
   * 之后才接受新事件。后到的那次 20028 只把存活期往后推，不换内容。
   */
  if (existing) {
    existing.expiresAt = now + VERIFY_EVENT_TTL_MS;
    if (existing.eventId !== eventId) {
      log.warn(
        `酷狗要求二次验证（20028 via ${via}）：已有未过期事件 eventid=${existing.eventId}，` +
          `忽略新事件 eventid=${eventId}（不覆盖，仅续期）`,
      );
    }
    return;
  }
  currentEvent = {
    eventId,
    sessionId: crypto.randomBytes(8).toString('hex'),
    createdAt: now,
    expiresAt: now + VERIFY_EVENT_TTL_MS,
    info: null,
    error: '',
    userid: readCreds()?.userid ?? '',
  };
  log.warn(`酷狗要求二次验证（20028 via ${via}）：eventid=${eventId}`);
}

/**
 * 当前是否有待完成的验证事件。
 * 注意：**不能**拿它当「这次解析需要验证」的依据（那会把 B 站失败/网络失败也标成
 * need_verification）—— 判定看 ResolveResult.verifyRequired，这里只管「有没有可打开的验证页」。
 */
export function isKugouVerifyPending(): boolean {
  return activeEvent() !== null;
}

function buildState(event: VerifyEvent | null, token: string): KugouVerifyState {
  if (!event) {
    return {
      needed: false,
      provider: 'UNKNOWN',
      providerName: KUGOU_VERIFY_PROVIDER_NAMES.UNKNOWN,
      supported: false,
      eventId: '',
      txAppId: '',
      sessionId: '',
      message: '',
      createdAt: 0,
      expiresAt: 0,
      verifyUrl: buildKugouVerifyUrl(token),
      smsMobileHint: maskMobile(readCreds()?.mobile),
    };
  }
  const provider = classifyKugouVerifyProvider(event.info);
  const supported = supportsProvider(provider);
  return {
    needed: true,
    provider,
    providerName: KUGOU_VERIFY_PROVIDER_NAMES[provider],
    supported,
    eventId: event.eventId,
    txAppId: event.info?.txAppId ?? '',
    sessionId: event.sessionId,
    message: stateMessage(provider, event),
    createdAt: event.createdAt,
    expiresAt: event.expiresAt,
    verifyUrl: buildKugouVerifyUrl(token),
    smsMobileHint: maskMobile(readCreds()?.mobile),
  };
}

/** 纯读当前状态（不碰上游） */
export function readKugouVerifyState(token: string): KugouVerifyState {
  return buildState(activeEvent(), token);
}

/** 向上游重新取一次验证信息（/get_verify_info） */
export async function refreshKugouVerifyState(token: string): Promise<KugouVerifyState> {
  const event = activeEvent();
  if (!event) return buildState(null, token);
  if (!event.eventId) {
    event.error = '上游未回传验证事件 id（ssa-code），无法刷新验证信息';
    return buildState(event, token);
  }

  try {
    const info = await fetchVerifyInfo(event.eventId);
    event.info = info;
    event.error = '';
    log.info(
      `验证信息已刷新：v_type=${info.vType} url=${info.url || '(空)'} ` +
        `txappid=${info.txAppId || '(空)'} provider=${classifyKugouVerifyProvider(info)}`,
    );
  } catch (err) {
    event.error = `获取验证信息失败：${(err as Error).message}`;
    log.warn(event.error);
  }
  return buildState(event, token);
}

async function fetchVerifyInfo(eventId: string): Promise<KugouVerifyInfo> {
  const { status, json, text } = await postJson(GET_VERIFY_INFO_URL, {
    eventid: eventId,
    userid: Number(readCreds()?.userid ?? 0) || 0,
    platid: 2,
    rtype: 1,
    wasm: 1,
    i: '',
    sid: '',
    edt: '',
  });
  if (!json) throw new Error(`上游返回非 JSON（HTTP ${status}）：${text.slice(0, 80)}`);
  if (upstreamFailed(json)) throw new Error(verifyInfoErrorText(json, text));

  const payload = pickPayload(json);
  /** show.msg：v_type=38（登录确认）上游唯一给出的用户引导文案（kvf.vue:71-73 同款取法） */
  const show = (payload.show ?? json.show) as Record<string, unknown> | undefined;
  const info: KugouVerifyInfo = {
    vType: Number(payload.v_type ?? 0),
    url: String(payload.url ?? ''),
    txAppId: String(payload.txappid ?? payload.tx_appid ?? ''),
    sid: String(payload.sid ?? ''),
    edt: String(payload.edt ?? ''),
    showMsg: String(show?.msg ?? '').trim(),
  };
  if (!info.vType && !info.url) throw new Error(`验证信息为空：${text.slice(0, 120)}`);
  return info;
}

/**
 * 提交验证码。三型分支（契约 v2）：
 *   · v_type=23 腾讯验证码 → 提交 verifycode
 *   · v_type=32 短信验证码 → 提交 code（AES 明文里带 code）
 *   · v_type=38 登录确认   → **没有验证码可提交**，重新 refresh 一次并回最新 state，
 *     前端的「我已完成，重新检查」就是打到这里；不能报错（报错会把用户卡死）。
 */
export async function submitKugouVerifyCode(
  verifyCode: string,
  token: string,
): Promise<KugouVerifySubmitResult> {
  const event = activeEvent();
  if (!event) {
    return {
      ok: false,
      message: '当前没有待完成的酷狗验证（已过期或已完成）',
      state: buildState(null, token),
    };
  }

  /**
   * 还没有验证信息就先取一次：v_type 决定走哪个提交分支（23 还是 32），
   * 猜错就是 AES 明文分支错、上游必失败，所以宁可多打一次 /get_verify_info。
   */
  const prefetched: KugouVerifyState | null = event.info ? null : await refreshKugouVerifyState(token);

  // 登录确认：先把上游最新文案/状态取回来再说，这里没有验证码可提交
  const info = event.info;
  if (info?.vType === V_TYPE_LOGIN) {
    const state = prefetched ?? (await refreshKugouVerifyState(token));
    const message = state.message || info.showMsg || '请在酷狗客户端完成登录确认后重试';
    log.info(`登录确认（v_type=38）重新检查：needed=${state.needed} message=${message}`);
    return { ok: !state.needed, message, state };
  }

  if (!info) {
    // 取不到验证信息就不能猜分支（拿 23 的报文去交 32 的码，上游只会回一个看不懂的错误码）
    return {
      ok: false,
      message: event.error || '尚未取得验证信息，请先刷新验证状态',
      state: buildState(event, token),
    };
  }

  if (!event.eventId) {
    return {
      ok: false,
      message: '上游未回传验证事件 id（ssa-code），无法提交验证',
      state: buildState(event, token),
    };
  }

  const provider = classifyKugouVerifyProvider(info);
  const vType = info.vType;
  if (vType !== V_TYPE_TX && vType !== V_TYPE_SMS) {
    // 不支持的 provider 用固定文案；支持但 v_type 说不清的（上游字段异常）才报具体型号
    const message = supportsProvider(provider)
      ? `当前需要${KUGOU_VERIFY_PROVIDER_NAMES[provider]}（v_type=${vType}），服务端暂不支持提交该类型`
      : KUGOU_VERIFY_UNSUPPORTED_MESSAGE;
    event.error = message;
    return { ok: false, message, state: buildState(event, token) };
  }

  try {
    const reply = await postVerifyUserInfo(event, verifyCode, vType);
    if (!reply.ok) {
      event.error = reply.message;
      return { ok: false, message: reply.message, state: buildState(event, token) };
    }
    currentEvent = null;
    log.info(`酷狗验证码已提交并被上游接受（v_type=${vType}），验证事件已清除`);
    return { ok: true, message: '验证通过', state: buildState(null, token) };
  } catch (err) {
    const message = `提交验证失败：${(err as Error).message}`;
    event.error = message;
    log.warn(message);
    return { ok: false, message, state: buildState(event, token) };
  }
}

/**
 * 取提交要用的 sid/edt。
 *
 * get_verify_info 返回的 sid/edt 实测为空，而参考实现的真实提交走 module/sidedt.js：
 * 用本地生成的行为指纹（util/generate_simulate.js）替换掉空值。这里只在**上游确实为空**
 * 时才生成 —— 上游哪天开始给真值，就直接用上游的，不再叠加本地指纹。
 */
function ensureSidEdt(event: VerifyEvent): { sid: string; edt: string } {
  const sid = String(event.info?.sid ?? '').trim();
  const edt = String(event.info?.edt ?? '').trim();
  if (sid && edt) return { sid, edt };
  try {
    const dev = getKugouDevice();
    const sim = generateSimulate(dev.mid, readCreds()?.userid ?? 0, dev.dfid);
    log.info(
      `上游 sid/edt 为空，已本地生成行为指纹（sid ${sim.sid.length} 字符 / edt ${sim.edt.length} 字符）`,
    );
    return sim;
  } catch (err) {
    log.warn(`sid/edt 生成失败，按空值提交：${(err as Error).message}`);
    return { sid, edt };
  }
}

/** params（AES 密文）与 pk（RSA 包住的 AES key）必须来自同一次 cryptoAesEncrypt */
function encryptPair(payload: Record<string, string>): { pk: string; params: string } {
  const encrypt = cryptoAesEncrypt(payload);
  return { pk: cryptoRSAEncrypt({ key: encrypt.key }), params: encrypt.str };
}

/**
 * 短信验证码下发（v_type=32）。参考实现 module/captcha_sent.js：
 * POST http://login.user.kugou.com/v7/send_mobile_code  body {businessid:5, mobile, plat:3}，
 * cookie 带 mid —— mid 决定"这条验证码算哪个设备的"，缺了上游会另起一个会话。
 */
export async function sendKugouVerifySms(mobile: string): Promise<{ ok: boolean; message: string }> {
  const dev = getKugouDevice();
  /**
   * 最终号码：显式传入优先，为空则回落到凭据里登录时留下的手机号。
   * 回落依据：state.smsMobileHint 就是 maskMobile(readCreds()?.mobile)（本文件取 state 的两处），
   * 前端在 hint 非空时不收集手机号、body 传空串 —— hint 非空即等价于凭据里有号，
   * 这条回落与前端行为同源，不是猜测。两边都为空才算「未取到手机号」。
   */
  const target = String(mobile ?? '').trim() || readCreds()?.mobile || '';
  if (!target) return { ok: false, message: '未取到手机号，请手动填写后再发送' };

  /**
   * 频控按**最终号码**算（显式传入优先、空则回落凭据里的号）：
   * 键必须是真正会收到短信的那个号，否则空 body 回落路径就是一个绕过口。
   */
  const now = Date.now();
  if (smsRateLimited(target, now)) {
    log.warn(`短信下发过于频繁，已拒绝 mobile=${maskMobile(target)}`);
    return { ok: false, message: SMS_RATE_LIMIT_MESSAGE };
  }
  noteSmsSend(target, now);

  try {
    const { status, json, text } = await postJson(
      SEND_SMS_URL,
      { businessid: 5, mobile: target, plat: 3 },
      {},
      { Cookie: `mid=${dev.mid}` },
    );
    if (!json) return { ok: false, message: `验证码下发失败：上游返回非 JSON（HTTP ${status}）` };
    log.debug(`send_mobile_code 回执 HTTP ${status}：${text.slice(0, 200)}`);
    if (upstreamFailed(json)) return { ok: false, message: `验证码下发失败：${upstreamErrorText(json, text)}` };
    return { ok: true, message: '验证码已下发，请查收短信' };
  } catch (err) {
    return { ok: false, message: `验证码下发失败：${(err as Error).message}` };
  }
}

async function postVerifyUserInfo(
  event: VerifyEvent,
  verifyCode: string,
  vType: number,
): Promise<{ ok: boolean; message: string }> {
  const { sid, edt } = ensureSidEdt(event);
  /**
   * 字段与参考实现 module/verify_user_info.js:8-37 对齐。两型只差两处：
   * 验证码落在哪个字段、AES 明文里装什么。
   *   · 23（腾讯）：verifycode + AES({})
   *   · 32（短信）：code       + AES({ code })  ← 明文里必须带 code，空对象解出来是空码
   */
  const base = {
    eventid: event.eventId,
    userid: Number(readCreds()?.userid ?? 0) || 0,
    platid: 2,
    v_type: vType,
    wasm: 1,
    i: '',
    sid,
    edt,
  };
  const body =
    vType === V_TYPE_SMS
      ? { ...base, code: verifyCode, ...encryptPair({ code: verifyCode }) }
      : { ...base, verifycode: verifyCode, ...encryptPair({}) };
  const { status, json, text } = await postJson(VERIFY_USER_INFO_URL, body, {
    clientver: VERIFY_CLIENTVER,
  });

  if (!json) return { ok: false, message: `验证服务返回非 JSON（HTTP ${status}）：${text.slice(0, 80)}` };
  log.debug(`verify_user_info 回执 HTTP ${status}：${text.slice(0, 240)}`);
  if (upstreamFailed(json)) return { ok: false, message: upstreamErrorText(json, text) };

  /**
   * 上游对**找不到事件数据**的回执仍是 `status:1, error_code:0`
   * （实测 {"data":{"msg":"no find ev_data"},...}）。参考实现只看 status，
   * 会把它当成功 —— 这里补一条窄判定，避免把过期事件谎报成「验证通过」。
   */
  const dataObj = json.data && typeof json.data === 'object' ? (json.data as Record<string, unknown>) : null;
  const dataMsg = dataObj ? String(dataObj.msg ?? '') : '';
  if (/no\s*find/i.test(dataMsg)) {
    return { ok: false, message: `上游未找到该验证事件（${dataMsg}），请重新解析一次曲目` };
  }
  return { ok: true, message: '验证通过' };
}

// ---------- 验证票据（token） ----------

function tokenSign(expiresAt: number): string {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`kugou-verify:${expiresAt}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * 签发短期票据。三个验证接口允许**匿名**携带它访问（验证要在系统浏览器里完成，
 * 那里没有 Bearer 令牌），所以票据本身就是凭据，必须短期且可验证。
 */
export function signKugouVerifyToken(ttlMs: number = KUGOU_VERIFY_TOKEN_TTL_MS): string {
  const expiresAt = Date.now() + Math.max(60_000, ttlMs);
  return `${expiresAt}.${tokenSign(expiresAt)}`;
}

export function verifyKugouVerifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const expiresAt = Number(token.slice(0, dot));
  const provided = token.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  const expected = tokenSign(expiresAt);
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

/** 前端验证页地址（相对路径，移动端直接丢给系统浏览器） */
export function buildKugouVerifyUrl(token: string): string {
  return `/verify/kugou?t=${encodeURIComponent(token)}`;
}
