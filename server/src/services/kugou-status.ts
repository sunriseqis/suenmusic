/**
 * 酷狗概念版「登录态 + 会员有效期 + 今日签到状态」统一判定。
 *
 * 面板只显示一个状态，但底层其实是**三件关联的事**：
 *   ① 凭据是否还能用（token 被拒 = 20018/35005 → 失效）；
 *   ② 今日畅听签到 + 概念 SVIP 升级是否已完成（未签到时自动补签并升级 24h SVIP 解锁无损）；
 *   ③ 账号会员是否还在期（到期后 VIP 曲取流拿不到 url，只能免费曲）。
 * 因此这里把三者合成四种状态，客户端不需要各自拼逻辑：
 *
 *   logged_out   未登录（没有凭据）
 *   invalid      已失效（有凭据但被上游拒绝，需重新授权）
 *   vip_expired  已登录 · 会员已到期（能播免费/低音质，VIP 曲降级）
 *   ok           已登录 · 会员有效 · 已签/未签
 */

import crypto from 'node:crypto';
import { createLogger } from '../logger.ts';
import { getSetting } from '../db/repo/settings.ts';
import { getKugouDevice } from './kugou-login.ts';
import { ensureKugouCheckin, readKugouCheckinState, runKugouCheckin } from './kugou-checkin.ts';

const log = createLogger('kugou:status');

const SALT_LITE = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const STATUS_CACHE_TTL_MS = 5 * 60_000;

export type KugouState = 'logged_out' | 'invalid' | 'vip_expired' | 'ok';

export interface KugouLoginState {
  state: KugouState;
  /** 面板直接可显示的中文（客户端不再自己拼文案，避免两端不一致） */
  label: string;
  userid: string;
  nickname: string;
  /** 会员到期时间（上游原样字符串，可能为空） */
  vipEndTime: string;
  /** 会员到期短日期（YY.MM.DD，例如 27.01.28） */
  vipExpireAt: string;
  /** 距离到期的毫秒（无法判定为 null） */
  vipRemainingMs: number | null;
  /** 今日是否已完成畅听 VIP 签到 */
  checkedIn: boolean;
  /** 今日是否已完成概念 SVIP 升级（解锁 320k/FLAC） */
  upgraded: boolean;
  /** 签到归属日期（YYYY-MM-DD） */
  checkinDate: string;
  /** 当前概念 SVIP（无损音质权益）是否生效中 */
  svipActive: boolean;
  /** 概念 SVIP 到期时间 */
  svipEndTime: string;
  /** 账号显示名（昵称优先，回退 userid） */
  accountLabel: string;
  /** 紧凑状态文案（如「会员 27.01.28 · 已签」） */
  statusLabel: string;
  savedAt: number;
  invalidReason: string;
}

interface VipQueryResult {
  ok: boolean;
  isVip: boolean;
  endTime: string;
  remainingMs: number | null;
  svipActive: boolean;
  svipEndTime: string;
  rejected: boolean;
}

let cachedVip: { key: string; at: number; result: VipQueryResult } | null = null;
let lastForceUpgradeAt = 0;

