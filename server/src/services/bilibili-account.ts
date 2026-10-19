/**
 * B 站账号（服务端持有的凭证）。
 *
 * ## 定位
 *
 * 这不是"本站用户体系"的一部分。B 站音源由服务端代理取流（浏览器发不出 Referer，
 * 见 sources/bilibili/stream.ts），所以整台服务只有**一个**出网身份 ——
 * 加了 B 站账号，受益的是所有本站用户，退出也是全员退出。
 * 凭证落在 `app_settings` 表，进程重启后仍在。
 *
 * ## 为什么要有它
 *
 * 不带 Cookie 时 B 站搜索随时可能触发 -412 风控，且只能拿到最低码率。
 * 登录后风控概率显著下降，取流也能拿到更高码率的音频。
 *
 * ## 与旧的环境变量是什么关系
 *
 * `SUENMUSIC_BILIBILI_COOKIE` 仍然有效，且是**兜底**：
 * 数据库里有就用数据库的，没有才回落到环境变量。
 * 退出登录 = 删掉数据库里那份，回落到环境变量 —— 而不是把 Cookie 变成空，
 * 否则一个由环境变量配置好的部署会被一次误点"退出"永久清空。
 */

import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import { deleteSetting, getSetting, setSetting } from '../db/repo/settings.ts';
import { request } from '../utils/http.ts';
import { BROWSER_UA } from '../utils/constants.ts';
import { qrSvgDataUrl } from '../utils/qr.ts';

const log = createLogger('bilibili:account');

/** 设置项键名。集中在此，避免字面量散落各处拼错 */
const KEY_COOKIE = 'bilibili.cookie';
const KEY_ACCOUNT = 'bilibili.account';

const PASSPORT = 'https://passport.bilibili.com';
const API = 'https://api.bilibili.com';

const BILI_REFERER = 'https://www.bilibili.com';

/**
 * 进程启动时环境变量里的值。
 * 退出登录要回落到它，所以必须在**被数据库覆盖之前**先记下来。
 */
const envFallbackCookie = config.bilibiliCookie;

export interface BilibiliAccount {
  mid: number;
  name: string;
  face: string;
  /** 大会员状态。取不到就为 false，不要猜 */
  vip: boolean;
  loggedInAt: number;
}

export type CookieSource = 'database' | 'env' | 'none';

export interface BilibiliStatus {
  /** 是否有一份看起来可用的凭证 */
  configured: boolean;
  source: CookieSource;
  account: BilibiliAccount | null;
  /** 凭证里有没有 SESSDATA —— 缺它等于没登录，这是唯一必须的字段 */
  hasSessdata: boolean;
  /** 是否可用界面上的"退出登录"（环境变量兜底的那份不可从界面删除） */
  canLogout: boolean;
}

function biliHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Referer: BILI_REFERER,
    Origin: BILI_REFERER,
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function hasSessdata(cookie: string): boolean {
  return /(^|;\s*)SESSDATA=/.test(cookie);
}

// ---------------------------------------------------------------------------
// 启动加载
// ---------------------------------------------------------------------------

/**
 * 用数据库里的凭证覆盖配置。应在迁移之后、开始服务之前调用一次。
 *
 * 覆盖的是 `config.bilibiliCookie` 本身而不是另起一个变量：
 * 取流与搜索是热路径，每次都去查一次库不划算，而 `config` 是请求期读的，
 * 改它即可全链路立即生效。
 */
export function loadBilibiliCookieFromDb(): void {
  const fromDb = getSetting(KEY_COOKIE);
  if (!fromDb) {
    log.debug(
      envFallbackCookie
        ? 'B 站凭证来源：环境变量'
        : 'B 站未登录（未配置 Cookie，风控概率与音质都会受限）'
    );
    return;
  }
  config.bilibiliCookie = fromDb;
  const account = readStoredAccount();
  log.info(`B 站凭证已从数据库加载${account ? `：${account.name}` : ''}`);
}

