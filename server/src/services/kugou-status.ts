/**
 * 酷狗概念版「登录态」统一判定。
 *
 * 面板只显示一个状态，但底层其实是**两件独立的事**：
 *   ① 凭据是否还能用（token 被拒 = 20018/35005 → 失效）；
 *   ② 账号会员是否还在期（到期后 VIP 曲取流拿不到 url，只能 128）。
 * 因此这里把两者合成四种状态，客户端不需要各自拼逻辑：
 *
 *   logged_out   未登录（没有凭据）
 *   invalid      已失效（有凭据但被上游拒绝，需重新授权）
 *   vip_expired  已登录 · 会员已到期（能播免费/低音质，VIP 曲降级）
 *   ok           已登录 · 会员有效
 */

import crypto from 'node:crypto';
import { createLogger } from '../logger.ts';
import { getSetting } from '../db/repo/settings.ts';

const log = createLogger('kugou:status');

const SALT = 'OIlwieks28dk2k092lksi2UIkp';
const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';

export type KugouState = 'logged_out' | 'invalid' | 'vip_expired' | 'ok';

export interface KugouLoginState {
  state: KugouState;
  /** 面板直接可显示的中文（客户端不再自己拼文案，避免两端不一致） */
  label: string;
  userid: string;
  nickname: string;
  /** 会员到期时间（上游原样字符串，可能为空） */
  vipEndTime: string;
  /** 距离到期的毫秒（无法判定为 null） */
  vipRemainingMs: number | null;
  savedAt: number;
  invalidReason: string;
}

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

/** 酷狗时间串是北京时间（UTC+8） */
function parseKugouTime(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 8, Number(m[5]), Number(m[6]));
}

async function queryVip(
  token: string,
  userid: string
): Promise<{ ok: boolean; isVip: boolean; endTime: string; remainingMs: number | null; rejected: boolean }> {
  const guid = md5('suenmusic-kugou-device-v1');
  const mid = BigInt('0x' + md5(guid)).toString();
  const base: Record<string, string> = {
    dfid: '-', mid, uuid: guid, appid: '1005', clientver: '20489',
    clienttime: String(Math.floor(Date.now() / 1000)), token, userid, busi_type: 'concept',
  };
  const sorted = Object.keys(base).sort().map(k => `${k}=${base[k]}`).join('');
  const signature = md5(`${SALT}${sorted}${SALT}`);
  const res = await fetch(
    `https://kugouvip.kugou.com/v1/get_union_vip?${new URLSearchParams({ ...base, signature })}`,
    { headers: { 'User-Agent': UA, Cookie: `token=${token}; userid=${userid};` }, signal: AbortSignal.timeout(8_000) }
  );
  const j: any = await res.json();
  if (j?.status !== 1) {
    // 20018 / 35005 都意味着 token 不被认可 → 归到「失效」，不是「没会员」
    const rejected = Number(j?.error_code ?? 0) === 20018 || Number(j?.error_code ?? 0) === 35005;
    return { ok: false, isVip: false, endTime: '', remainingMs: null, rejected };
  }
  const row = (j?.data?.busi_vip ?? []).find((b: any) => b?.busi_type === 'concept') ?? (j?.data?.busi_vip ?? [])[0] ?? {};
  const endTime = String(row.vip_end_time ?? '');
  const endMs = parseKugouTime(endTime);
  const remainingMs = endMs === null ? null : endMs - Date.now();
  const isVip = Number(row.is_vip ?? 0) === 1 && (remainingMs === null || remainingMs > 0);
  return { ok: true, isVip, endTime, remainingMs, rejected: false };
}

export async function readKugouLoginState(): Promise<KugouLoginState> {
  const raw = getSetting('kugou.credentials');
  const invalidRaw = getSetting('kugou.credentialsInvalidAt');
  let invalidReason = '';
  if (invalidRaw) {
    try {
      invalidReason = String((JSON.parse(invalidRaw) as { reason?: string }).reason ?? '');
    } catch {
      invalidReason = '';
    }
  }

  if (!raw) {
    return { state: 'logged_out', label: '未登录', userid: '', nickname: '', vipEndTime: '', vipRemainingMs: null, savedAt: 0, invalidReason: '' };
  }

  let c: { token?: string; userid?: string; nickname?: string; savedAt?: number } = {};
  try {
    c = JSON.parse(raw);
  } catch {
    return { state: 'logged_out', label: '未登录', userid: '', nickname: '', vipEndTime: '', vipRemainingMs: null, savedAt: 0, invalidReason: '' };
  }
  const token = String(c.token ?? '');
  const userid = String(c.userid ?? '');
  const nickname = String(c.nickname ?? '');
  const savedAt = Number(c.savedAt ?? 0);

  // 已被取流打标失效 → 直接报失效，不必再打上游
  if (invalidReason) {
    return { state: 'invalid', label: '登录已失效，请重新授权', userid, nickname, vipEndTime: '', vipRemainingMs: null, savedAt, invalidReason };
  }

  try {
    const vip = await queryVip(token, userid);
    if (vip.rejected) {
      return { state: 'invalid', label: '登录已失效，请重新授权', userid, nickname, vipEndTime: '', vipRemainingMs: null, savedAt, invalidReason: 'token 被上游拒绝' };
    }
    if (!vip.ok) {
      // 网络抖动等：不改状态，按已登录展示
      return { state: 'ok', label: '已登录', userid, nickname, vipEndTime: '', vipRemainingMs: null, savedAt, invalidReason: '' };
    }
    if (!vip.isVip) {
      const suffix = vip.endTime ? `（${vip.endTime.slice(5, 16)} 到期）` : '';
      return { state: 'vip_expired', label: `已登录 · 会员已到期${suffix}`, userid, nickname, vipEndTime: vip.endTime, vipRemainingMs: vip.remainingMs, savedAt, invalidReason: '' };
    }
    log.debug(`酷狗登录态：会员有效至 ${vip.endTime}`);
    return { state: 'ok', label: '已登录 · 会员有效', userid, nickname, vipEndTime: vip.endTime, vipRemainingMs: vip.remainingMs, savedAt, invalidReason: '' };
  } catch (err) {
    return { state: 'ok', label: '已登录', userid, nickname, vipEndTime: '', vipRemainingMs: null, savedAt, invalidReason: (err as Error).message };
  }
}