export function invalidateKugouStatusCache(): void {
  cachedVip = null;
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

/** 提取 YY.MM.DD 短日期，如 "2027-01-28 12:20:05" -> "27.01.28" */
function shortExpireDate(endTime: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(endTime.trim());
  if (!m) return '';
  return `${m[1].slice(2)}.${m[2]}.${m[3]}`;
}

async function queryVip(token: string, userid: string): Promise<VipQueryResult> {
  const { mid, dfid } = getKugouDevice();
  const base: Record<string, string> = {
    dfid: dfid || '-',
    mid,
    uuid: '-',
    appid: '3116',
    clientver: '11440',
    clienttime: String(Math.floor(Date.now() / 1000)),
    token,
    userid,
    busi_type: 'concept',
  };
  const sorted = Object.keys(base)
    .sort()
    .map(k => `${k}=${base[k]}`)
    .join('');
  const signature = md5(`${SALT_LITE}${sorted}${SALT_LITE}`);
  const res = await fetch(
    `https://kugouvip.kugou.com/v1/get_union_vip?${new URLSearchParams({ ...base, signature })}`,
    {
      headers: { 'User-Agent': UA, Cookie: `token=${token}; userid=${userid};` },
      signal: AbortSignal.timeout(8_000),
    },
  );
  const j: any = await res.json();
  if (j?.status !== 1) {
    // 20018 / 35005 都意味着 token 不被认可 → 归到「失效」，不是「没会员」
    const rejected = Number(j?.error_code ?? 0) === 20018 || Number(j?.error_code ?? 0) === 35005;
    return {
      ok: false,
      isVip: false,
      endTime: '',
      remainingMs: null,
      svipActive: false,
      svipEndTime: '',
      rejected,
    };
  }

  const busiList: any[] = Array.isArray(j?.data?.busi_vip) ? j.data.busi_vip : [];
  const conceptList = busiList.filter(b => b?.busi_type === 'concept');
  const candidates = conceptList.length > 0 ? conceptList : busiList;

  const now = Date.now();
  const parsedRows = candidates.map(b => {
    const endTime = String(b?.vip_end_time ?? '');
    const endMs = parseKugouTime(endTime);
    const remainingMs = endMs === null ? null : endMs - now;
    const active = Number(b?.is_vip ?? 0) === 1 && (remainingMs === null || remainingMs > 0);
    const productType = String(b?.product_type ?? '').toLowerCase();
    return { endTime, endMs: endMs ?? 0, remainingMs, active, productType };
  });

  const activeRows = parsedRows.filter(r => r.active);
  // 取最晚到期的有效会员行作为总到期时间（例如 tvip 到 2027-01-28，svip 到明日）
  const bestPool = activeRows.length > 0 ? activeRows : parsedRows;
  const bestRow = bestPool.reduce<{ endTime: string; endMs: number; remainingMs: number | null } | null>(
    (acc, cur) => (!acc || cur.endMs > acc.endMs ? cur : acc),
    null,
  );

  const svipRow = activeRows.find(r => r.productType === 'svip');
  const endTime = bestRow?.endTime ?? '';
  const remainingMs = bestRow?.remainingMs ?? null;
  const isVip = activeRows.length > 0;

  return {
    ok: true,
    isVip,
    endTime,
    remainingMs,
    svipActive: Boolean(svipRow),
    svipEndTime: svipRow?.endTime ?? '',
    rejected: false,
  };
}

function emptyLoggedOutState(): KugouLoginState {
  const checkin = readKugouCheckinState('');
  return {
    state: 'logged_out',
    label: '未登录',
    userid: '',
    nickname: '',
    vipEndTime: '',
    vipExpireAt: '',
    vipRemainingMs: null,
    checkedIn: false,
    upgraded: false,
    checkinDate: checkin.date,
    svipActive: false,
    svipEndTime: '',
    accountLabel: '未登录',
    statusLabel: '未登录',
    savedAt: 0,
    invalidReason: '',
  };
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
    return emptyLoggedOutState();
  }

  let c: { token?: string; userid?: string; nickname?: string; savedAt?: number } = {};
  try {
    c = JSON.parse(raw);
  } catch {
    return emptyLoggedOutState();
  }
  const token = String(c.token ?? '');
  const userid = String(c.userid ?? '');
  const nickname = String(c.nickname ?? '');
  const savedAt = Number(c.savedAt ?? 0);
  const accountLabel = nickname || userid || '未命名';

  // 已被取流或签到打标失效 → 直接报失效，不必再打上游
  if (invalidReason) {
    const checkin = readKugouCheckinState(userid);
    return {
      state: 'invalid',
      label: '已失效',
      userid,
      nickname,
      vipEndTime: '',
      vipExpireAt: '',
      vipRemainingMs: null,
      checkedIn: false,
      upgraded: false,
      checkinDate: checkin.date,
      svipActive: false,
      svipEndTime: '',
      accountLabel,
      statusLabel: '已失效',
      savedAt,
      invalidReason,
    };
  }

  // 查询状态前先确保今日签到与概念 SVIP 升级已完成（已签则毫秒级读本地缓存）
  let checkin = await ensureKugouCheckin();
  const checkedIn = Boolean(checkin.signed);
  const upgraded = Boolean(checkin.upgraded);
  const signTag = checkedIn ? '已签' : '未签';

  try {
    const cacheKey = `${userid}|${token}|${checkin.date}|${checkedIn ? 1 : 0}|${upgraded ? 1 : 0}`;
    let vip: VipQueryResult;
    if (cachedVip && cachedVip.key === cacheKey && Date.now() - cachedVip.at < STATUS_CACHE_TTL_MS) {
      vip = cachedVip.result;
    } else {
      vip = await queryVip(token, userid);
      // 若会员有效但概念 SVIP 未激活，且距离上次强制补升超过 10 分钟，主动触发一次强制签到升级
      if (vip.ok && vip.isVip && !vip.svipActive && Date.now() - lastForceUpgradeAt > 10 * 60_000) {
        lastForceUpgradeAt = Date.now();
        checkin = await runKugouCheckin(true);
        vip = await queryVip(token, userid);
      }
      if (vip.ok) {
        cachedVip = { key: cacheKey, at: Date.now(), result: vip };
      }
    }

    const finalCheckedIn = Boolean(checkin.signed);
    const finalUpgraded = Boolean(checkin.upgraded);
    const finalSignTag = finalCheckedIn ? '已签' : '未签';

    if (vip.rejected) {
      return {
        state: 'invalid',
        label: '已失效',
        userid,
        nickname,
        vipEndTime: '',
        vipExpireAt: '',
        vipRemainingMs: null,
        checkedIn: false,
        upgraded: false,
        checkinDate: checkin.date,
        svipActive: false,
        svipEndTime: '',
        accountLabel,
        statusLabel: '已失效',
        savedAt,
        invalidReason: 'token 被上游拒绝',
      };
    }

    if (!vip.ok) {
      // 网络抖动等：不改状态，按已登录展示
      return {
        state: 'ok',
        label: finalSignTag,
        userid,
        nickname,
        vipEndTime: '',
        vipExpireAt: '',
        vipRemainingMs: null,
        checkedIn: finalCheckedIn,
        upgraded: finalUpgraded,
        checkinDate: checkin.date,
        svipActive: false,
        svipEndTime: '',
        accountLabel,
        statusLabel: finalSignTag,
        savedAt,
        invalidReason: '',
      };
    }

    const vipExpireAt = shortExpireDate(vip.endTime);

    if (!vip.isVip) {
      const expPart = vipExpireAt ? ` · ${vipExpireAt}` : '';
      return {
        state: 'vip_expired',
        label: `已到期${expPart} · ${finalSignTag}`,
        userid,
        nickname,
        vipEndTime: vip.endTime,
        vipExpireAt,
        vipRemainingMs: vip.remainingMs,
        checkedIn: finalCheckedIn,
        upgraded: finalUpgraded,
        checkinDate: checkin.date,
        svipActive: false,
        svipEndTime: '',
        accountLabel,
        statusLabel: `已到期${expPart} · ${finalSignTag}`,
        savedAt,
        invalidReason: '',
      };
    }

    const expPart = vipExpireAt ? ` · ${vipExpireAt}` : '';
    const statusText = `${finalSignTag}${expPart}`;
    log.debug(`酷狗登录态：会员有效至 ${vip.endTime}（SVIP=${vip.svipActive ? vip.svipEndTime : '未生效'}，${finalSignTag}）`);
    return {
      state: 'ok',
      label: statusText,
      userid,
      nickname,
      vipEndTime: vip.endTime,
      vipExpireAt,
      vipRemainingMs: vip.remainingMs,
      checkedIn: finalCheckedIn,
      upgraded: finalUpgraded,
      checkinDate: checkin.date,
      svipActive: vip.svipActive,
      svipEndTime: vip.svipEndTime,
      accountLabel,
      statusLabel: statusText,
      savedAt,
      invalidReason: '',
    };
  } catch (err) {
    return {
      state: 'ok',
      label: signTag,
      userid,
      nickname,
      vipEndTime: '',
      vipExpireAt: '',
      vipRemainingMs: null,
      checkedIn,
      upgraded,
      checkinDate: checkin.date,
      svipActive: false,
      svipEndTime: '',
      accountLabel,
      statusLabel: signTag,
      savedAt,
      invalidReason: (err as Error).message,
    };
  }
}
