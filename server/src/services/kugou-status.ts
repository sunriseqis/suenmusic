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

/**
 * 概念版 SVIP 在 `busi_vip.product_type` 上的取值白名单。
 *
 * 实测（docs/memory/2026-10-26-酷狗接入交接-暂停点.md:70）：
 *   get_union_vip busi_type=concept → busi_vip: is_vip=1, busi_type=concept,
 *   product_type=**tvip**，到期 2026-10-27 14:53
 * 上游把概念版会员标成 `tvip` 而非 `svip`，只认 `svip` 会让真会员恒判为「无 SVIP」。
 * 上游以后若再改取值/换名，只需在这里补一项。
 */
const CONCEPT_SVIP_PRODUCT_TYPES: readonly string[] = ['svip', 'tvip'];

/**
 * 上游异常（网络抖动 / 非 20018·35005 的失败）的短期负缓存：
 * 窗口内不再重复打上游，直接报 unknown。30 秒足够躲过抖动，又不至于把状态卡太久。
 */
const TRANSIENT_TTL_MS = 30_000;

/** 上游异常窗口的截止时间戳（0 = 无） */
let transientFailureUntil = 0;

export type KugouState = 'logged_out' | 'invalid' | 'vip_expired' | 'ok' | 'unknown';

/**
 * 能否尝试用这套凭据取流。
 *
 * unknown（上游暂时问不出来）必须**仍然尝试**：临时抖动不该让整条酷狗音源被跳过；
 * 而 invalid / logged_out 是明确结论，试了也是白打。
 */
export function kugouUsable(state: KugouState): boolean {
  return state === 'ok' || state === 'unknown';
}

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

/**
 * 最近一次**成功**查到的会员判定（S-19）。
 *
 * 为什么需要它：网络抖动时状态是 unknown，而旧实现让 unknown 恒报 svipActive=false →
 * 取流层把 SVIP 用户的尝试序列锁成「仅 128k」、availableQualities 只报 standard。
 * 「临时抖动不该降低体验」是 unknown 态存在的理由（见 kugouUsable 注释），
 * 所以抖动窗口内沿用最后一次有效判定，而不是凭空降级。
 *
 * 与 cachedVip 的分工：cachedVip 是**5 分钟内、同一凭据+同一签到状态**的查询缓存
 * （决定要不要再打上游）；这里是「最后一次问出结果的那份会员能力」，只给 unknown 兜底。
 */
let lastVipSnapshot: { userid: string; at: number; result: VipQueryResult } | null = null;

/** 快照可复用的最长年龄：超过它就是「长时间问不出来」，unknown 应老实降级 */
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * unknown 态可复用的 SVIP 能力。没有快照 / 换了账号 / 快照里的 SVIP 已过期 → false。
 *
 * 概念 SVIP 只有 24 小时（每次升级续期），快照可能比它活得久，所以必须校验到期时间 ——
 * 复用一个已过期的 svipActive=true 会真去请求 320k/FLAC，拿不到反而多打上游。
 */
function snapshotSvipFlags(userid: string): { svipActive: boolean; svipEndTime: string } {
  const snap = lastVipSnapshot;
  if (!snap || !snap.result.ok || !snap.result.svipActive) return { svipActive: false, svipEndTime: '' };
  // 凭据换了就不是「同一个账号上次的判定」，不能拿来当这次的能力
  if (userid && snap.userid !== userid) return { svipActive: false, svipEndTime: '' };
  // 太久没成功问过（一整天都在抖）就不猜了：宁可降级，也不要拿一份陈旧的会员能力去请求
  if (Date.now() - snap.at > SNAPSHOT_MAX_AGE_MS) return { svipActive: false, svipEndTime: '' };
  const endMs = parseKugouTime(snap.result.svipEndTime);
  if (endMs !== null && endMs <= Date.now()) return { svipActive: false, svipEndTime: '' };
  return { svipActive: true, svipEndTime: snap.result.svipEndTime };
}