function readStoredAccount(): BilibiliAccount | null {
  const raw = getSetting(KEY_ACCOUNT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BilibiliAccount;
    return typeof parsed?.mid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function getBilibiliStatus(): BilibiliStatus {
  const fromDb = getSetting(KEY_COOKIE);
  const cookie = config.bilibiliCookie;

  return {
    configured: Boolean(cookie) && hasSessdata(cookie),
    source: fromDb ? 'database' : cookie ? 'env' : 'none',
    account: fromDb ? readStoredAccount() : null,
    hasSessdata: hasSessdata(cookie),
    canLogout: Boolean(fromDb),
  };
}

// ---------------------------------------------------------------------------
// 上游调用
// ---------------------------------------------------------------------------

interface BiliEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

/** 从 Set-Cookie 头里拼出一个 Cookie 请求头 */
function cookieHeaderFromSetCookie(headers: Headers): string {
  // Node 20+ 才有 getSetCookie()：单个 set-cookie 头会被合并成一行，
  // 那样切不出多个 Cookie，所以不能只靠 get('set-cookie')
  const list =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''].filter(Boolean);

  const pairs: string[] = [];
  for (const raw of list) {
    // "SESSDATA=xxx; Path=/; Domain=.bilibili.com; ..." 只取第一段
    const first = raw.split(';')[0]?.trim();
    if (!first || !first.includes('=')) continue;
    const name = first.slice(0, first.indexOf('='));
    if (!name) continue;
    pairs.push(first);
  }
  return pairs.join('; ');
}

async function fetchNav(cookie: string): Promise<BilibiliAccount | null> {
  const res = await request(`${API}/x/web-interface/nav`, {
    headers: biliHeaders(cookie),
    timeoutMs: 8_000,
  });
  const body = (await res.json().catch(() => null)) as
    | BiliEnvelope<{ isLogin?: boolean; mid?: number; uname?: string; face?: string; vipStatus?: number; vip_status?: number }>
    | null;

  const data = body?.data;
  if (!body || body.code !== 0 || !data?.isLogin) return null;

  return {
    mid: Number(data.mid ?? 0),
    name: String(data.uname ?? ''),
    face: String(data.face ?? ''),
    vip: Number(data.vipStatus ?? data.vip_status ?? 0) === 1,
    loggedInAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------

export interface QrLoginSession {
  qrcodeKey: string;
  /** B 站登录页地址。二维码画不出来时前端仍可给一个入口 */
  url: string;
  /** `data:image/svg+xml;base64,...`；编码超长时为 null */
  qrImage: string | null;
}

export async function startQrLogin(): Promise<QrLoginSession> {
  const res = await request(`${PASSPORT}/x/passport-login/web/qrcode/generate`, {
    headers: biliHeaders(),
    timeoutMs: 8_000,
  });
  const body = (await res.json().catch(() => null)) as
    | BiliEnvelope<{ url?: string; qrcode_key?: string }>
    | null;

  const url = body?.data?.url ?? '';
  const qrcodeKey = body?.data?.qrcode_key ?? '';
  if (!body || body.code !== 0 || !url || !qrcodeKey) {
    throw new Error(`B 站未返回二维码（code=${body?.code ?? '?'} ${body?.message ?? ''}）`);
  }

  return { qrcodeKey, url, qrImage: qrSvgDataUrl(url) };
}

/**
 * B 站扫码状态码。
 * 0 = 成功，86038 = 二维码已失效，86090 = 已扫码待确认，86101 = 尚未扫码。
 */
const QR_CODE_EXPIRED = 86038;
const QR_CODE_SCANNED = 86090;

export type QrLoginState = 'pending' | 'scanned' | 'confirmed' | 'expired' | 'failed';

export interface QrLoginPoll {
  state: QrLoginState;
  account?: BilibiliAccount;
  message: string;
}

export async function pollQrLogin(qrcodeKey: string): Promise<QrLoginPoll> {
  const res = await request(
    `${PASSPORT}/x/passport-login/web/qrcode/poll`,
    {
      headers: biliHeaders(),
      query: { qrcode_key: qrcodeKey },
      timeoutMs: 8_000,
    }
  );
  const body = (await res.json().catch(() => null)) as
    | BiliEnvelope<{ code?: number; message?: string }>
    | null;

  if (!body || body.code !== 0) {
    return { state: 'failed', message: body?.message || 'B 站未返回扫码结果' };
  }

  const stateCode = Number(body.data?.code ?? -1);
  if (stateCode === QR_CODE_EXPIRED) {
    return { state: 'expired', message: '二维码已失效，请重新获取' };
  }
  if (stateCode === QR_CODE_SCANNED) {
    return { state: 'scanned', message: '已扫码，请在手机上确认登录' };
  }
  if (stateCode !== 0) {
    return { state: 'pending', message: '等待扫码' };
  }

  // ---- 扫码成功：Set-Cookie 就在这一次响应上 ----
  const cookie = cookieHeaderFromSetCookie(res.headers);
  if (!hasSessdata(cookie)) {
    return {
      state: 'failed',
      message: 'B 站确认了登录，但没有下发 SESSDATA，无法保存凭证',
    };
  }

  const account = await fetchNav(cookie);
  if (!account) {
    return { state: 'failed', message: '拿到凭证但校验失败，请重试' };
  }

  config.bilibiliCookie = cookie;
  setSetting(KEY_COOKIE, cookie);
  setSetting(KEY_ACCOUNT, JSON.stringify(account));
  log.info(`B 站账号已登录：${account.name}（mid=${account.mid}）`);

  return { state: 'confirmed', account, message: `已登录：${account.name}` };
}

/**
 * 退出 B 站登录，回落到环境变量里那份（如果有）。
 *
 * 返回值表示回落之后还剩不剩凭证 —— 界面据此决定"是否真的退出成功"。
 */
export function logoutBilibili(): { revertedToEnv: boolean } {
  deleteSetting(KEY_COOKIE);
  deleteSetting(KEY_ACCOUNT);

  config.bilibiliCookie = envFallbackCookie;
  const revertedToEnv = Boolean(envFallbackCookie) && hasSessdata(envFallbackCookie);

  log.info(revertedToEnv ? 'B 站账号已退出，回落到环境变量凭证' : 'B 站账号已退出');
  return { revertedToEnv };
}
