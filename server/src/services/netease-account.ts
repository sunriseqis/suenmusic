/**
 * 网易云账号（服务端持有的凭证）。
 *
 * 与 B 站账号（`bilibili-account.ts`）完全同构：全站共用一个出网身份，
 * 凭证落 `app_settings`，环境变量 `SUENMUSIC_NETEASE_COOKIE` 作兜底，
 * 退出 = 删库里的并回落，不是清空。
 *
 * 登录方式**只有扫码**（2026-09-11 用户拍板）：密码/验证码登录被网易云
 * 反作弊（-462）与账号风险判定（10004）反复拦截，实测走不通，已整体移除。
 *
 * 为什么要有它：
 *   1. 高音质 —— `lossless`/`hires` 档位只对黑胶 VIP 放行，匿名拿不到；
 *   2. 相似歌手 —— `simi_artist` 匿名可用但风控概率高，带 cookie 稳定得多。
 *
 * 红线：本服务不提供 unblock（解锁灰色歌曲）。那是绕过版权保护的功能，
 * vendor 里对应代码已物理剔除。
 */

import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import { deleteSetting, getSetting, setSetting } from '../db/repo/settings.ts';
import { netease, neteaseRequest, bootstrapNeteaseVendor } from '../sources/netease/vendor.ts';
import { qrSvgDataUrl } from '../utils/qr.ts';

const log = createLogger('netease:account');

const KEY_COOKIE = 'netease.cookie';
const KEY_ACCOUNT = 'netease.account';
/**
 * 已废弃的手机号登录遗留键（密码密文 / 手机号）。启动时顺手清掉，
 * 避免库里留着没人用的敏感数据。
 */
const LEGACY_KEYS = ['netease.password_cipher', 'netease.phone'];

/** 进程启动时环境变量里的值（退出登录回落用） */
const envFallbackCookie = config.neteaseCookie;

export interface NeteaseAccount {
  userId: number;
  name: string;
  face: string;
  /**
   * 网易云 VIP 等级。vipType：10 = 普通黑胶，11 = 学生/性情黑胶之类，
   * 0 = 无。决定 lossless/hires 能不能拿到完整 URL。
   */
  vipType: number;
  loggedInAt: number;
}

export type CookieSource = 'database' | 'env' | 'none';

export interface NeteaseStatus {
  configured: boolean;
  source: CookieSource;
  account: NeteaseAccount | null;
  canLogout: boolean;
}

/** 进程启动时调用：迁移之后、开始服务之前 */
export function loadNeteaseCookieFromDb(): void {
  for (const key of LEGACY_KEYS) deleteSetting(key);

  const fromDb = getSetting(KEY_COOKIE);
  if (!fromDb) {
    log.debug(
      envFallbackCookie
        ? '网易云凭证来源：环境变量'
        : '网易云未登录（音源只有 B 站兜底，高音质不可用）'
    );
    return;
  }
  config.neteaseCookie = fromDb;
  const account = readStoredAccount();
  log.info(`网易云凭证已从数据库加载${account ? `：${account.name}` : ''}`);
}