export function invalidateKugouStatusCache(): void {
  cachedVip = null;
  transientFailureUntil = 0;
}

/**
 * 「上游暂时问不出来」的状态。**绝不冒充 ok** ——
 * 旧代码在这条路上直接返回 state:'ok'，把网络抖动谎报成「会员有效」，
 * 面板与解析链路都当真的用（会员信息其实是空的）。
 */
function unknownState(args: {
  userid: string;
  nickname: string;
  accountLabel: string;
  savedAt: number;
  checkedIn: boolean;
  upgraded: boolean;
  checkinDate: string;
  reason?: string;
}): KugouLoginState {
  /**
   * 会员能力沿用「最近一次有效快照」（S-19）：unknown 只表示**这次没问出来**，
   * 不表示账号掉了会员。没有快照时才是 false（真正的「无从判定」）。
   * 注意只影响 unknown —— invalid / logged_out / vip_expired 的判定一律照旧。
   */
  const svip = snapshotSvipFlags(args.userid);
  return {
    state: 'unknown',
    label: '状态未知',
    userid: args.userid,
    nickname: args.nickname,
    vipEndTime: '',
    vipExpireAt: '',
    vipRemainingMs: null,
    checkedIn: args.checkedIn,
    upgraded: args.upgraded,
    checkinDate: args.checkinDate,
    svipActive: svip.svipActive,
    svipEndTime: svip.svipEndTime,
    accountLabel: args.accountLabel,
    statusLabel: '状态未知',
    savedAt: args.savedAt,
    invalidReason: args.reason ?? '',
  };
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

  // 概念版 SVIP：只在 concept 行里认（上方 candidates 已优先过滤 busi_type === 'concept'），
  // 避免把非 concept 的畅听 VIP 行误判成 SVIP。
  const svipRow = activeRows.find(r => CONCEPT_SVIP_PRODUCT_TYPES.includes(r.productType));
  if (svipRow) {
    log.debug(`命中概念版 SVIP：product_type=${svipRow.productType}，到期 ${svipRow.endTime}`);
  }
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

  // 近期上游异常过 → 30s 内不再白打一遍上游，直接报「状态未知」
  if (Date.now() < transientFailureUntil) {
    const ci = readKugouCheckinState(userid);
    return unknownState({
      userid,
      nickname,
      accountLabel,
      savedAt,
      checkedIn: Boolean(ci.signed),
      upgraded: Boolean(ci.upgraded),
      checkinDate: ci.date,
    });
  }

  // 查询状态前先确保今日签到与概念 SVIP 升级已完成（已签则毫秒级读本地缓存）
  let checkin = await ensureKugouCheckin();
  const checkedIn = Boolean(checkin.signed);
  const upgraded = Boolean(checkin.upgraded);

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
        // 记下这次问出来的会员能力：unknown 态（网络抖动）复用它，见 snapshotSvipFlags
        lastVipSnapshot = { userid, at: Date.now(), result: vip };
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
      // 明确的凭据无效已在上面（vip.rejected）判成 invalid；
      // 走到这里都是网络抖动/上游异常 —— 报 unknown，并做短期负缓存避免连续白打。
      transientFailureUntil = Date.now() + TRANSIENT_TTL_MS;
      return unknownState({
        userid,
        nickname,
        accountLabel,
        savedAt,
        checkedIn: finalCheckedIn,
        upgraded: finalUpgraded,
        checkinDate: checkin.date,
        reason: '上游查询会员失败（网络抖动或上游异常）',
      });
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
    // 抛异常 = 上游完全没应答：同样是 unknown，不是 ok
    transientFailureUntil = Date.now() + TRANSIENT_TTL_MS;
    return unknownState({
      userid,
      nickname,
      accountLabel,
      savedAt,
      checkedIn,
      upgraded,
      checkinDate: checkin.date,
      reason: (err as Error).message,
    });
  }
}
