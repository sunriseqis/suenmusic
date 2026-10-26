/**
 * 酷狗概念版会员状态（只读查询）。
 *
 * 为什么单独一个模块：**会员到期会直接影响能不能播**（VIP 曲掉会员后取流拿不到 url），
 * 所以必须能被 Web 面板和管理端看到，而不是等用户点播失败才发现。
 *
 * 协议：GET https://kugouvip.kugou.com/v1/get_union_vip?busi_type=concept（android 签名 + cookie）。
 * 返回 busi_vip[] 里 busi_type=concept 那条的 is_vip / vip_begin_time / vip_end_time。
 */

import crypto from 'node:crypto';
import { createLogger } from '../logger.ts';
import { getSetting } from '../db/repo/settings.ts';

const log = createLogger('kugou:vip');

const SALT = 'OIlwieks28dk2k092lksi2UIkp';
const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

export interface KugouVipStatus {
  /** 是否有概念版会员 */
  isVip: boolean;
  /** 到期时间（本地时间字符串，原样来自上游） */
  endTime: string;
  /** 距离到期的毫秒数（无法解析为 null） */
  remainingMs: number | null;
  /** 查询是否成功（false = 没有凭据或上游失败，此时 isVip 无意义） */
  ok: boolean;
  message?: string;
}

/** 解析 "2026-10-27 14:53:01"（酷狗按东八区本地时间给） */
function parseKugouTime(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  // 酷狗时间字符串是北京时间（UTC+8）
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 8, Number(m[5]), Number(m[6]));
}

export async function readKugouVipStatus(): Promise<KugouVipStatus> {
  const raw = getSetting('kugou.credentials');
  if (!raw) return { isVip: false, endTime: '', remainingMs: null, ok: false, message: '未授权酷狗' };
  const c = JSON.parse(raw) as { token?: string; userid?: string };
  if (!c.token || !c.userid) return { isVip: false, endTime: '', remainingMs: null, ok: false, message: '凭据不完整' };

  const guid = md5('suenmusic-kugou-device-v1');
  const mid = BigInt('0x' + md5(guid)).toString();
  const base: Record<string, string> = {
    dfid: '-', mid, uuid: guid, appid: '1005', clientver: '20489',
    clienttime: String(Math.floor(Date.now() / 1000)), token: c.token, userid: c.userid,
    busi_type: 'concept',
  };
  const sorted = Object.keys(base).sort().map(k => `${k}=${base[k]}`).join('');
  const signature = md5(`${SALT}${sorted}${SALT}`);

  try {
    const res = await fetch(`https://kugouvip.kugou.com/v1/get_union_vip?${new URLSearchParams({ ...base, signature })}`, {
      headers: { 'User-Agent': UA, Cookie: `token=${c.token}; userid=${c.userid};` },
      signal: AbortSignal.timeout(8_000),
    });
    const j: any = await res.json();
    if (j?.status !== 1) {
      return { isVip: false, endTime: '', remainingMs: null, ok: false, message: `查询失败 status=${j?.status} ec=${j?.error_code ?? '-'}` };
    }
    const row = (j?.data?.busi_vip ?? []).find((b: any) => b?.busi_type === 'concept') ?? (j?.data?.busi_vip ?? [])[0] ?? {};
    const endTime = String(row.vip_end_time ?? '');
    const endMs = parseKugouTime(endTime);
    const remainingMs = endMs === null ? null : endMs - Date.now();
    const isVip = Number(row.is_vip ?? 0) === 1 && (remainingMs === null || remainingMs > 0);
    if (!isVip) log.warn(`酷狗会员已过期或未生效（end=${endTime || '无'}）→ VIP 音质不可用`);
    return { isVip, endTime, remainingMs, ok: true };
  } catch (err) {
    return { isVip: false, endTime: '', remainingMs: null, ok: false, message: (err as Error).message };
  }
}
