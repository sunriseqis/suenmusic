/**
 * 酷狗扫码登录（管理员用）。
 *
 * 流程：start → 生成 qrcode key + PNG → 管理页展示 → 用户用**概念版 App** 扫码确认
 *      → poll 返回 status=4 → 落 token/userid 到 sources/credentials 通道（kugou 专用键）。
 *
 * 两个签名体系（实测）：
 *   · 拿 key / 轮询 = web 盐（NVPh…）+ appid 1014（encryptType=web）；
 *   · 之后取流 = 概念版盐（LnT6…）+ appid 3116 / clientver 11440。
 * 二维码里编的是 h5 登录页 URL（qrcode=key），App 扫码后走它自己的授权域。
 */

import crypto from 'node:crypto';
import { createLogger } from '../logger.ts';
import { setSetting, getSetting } from '../db/repo/settings.ts';

const log = createLogger('kugou-login');

const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const guid = crypto.createHash('md5').update('suenmusic-kugou-device-v1').digest('hex');
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
/**
 * 注册过的 dfid（2026-10-26 实测：**必须先 /risk/v3/r_register_dev 注册设备**，
 * 否则 login-user 的两个接口全部 `20010`；注册后拿 key ✅、轮询 ✅）。
 * 进程内缓存；重启后重注册一次（接口幂等，返回同 guid 的新 dfid 也没关系）。
 */
let cachedDfid: string | null = null;

async function ensureDfid(): Promise<string> {
  if (cachedDfid) return cachedDfid;
  const registerSalt = '1014';
  const inner = {
    appid: '3116', clientver: '11440', mid: guid, guid,
    device_id: guid, mac: guid, os: '13', osver: '13.0.0',
    model: '2210132C',Density: '440',resolution: '2400x1080',
    remove_last_cookie: '1', MANUFACTURER: 'Xiaomi',
  };
  const values = Object.keys(inner).map(k => String((inner as any)[k])).sort().join('');
  const params: Record<string, string> = {
    ...inner,
    signature: md5('1014' + values + '1014'),
  };
  // register_dev 走 POST + AES/RSA 加密体，直接用 KuGouMusicApi 的本地服务最省事 —— 
  // 但为了不引入外部进程依赖，这里走**公开注册参数的等价 HTTP**（实测 20010 修复的真正前提是 dfid 有效，
  // 因此失败时降级用 '-' 并明确告警）。
  try {
    const res = await fetch('https://userservice.kugou.com/risk/v3/r_register_dev', {
      method: 'POST',
      headers: { 'User-Agent': UA_WEB, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await res.json();
    const dfid = String(j?.data?.dfid ?? '');
    if (dfid) {
      cachedDfid = dfid;
      log.info(`酷狗设备注册成功 dfid=${dfid.slice(0, 8)}…`);
      return dfid;
    }
    // 注册失败不阻塞扫码登录（实测 2026-10-26：注册 20006 时扫码仍成功）。
    // '-' 只是轮询可能拿不到状态，登录成功与否取决于 App 侧确认。
    log.warn(`酷狗设备注册未返回 dfid（${JSON.stringify(j).slice(0, 120)}）——扫码流程继续，轮询可能受限`);
  } catch (e) {
    log.warn(`酷狗设备注册失败：${(e as Error).message}`);
  }
  cachedDfid = '-';
  return cachedDfid;
}

/** 公共参数（轮询/拿 key 都要带；2026-10-26 实测缺任何一个 → 20010） */
function commonParams(dfid: string): Record<string, string> {
  return {
    mid: guid, dfid, uuid: guid,
    clienttime: String(Math.floor(Date.now() / 1000)), clientver: '11440',
  };
}

/** 酷狗内部标识头（request.js:101 注入的那四件套） */
function kgHeaders(dfid: string): Record<string, string> {
  return {
    'User-Agent': UA_WEB, Referer: 'https://h5.kugou.com/',
    dfid, mid: guid, clienttime: String(Math.floor(Date.now() / 1000)),
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

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

function signedWeb(p: Record<string, string>): URLSearchParams {
  const sig = md5(WEB_SALT + Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('') + WEB_SALT);
  return new URLSearchParams({ ...p, signature: sig });
}

/** 生成新的扫码会话（旧的作废） */
export async function startKugouQrLogin(): Promise<KugouQrSession> {
  const dfid = await ensureDfid();
  const params = {
    appid: '1014',
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
  // 会话已确认清空（或服务重启）时**优雅返回**：凭据已在库 → confirmed；否则 expired。
  // 之前直接 throw → 前端在「确认成功后最后一轮轮询」会收到 500（用户看到「服务端内部错误」，
  // 而实际登录是成功的——凭据已落库，2026-10-26 实测 userid=2302235937 就是这么丢的提示）。
  const sess = current;
  if (!sess) {
    const st = readKugouCredentialStatus();
    return st.present ? { status: 'confirmed' } : { status: 'expired' };
  }
  if (Date.now() > sess.expiresAt) return { status: 'expired' };

  const dfid = await ensureDfid();
  // ⚠️ 轮询接口也必须带**全套公共参数** + 酷狗内部头（2026-10-26 实测：只带 plat/appid/srcappid/qrcode/dev
  //    会 `20010`，加上 commonParams + kgHeaders 后 → status=1/data.status=1 正常返回）。
  const params: Record<string, string> = {
    plat: '4', appid: '1014', srcappid: '2919', qrcode: sess.key, dev: guid,
    ...commonParams(dfid),
  };
  const res = await fetch(`https://login-user.kugou.com/v2/get_userinfo_qrcode?${signedWeb(params)}`, {
    headers: kgHeaders(dfid),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await res.json();
  const st = Number(j?.data?.status ?? -1);

  if (st === 4) {
    const token = String(j?.data?.token ?? '');
    const userid = String(j?.data?.userid ?? '');
    if (!token || !userid) throw new Error(`登录成功但凭据缺失：${JSON.stringify(j?.data).slice(0, 200)}`);
    // 凭据只进 settings（管理员通道），不进代码库；与业务用户数据物理隔离
    setSetting('kugou.credentials', JSON.stringify({ token, userid, savedAt: Date.now() }));
    current = null;
    log.info(`酷狗登录凭据已保存（userid=${userid}）`);
    return { status: 'confirmed', token, userid };
  }
  if (st === 0) return { status: 'expired' };
  return { status: 'waiting' };
}

/** 管理页查询当前凭据状态 */
export function readKugouCredentialStatus(): { present: boolean; savedAt?: number; userid?: string } {
  const raw = getSetting('kugou.credentials');
  if (!raw) return { present: false };
  try {
    const p = JSON.parse(raw) as { token: string; userid: string; savedAt: number };
    return { present: true, savedAt: p.savedAt, userid: p.userid };
  } catch {
    return { present: false };
  }
}
