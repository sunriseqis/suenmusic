/**
 * 酷狗扫码登录（管理员用）。
 *
 * 流程：start → 生成 qrcode key + PNG → 管理页展示 → 用户用**概念版 App** 扫码确认
 *      → poll 返回 status=4 → 落 token/userid 到 sources/credentials 通道（kugou 专用键）。
 *
 * 两个签名体系（实测）：
 *   · 拿 key / 轮询 = web 盐（NVPh…）+ appid 1001/3116（encryptType=web）；
 *   · 之后取流 = 概念版盐（LnT6…）+ appid 3116 / clientver 11440。
 * 二维码里编的是 h5 登录页 URL（qrcode=key），App 扫码后走它自己的授权域。
 */

import crypto from 'node:crypto';
import { createLogger } from '../logger.ts';
import { setSetting, getSetting, deleteSetting } from '../db/repo/settings.ts';

const log = createLogger('kugou-login');

const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const DEFAULT_GUID = crypto.createHash('md5').update('suenmusic-kugou-device-v1').digest('hex');
const DEFAULT_MID = BigInt('0x' + crypto.createHash('md5').update(DEFAULT_GUID).digest('hex')).toString();
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

const PUBLIC_KEY_RSA_LITE = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB
-----END PUBLIC KEY-----`;

export interface KugouDevice {
  guid: string;
  mid: string;
  dfid: string;
}

let cachedDfid: string | null = null;

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

function aesEncrypt(data: unknown): { str: string; key: string } {
  const randomStr = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const key = md5(randomStr).slice(0, 16);
  const iv = key.slice(0, 16);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const str = cipher.update(JSON.stringify(data), 'utf8', 'hex') + cipher.final('hex');
  return { str, key };
}

function aesDecrypt(hexStr: string, key: string): any {
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const plain = decipher.update(hexStr, 'hex', 'utf8') + decipher.final('utf8');
  return JSON.parse(plain);
}

function rsaEncryptLite(data: unknown): string {
  const buf = Buffer.from(JSON.stringify(data), 'utf8');
  if (buf.length > 128) throw new Error('RSA payload 超过 128 字节');
  const padded = Buffer.concat([buf, Buffer.alloc(128 - buf.length)]);
  return crypto
    .publicEncrypt({ key: PUBLIC_KEY_RSA_LITE, padding: crypto.constants.RSA_NO_PADDING }, padded)
    .toString('hex');
}

/**
 * 读取当前酷狗概念版设备指纹（guid / 十进制 mid / dfid）。
 * 若凭据里已绑定 mid/dfid 则优先沿用，保证扫码、验权、取流全程使用同一设备指纹。
 */
export function getKugouDevice(): KugouDevice {
  const raw = getSetting('kugou.credentials');
  if (raw) {
    try {
      const c = JSON.parse(raw) as { guid?: string; mid?: string; dfid?: string };
      const g = c.guid || DEFAULT_GUID;
      const m = c.mid || BigInt('0x' + md5(g)).toString();
      const d =
        c.dfid && c.dfid !== '-'
          ? c.dfid
          : (cachedDfid && cachedDfid !== '-' ? cachedDfid : getSetting('kugou.dfid')) || '-';
      return { guid: g, mid: m, dfid: d };
    } catch {
      // ignore
    }
  }
  const savedDfid = (cachedDfid && cachedDfid !== '-' ? cachedDfid : getSetting('kugou.dfid')) || '-';
  return { guid: DEFAULT_GUID, mid: DEFAULT_MID, dfid: savedDfid };
}

export async function ensureDfid(): Promise<string> {
  const dev = getKugouDevice();
  if (dev.dfid && dev.dfid !== '-') {
    cachedDfid = dev.dfid;
    return dev.dfid;
  }
  const { mid } = dev;
  try {
    const aes = aesEncrypt({ mid, uuid: '', appid: '1014', userid: '0' });
    const p = rsaEncryptLite({ aes: aes.key, uid: '0', token: '' });
    const queryParams: Record<string, string> = {
      part: '1',
      platid: '4',
      p,
    };
    const values = Object.keys(queryParams)
      .map(k => queryParams[k])
      .sort()
      .join('');
    queryParams.signature = md5('1014' + values + '1014');

    const res = await fetch(
      `https://userservice.kugou.com/risk/v3/r_register_dev?${new URLSearchParams(queryParams)}`,
      {
        method: 'POST',
        headers: { 'User-Agent': UA_WEB, 'Content-Type': 'text/plain' },
        body: aes.str,
        signal: AbortSignal.timeout(10_000),
      },
    );
    const buf = Buffer.from(await res.arrayBuffer());
    let dfid = '';
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      dfid = String(parsed?.data?.dfid ?? '');
    } catch {
      const decrypted = aesDecrypt(buf.toString('hex'), aes.key);
      dfid = String(decrypted?.data?.dfid ?? '');
    }
    if (dfid && dfid !== '-') {
      cachedDfid = dfid;
      setSetting('kugou.dfid', dfid);
      log.info(`酷狗设备注册成功 dfid=${dfid.slice(0, 8)}…`);
      return dfid;
    }
    log.warn(`酷狗设备注册未返回有效 dfid`);
  } catch (e) {
    log.warn(`酷狗设备注册失败：${(e as Error).message}`);
  }
  cachedDfid = '-';
  return cachedDfid;
}

/** 公共参数（轮询/拿 key 都要带；统一使用十进制 mid） */
function commonParams(dfid: string): Record<string, string> {
  const { guid, mid } = getKugouDevice();
  return {
    mid, dfid, uuid: guid,
    clienttime: String(Math.floor(Date.now() / 1000)), clientver: '11440',
  };
}