function readStoredAccount(): NeteaseAccount | null {
  const raw = getSetting(KEY_ACCOUNT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NeteaseAccount;
    return typeof parsed?.userId === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function getNeteaseStatus(): NeteaseStatus {
  const fromDb = getSetting(KEY_COOKIE);
  const cookie = config.neteaseCookie;
  return {
    configured: Boolean(cookie),
    source: fromDb ? 'database' : cookie ? 'env' : 'none',
    account: fromDb ? readStoredAccount() : null,
    canLogout: Boolean(fromDb),
  };
}

/** 供 vendor 调用用的 cookie —— 请求期热读，改 config 即全链路生效 */
export function currentNeteaseCookie(): string {
  return config.neteaseCookie;
}

// ---------------------------------------------------------------------------
// 登录身份校验
// ---------------------------------------------------------------------------

interface LoginStatusBody {
  code?: number;
  message?: string;
  data?: {
    account?: { id?: number; vipType?: number; status?: number };
    profile?: { nickname?: string; avatarUrl?: string };
  };
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * 把 vendor 抛出的错误翻译成人话。
 *
 * vendor 请求层被上游拒绝时 **reject 的是响应对象**（{ status, body, cookie }），
 * 不是 Error —— 直接 `${err}` 只会得到 "[object Object]"。
 * 真正的原因在 body.message / body.code / status 里，从这里抠出来。
 */
function describeNeteaseError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as {
      status?: number;
      message?: string;
      body?: { code?: number; message?: string; msg?: string } | unknown;
    };
    const body = e.body as { code?: number; message?: string; msg?: string } | undefined;
    const msg = body?.message || body?.msg || e.message;
    const code = body?.code ?? e.status;
    if (code === -462) {
      return '网易云要求完成安全挑战（-462）：当前网络被风控，请稍后重试或换网络环境';
    }
    if (msg) return `code=${code ?? '?'} ${msg}`;
    if (body && typeof body === 'object') {
      return `code=${code ?? '?'} ${JSON.stringify(body).slice(0, 160)}`;
    }
    if (e.status) return `HTTP ${e.status}`;
  }
  return String(err);
}

/**
 * 最近一次 verifyAccount 拿到的上游 message。
 * 网易云的风控文案（如「当前登录存在安全风险，请稍后再试」）在这里透出，
 * 让上层把"为什么失败"告诉用户，而不是一句笼统的"校验失败"。
 */
let lastVerifyUpstreamMsg = '';

/**
 * 用 cookie 问上游「我是谁」，顺便验证 cookie 是否真的有效。
 *
 * 带重试：扫码确认后的头几秒是网易云风控的高发窗口
 * （「当前登录存在安全风险」等瞬时拒绝），等一两秒再问通常就放行。
 * 全部重试耗尽才返回 null —— 上游原因记在 lastVerifyUpstreamMsg。
 */
async function verifyAccount(cookie: string): Promise<NeteaseAccount | null> {
  lastVerifyUpstreamMsg = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    let body: LoginStatusBody | undefined;
    try {
      const res = await netease.loginStatus({ cookie }, neteaseRequest);
      body = res?.body as unknown as LoginStatusBody;
    } catch (err) {
      // vendor 被上游拒绝时 reject 的是响应对象，这里照样计入重试
      lastVerifyUpstreamMsg = describeNeteaseError(err);
      if (attempt < 3) await sleep(attempt * 1500);
      continue;
    }

    const account = body?.data?.account;
    const profile = body?.data?.profile;

    if (body?.code === 200 && account?.id && profile?.nickname) {
      return {
        userId: Number(account.id),
        name: String(profile.nickname ?? ''),
        face: String(profile.avatarUrl ?? ''),
        vipType: Number(account.vipType ?? 0),
        loggedInAt: Date.now(),
      };
    }

    lastVerifyUpstreamMsg = String(body?.message ?? '').trim();
    if (attempt < 3) await sleep(attempt * 1500);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 扫码登录（唯一登录方式）
// ---------------------------------------------------------------------------

export interface QrLoginSession {
  /** 网易云的 unikey，轮询用 */
  qrcodeKey: string;
  /** 网易云登录页地址，二维码内容就是它 */
  url: string;
  /** `data:image/svg+xml;base64,...`；编码超长时为 null */
  qrImage: string | null;
}

export async function startNeteaseQrLogin(): Promise<QrLoginSession> {
  const res = await netease.loginQrKey({}, neteaseRequest);
  const data = res?.body?.data as { unikey?: string } | undefined;
  const unikey = String(data?.unikey ?? '');
  if (!unikey) {
    throw new Error(`网易云未返回二维码 key（body=${JSON.stringify(res?.body)?.slice(0, 200)}）`);
  }

  const url = `https://music.163.com/login?codekey=${unikey}`;
  return { qrcodeKey: unikey, url, qrImage: qrSvgDataUrlSafe(url) };
}

function qrSvgDataUrlSafe(url: string): string | null {
  try {
    return qrSvgDataUrl(url);
  } catch {
    return null;
  }
}

/**
 * 网易云扫码状态码（与 B 站三套码完全不同）：
 * 800 = 二维码过期，801 = 等待扫码，802 = 已扫码待确认，803 = 授权成功。
 */
const QR_EXPIRED = 800;
const QR_SCANNED = 802;
const QR_CONFIRMED = 803;

export type QrLoginState = 'pending' | 'scanned' | 'confirmed' | 'expired' | 'failed';

export interface QrLoginPoll {
  state: QrLoginState;
  account?: NeteaseAccount;
  message: string;
}

/** 拿到 cookie 但账号信息被风控暂扣时的提示文案 */
const DEFERRED_ACCOUNT_MSG =
  '登录凭证已生效，账号信息被网易云风控暂扣（不影响播放；稍后重新扫码可补全）';

export async function pollNeteaseQrLogin(qrcodeKey: string): Promise<QrLoginPoll> {
  const res = await netease.loginQrCheck({ key: qrcodeKey }, neteaseRequest);
  const body = res?.body as { code?: number; cookie?: string; message?: string };

  const code = Number(body?.code ?? -1);
  if (code === QR_EXPIRED) {
    return { state: 'expired', message: '二维码已失效，请重新获取' };
  }
  if (code === QR_SCANNED) {
    return { state: 'scanned', message: '已扫码，请在手机上确认登录' };
  }
  if (code !== QR_CONFIRMED) {
    return { state: 'pending', message: '等待扫码' };
  }

  // ---- 授权成功：cookie 就在这次响应里 ----
  const cookie = String(body?.cookie ?? '');
  if (!cookie) {
    return { state: 'failed', message: '网易云确认了登录，但没有下发 Cookie，无法保存凭证' };
  }

  const account = await verifyAccount(cookie);
  if (account) {
    config.neteaseCookie = cookie;
    setSetting(KEY_COOKIE, cookie);
    setSetting(KEY_ACCOUNT, JSON.stringify(account));
    log.info(`网易云账号已登录：${account.name}（id=${account.userId}，vipType=${account.vipType}）`);

    return { state: 'confirmed', account, message: `已登录：${account.name}` };
  }

  // 扫码确认后下发的 cookie 是官方签发的，本身有效 —— 身份信息被风控
  // 暂扣只影响设置页的显示，不该连累登录本身。先落库让音源立刻可用。
  config.neteaseCookie = cookie;
  setSetting(KEY_COOKIE, cookie);
  deleteSetting(KEY_ACCOUNT);
  log.warn(`网易云凭证已保存，但身份信息被风控暂扣：${lastVerifyUpstreamMsg}`);
  return { state: 'confirmed', message: DEFERRED_ACCOUNT_MSG };
}

/**
 * 退出网易云登录，回落到环境变量里那份（如果有）。
 * 返回值表示回落之后还剩不剩凭证。
 */
export function logoutNetease(): { revertedToEnv: boolean } {
  deleteSetting(KEY_COOKIE);
  deleteSetting(KEY_ACCOUNT);
  for (const key of LEGACY_KEYS) deleteSetting(key);

  config.neteaseCookie = envFallbackCookie;
  const revertedToEnv = Boolean(envFallbackCookie);

  log.info(revertedToEnv ? '网易云账号已退出，回落到环境变量凭证' : '网易云账号已退出');
  return { revertedToEnv };
}

/** 启动引导（公钥 + 匿名 token）。与凭证加载一样在服务开始前调用一次 */
export async function initNeteaseVendor(): Promise<void> {
  await bootstrapNeteaseVendor();
}
