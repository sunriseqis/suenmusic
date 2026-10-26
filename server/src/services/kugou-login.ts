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
  const params = {
    appid: '1014',
    type: '1',
    plat: '4',
    qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=3116&',
    srcappid: '2919',
    mid: guid,
    dfid: '-',
    uuid: guid,
    clienttime: String(Math.floor(Date.now() / 1000)),
    clientver: '11440',
  };
  const res = await fetch(`https://login-user.kugou.com/v2/qrcode?${signedWeb(params)}`, {
    headers: { 'User-Agent': UA_WEB, Referer: 'https://h5.kugou.com/' },
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
  if (!sess) throw new Error('没有进行中的扫码会话，先调 start');
  if (Date.now() > sess.expiresAt) return { status: 'expired' };

  const q = new URLSearchParams({
    plat: '4', appid: '3116', srcappid: '2919', qrcode: sess.key, dev: guid,
  }).toString();
  const res = await fetch(`https://login-user.kugou.com/v2/get_userinfo_qrcode?${q}`, {
    headers: { 'User-Agent': UA_WEB },
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