/** 酷狗内部标识头（request.js:101 注入的那四件套） */
function kgHeaders(dfid: string): Record<string, string> {
  const { mid } = getKugouDevice();
  return {
    'User-Agent': UA_WEB, Referer: 'https://h5.kugou.com/',
    dfid, mid, clienttime: String(Math.floor(Date.now() / 1000)),
    'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
  };
}

export interface KugouQrSession {
  key: string;
  /** dataURL（image/png），管理页 <img> 直接用 */
  pngBase64: string;
  createdAt: number;
  expiresAt: number;
}

let current: KugouQrSession | null = null;

function signedWeb(p: Record<string, string>): URLSearchParams {
  const sig = md5(WEB_SALT + Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('') + WEB_SALT);
  return new URLSearchParams({ ...p, signature: sig });
}

/** 生成新的扫码会话（旧的作废） */
export async function startKugouQrLogin(): Promise<KugouQrSession> {
  const dfid = await ensureDfid();
  const params = {
    appid: '1001',
    type: '1',
    plat: '4',
    qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=3116&',
    srcappid: '2919',
    ...commonParams(dfid),
  };
  const res = await fetch(`https://login-user.kugou.com/v2/qrcode?${signedWeb(params)}`, {
    headers: kgHeaders(dfid),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await res.json();
  const key = j?.data?.qrcode;
  if (j?.status !== 1 || !key) throw new Error(`拿 qrcode key 失败：${JSON.stringify(j).slice(0, 200)}`);

  const loginUrl = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`;
  const QRCode = (await import('qrcode')).default;
  const pngBase64 = await QRCode.toDataURL(loginUrl, { width: 420, margin: 2 });

  current = { key, pngBase64, createdAt: Date.now(), expiresAt: Date.now() + 3 * 60_000 };
  log.info(`酷狗扫码会话已生成（key=${key.slice(0, 8)}…，3 分钟有效）`);
  return current;
}

export interface KugouPollResult {
  status: 'waiting' | 'confirmed' | 'expired';
  token?: string;
  userid?: string;
}

/** 轮询扫码状态；status=4 时把凭据写进 settings（kugou 专用键） */
export async function pollKugouQrLogin(): Promise<KugouPollResult> {
  const sess = current;
  if (!sess) {
    const st = readKugouCredentialStatus();
    return st.present ? { status: 'confirmed' } : { status: 'expired' };
  }
  if (Date.now() > sess.expiresAt) return { status: 'expired' };

  const dfid = await ensureDfid();
  const devInfo = getKugouDevice();
  const params: Record<string, string> = {
    plat: '4', appid: '3116', srcappid: '2919', qrcode: sess.key, dev: devInfo.guid,
    ...commonParams(dfid),
  };
  const res = await fetch(`https://login-user.kugou.com/v2/get_userinfo_qrcode?${signedWeb(params)}`, {
    headers: kgHeaders(dfid),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await res.json();
  const st = Number(j?.data?.status ?? -1);

  if (st === 4) {
    const d = (j?.data ?? {}) as Record<string, unknown>;
    const token = String(d.token ?? '');
    const userid = String(d.userid ?? '');
    if (!token || !userid) throw new Error(`登录成功但凭据缺失：${JSON.stringify(d).slice(0, 200)}`);

    const creds = {
      token,
      userid,
      nickname: String(d.nickname ?? ''),
      vipToken: String(d.vip_token ?? d.viptoken ?? ''),
      vipType: String(d.vip_type ?? ''),
      t1: String(d.t1 ?? ''),
      guid: devInfo.guid,
      mid: devInfo.mid,
      dfid,
      savedAt: Date.now(),
    };
    setSetting('kugou.credentials', JSON.stringify(creds));
    deleteSetting('kugou.credentialsInvalidAt');
    current = null;
    log.info(`酷狗登录凭据已保存（userid=${userid} mid=${devInfo.mid.slice(0, 8)}…）`);
    return { status: 'confirmed', token, userid };
  }
  if (st === 0) return { status: 'expired' };
  return { status: 'waiting' };
}

/** 管理页查询当前凭据状态 */
export function readKugouCredentialStatus(): {
  present: boolean;
  savedAt?: number;
  userid?: string;
  /** token 失效时间（非空 = 需要重新扫码授权） */
  invalidAt?: number;
  invalidReason?: string;
} {
  const raw = getSetting('kugou.credentials');
  if (!raw) return { present: false };
  const invalidRaw = getSetting('kugou.credentialsInvalidAt');
  let invalidAt = 0;
  let invalidReason = '';
  if (invalidRaw) {
    try {
      const inv = JSON.parse(invalidRaw) as { at?: number; reason?: string };
      invalidAt = Number(inv.at ?? 0);
      invalidReason = String(inv.reason ?? '');
    } catch {
      invalidAt = 0;
    }
  }
  try {
    const p = JSON.parse(raw) as { token: string; userid: string; savedAt: number };
    return { present: true, savedAt: p.savedAt, userid: p.userid, invalidAt, invalidReason };
  } catch {
    return { present: false };
  }
}

/** token 失效打标（取流遇 35005/20018 时调用），让 Web 面板明确提示「需重新授权」 */
export function markKugouCredentialInvalid(reason: string): void {
  setSetting('kugou.credentialsInvalidAt', JSON.stringify({ at: Date.now(), reason }));
  log.warn(`酷狗凭据标记失效：${reason}`);
}
