/**
 * 酷狗概念版每日自动签到 + 概念 VIP（SVIP）升级服务。
 *
 * 完整对齐 EchoMusic（src/renderer/api/user.ts + KuGouMusicApi）：
 *   Step 1: POST https://gateway.kugou.com/youth/v1/recharge/receive_vip_listen_song
 *           (source_id=90139, receive_day=YYYY-MM-DD)
 *           → 领取当日畅听 VIP（tvip，仅解锁 128k 完整版；已签到返回 error_code=131001/130012）。
 *           若当日首次直接领券未过，补一次听歌上报 /youth/v2/report/listen_song 再重试或核对月度记录。
 *   Step 2: POST https://gateway.kugou.com/youth/v1/listen_song/upgrade_vip_reward
 *           (kugouid=userid, ad_type=1)
 *           → 升级当日概念 VIP（svip，recharge_hours=24，解锁 FLAC 无损与 320k 高品；
 *             已升级返回 error_code=297002「已经领取过升级vip奖励」）。
 *
 * 状态持久化在 app_settings 的 `kugou.checkin` 键，供启动、定时任务、扫码/导入、取流兜底与状态接口共用。
 */

import crypto from 'node:crypto';
import { createLogger } from '../logger.ts';
import { getSetting, setSetting } from '../db/repo/settings.ts';
import { todayStr } from '../utils/dates.ts';
import { ensureDfid, getKugouDevice, markKugouCredentialInvalid } from './kugou-login.ts';
import { APPID_LITE, CLIENTVER_LITE, SIGN_SALT_LITE, UA_LITE } from '../sources/kugou/source.ts';

const log = createLogger('kugou:checkin');

export interface KugouCheckinState {
  /** 北京时间当日 YYYY-MM-DD */
  date: string;
  /** 归属酷狗 userid（切换账号时自动重签） */
  userid: string;
  /** 畅听 VIP 签到是否已完成（receive_vip_listen_song / get_month_vip_record） */
  signed: boolean;
  /** 概念 VIP（SVIP，解锁 320k/FLAC）升级奖励是否已领取（upgrade_vip_reward） */
  upgraded: boolean;
  /** 最近一次更新时间（毫秒时间戳） */
  updatedAt: number;
  /** 上游状态说明或错误信息 */
  rawMsg: string;
}

interface Creds {
  token: string;
  userid: string;
  guid?: string;
  mid?: string;
  dfid?: string;
}

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

function signLite(params: Record<string, string>, body = ''): string {
  const sorted = Object.keys(params)
    .sort()
    .filter(k => params[k] !== undefined && params[k] !== null)
    .map(k => `${k}=${params[k]}`)
    .join('');
  return md5(SIGN_SALT_LITE + sorted + body + SIGN_SALT_LITE);
}

function resolveIdentity(creds: Creds, dfidOverride?: string): { mid: string; dfid: string } {
  const dev = getKugouDevice();
  const mid = creds.mid || dev.mid;
  const dfid = dfidOverride || creds.dfid || dev.dfid || '-';
  return { mid, dfid };
}

function buildLiteParams(
  extra: Record<string, string>,
  creds: Creds,
  dfid: string,
  body = '',
): Record<string, string> {
  const { mid } = resolveIdentity(creds, dfid);
  const p: Record<string, string> = {
    dfid,
    appid: APPID_LITE,
    clientver: CLIENTVER_LITE,
    mid,
    uuid: '-',
    clienttime: String(Math.floor(Date.now() / 1000)),
    token: creds.token,
    userid: creds.userid,
    ...extra,
  };
  p.signature = signLite(p, body);
  return p;
}

function buildLiteHeaders(
  creds: Creds,
  dfid: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const { mid } = resolveIdentity(creds, dfid);
  return {
    'User-Agent': UA_LITE,
    dfid,
    mid,
    clienttime: String(Math.floor(Date.now() / 1000)),
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    ...extraHeaders,
  };
}

function readCreds(): Creds | null {
  const raw = getSetting('kugou.credentials');
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Creds;
    if (!p?.token || !p?.userid) return null;
    return p;
  } catch {
    return null;
  }
}

function emptyState(userid = ''): KugouCheckinState {
  return {
    date: todayStr(),
    userid,
    signed: false,
    upgraded: false,
    updatedAt: 0,
    rawMsg: '',
  };
}

/** 读取持久化的签到状态；若跨天或切换了账号，自动视作今日未签 */
export function readKugouCheckinState(expectedUserid?: string): KugouCheckinState {
  const today = todayStr();
  const raw = getSetting('kugou.checkin');
  if (!raw) return emptyState(expectedUserid ?? '');
  try {
    const parsed = JSON.parse(raw) as Partial<KugouCheckinState>;
    const uid = String(parsed.userid ?? '');
    if (expectedUserid && uid && uid !== expectedUserid) {
      return emptyState(expectedUserid);
    }
    if (parsed.date !== today) {
      return {
        date: today,
        userid: expectedUserid ?? uid,
        signed: false,
        upgraded: false,
        updatedAt: Number(parsed.updatedAt ?? 0),
        rawMsg: '',
      };
    }
    return {
      date: today,
      userid: uid || (expectedUserid ?? ''),
      signed: Boolean(parsed.signed),
      upgraded: Boolean(parsed.upgraded),
      updatedAt: Number(parsed.updatedAt ?? 0),
      rawMsg: String(parsed.rawMsg ?? ''),
    };
  } catch {
    return emptyState(expectedUserid ?? '');
  }
}

/** 今日是否已完成签到 + SVIP 升级 */
export function isKugouCheckedInToday(expectedUserid?: string): boolean {
  const st = readKugouCheckinState(expectedUserid);
  return st.date === todayStr() && st.signed && st.upgraded;
}

/**
 * Step 1a: 领取当日畅听 VIP（对应 EchoMusic claimDayVip / youth_day_vip.js）
 */
async function claimDayVip(
  creds: Creds,
  dfid: string,
  day: string,
): Promise<{ signed: boolean; rejected: boolean; msg: string }> {
  const params = buildLiteParams(
    {
      source_id: '90139',
      receive_day: day,
    },
    creds,
    dfid,
  );
  const res = await fetch(
    `https://gateway.kugou.com/youth/v1/recharge/receive_vip_listen_song?${new URLSearchParams(params)}`,
    {
      method: 'POST',
      headers: buildLiteHeaders(creds, dfid, {
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const j: any = await res.json();
  const status = Number(j?.status ?? 0);
  const errCode = Number(j?.error_code ?? 0);
  const errMsg = String(j?.error_msg || j?.errmsg || '');

  if (errCode === 20018 || errCode === 35005) {
    return { signed: false, rejected: true, msg: `token 失效 (${errCode})` };
  }
  // status === 1 领取成功；131001 / 130012 代表当日已领取
  if (status === 1 || errCode === 131001 || errCode === 130012) {
    return {
      signed: true,
      rejected: false,
      msg: status === 1 ? '签到领畅听VIP成功' : '今日畅听VIP已签到',
    };
  }
  return {
    signed: false,
    rejected: false,
    msg: `receive_vip_listen_song status=${status} code=${errCode} ${errMsg}`.trim(),
  };
}

/**
 * Step 1b: 听歌上报兜底（对应 KuGouMusicApi youth_listen_song.js）
 */
async function reportListenSong(creds: Creds, dfid: string): Promise<boolean> {
  try {
    const bodyStr = JSON.stringify({ mixsongid: 666075191 });
    const params = buildLiteParams({ clientver: '10566' }, creds, dfid, bodyStr);
    const res = await fetch(
      `https://gateway.kugou.com/youth/v2/report/listen_song?${new URLSearchParams(params)}`,
      {
        method: 'POST',
        headers: buildLiteHeaders(creds, dfid, {
          'User-Agent': 'Android13-1070-10566-201-0-ReportPlaySongToServerProtocol-wifi',
          'Content-Type': 'application/json',
        }),
        body: bodyStr,
        signal: AbortSignal.timeout(10_000),
      },
    );
    const j: any = await res.json();
    const status = Number(j?.status ?? 0);
    const errCode = Number(j?.error_code ?? 0);
    return status === 1 || errCode === 130012 || errCode === 131001;
  } catch {
    return false;
  }
}

/**
 * Step 1c: 查询当月已领取记录（对应 EchoMusic getMonthVipRecord / youth_month_vip_record.js）
 */
async function checkMonthVipRecord(creds: Creds, dfid: string, day: string): Promise<boolean> {
  try {
    const params = buildLiteParams({ latest_limit: '100' }, creds, dfid);
    const res = await fetch(
      `https://gateway.kugou.com/youth/v1/activity/get_month_vip_record?${new URLSearchParams(params)}`,
      {
        method: 'GET',
        headers: buildLiteHeaders(creds, dfid),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const j: any = await res.json();
    const list: Array<{ day?: string; status?: number }> = Array.isArray(j?.data?.list) ? j.data.list : [];
    return list.some(item => item?.day === day && item?.status === 1);
  } catch {
    return false;
  }
}

/**
 * Step 2: 升级当日概念 VIP（SVIP，24 小时，解锁 FLAC/320k）
 * 对应 EchoMusic upgradeDayVip / youth_day_vip_upgrade.js
 */
async function upgradeDayVip(
  creds: Creds,
  dfid: string,
): Promise<{ upgraded: boolean; rejected: boolean; msg: string }> {
  const params = buildLiteParams(
    {
      kugouid: creds.userid,
      ad_type: '1',
    },
    creds,
    dfid,
  );
  const res = await fetch(
    `https://gateway.kugou.com/youth/v1/listen_song/upgrade_vip_reward?${new URLSearchParams(params)}`,
    {
      method: 'POST',
      headers: buildLiteHeaders(creds, dfid, {
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const j: any = await res.json();
  const status = Number(j?.status ?? 0);
  const errCode = Number(j?.error_code ?? 0);
  const errMsg = String(j?.error_msg || j?.errmsg || '');

  if (errCode === 20018 || errCode === 35005) {
    return { upgraded: false, rejected: true, msg: `token 失效 (${errCode})` };
  }
  // status === 1 代表成功充值 24 小时概念 SVIP；297002 代表当日已领取过升级奖励
  if (status === 1 || errCode === 297002) {
    const hours = Number(j?.data?.recharge_hours ?? 24);
    return {
      upgraded: true,
      rejected: false,
      msg: status === 1 ? `升级概念SVIP成功(+${hours}h)` : '今日概念SVIP已升级',
    };
  }
  return {
    upgraded: false,
    rejected: false,
    msg: `upgrade_vip_reward status=${status} code=${errCode} ${errMsg}`.trim(),
  };
}

let inFlight: Promise<KugouCheckinState> | null = null;

/**
 * 执行酷狗概念版每日签到 + 概念 VIP 升级（单飞防重入）。
 *
 * @param force 为 true 时即使本地已记录今日已签也重新请求上游核验
 */
export async function runKugouCheckin(force = false): Promise<KugouCheckinState> {
  const creds = readCreds();
  if (!creds) {
    return emptyState('');
  }
  if (getSetting('kugou.credentialsInvalidAt')) {
    return {
      ...emptyState(creds.userid),
      rawMsg: '凭据已标记失效',
    };
  }

  const today = todayStr();
  const prev = readKugouCheckinState(creds.userid);
  if (!force && prev.date === today && prev.userid === creds.userid && prev.signed && prev.upgraded) {
    return prev;
  }

  if (inFlight) return inFlight;

  const task = (async (): Promise<KugouCheckinState> => {
    const dfid = await ensureDfid();
    let signed = prev.date === today && prev.userid === creds.userid ? prev.signed : false;
    let upgraded = prev.date === today && prev.userid === creds.userid ? prev.upgraded : false;
    const notes: string[] = [];

    try {
      // Step 1: 畅听 VIP 每日签到
      const step1 = await claimDayVip(creds, dfid, today);
      if (step1.rejected) {
        markKugouCredentialInvalid(`签到被拒 ${step1.msg}`);
        const failed: KugouCheckinState = {
          date: today,
          userid: creds.userid,
          signed: false,
          upgraded: false,
          updatedAt: Date.now(),
          rawMsg: step1.msg,
        };
        setSetting('kugou.checkin', JSON.stringify(failed));
        return failed;
      }
      if (step1.signed) {
        signed = true;
        notes.push(step1.msg);
      } else {
        // 首次领券可能要求先有听歌上报：补一次 reportListenSong 再重试/查月度记录
        const reported = await reportListenSong(creds, dfid);
        const retry1 = await claimDayVip(creds, dfid, today);
        if (retry1.signed) {
          signed = true;
          notes.push(retry1.msg);
        } else if (await checkMonthVipRecord(creds, dfid, today)) {
          signed = true;
          notes.push('月度记录确认今日已签');
        } else if (reported) {
          signed = true;
          notes.push('听歌上报已完成');
        } else {
          notes.push(step1.msg);
        }
      }

      // Step 2: 升级当日概念 VIP（SVIP，24 小时，解锁 FLAC/320k）
      const step2 = await upgradeDayVip(creds, dfid);
      if (step2.rejected) {
        markKugouCredentialInvalid(`升级VIP被拒 ${step2.msg}`);
        const failed: KugouCheckinState = {
          date: today,
          userid: creds.userid,
          signed: false,
          upgraded: false,
          updatedAt: Date.now(),
          rawMsg: step2.msg,
        };
        setSetting('kugou.checkin', JSON.stringify(failed));
        return failed;
      }
      if (step2.upgraded) {
        upgraded = true;
        signed = true;
        notes.push(step2.msg);
      } else {
        notes.push(step2.msg);
      }
    } catch (err) {
      notes.push(`网络异常：${(err as Error).message}`);
      log.warn(`酷狗自动签到异常：${(err as Error).message}`);
    }

    const next: KugouCheckinState = {
      date: today,
      userid: creds.userid,
      signed,
      upgraded,
      updatedAt: Date.now(),
      rawMsg: notes.join('；'),
    };
    setSetting('kugou.checkin', JSON.stringify(next));
    log.info(
      `酷狗每日签到结果：date=${next.date} userid=${next.userid} signed=${next.signed} upgraded=${next.upgraded} (${next.rawMsg})`,
    );
    return next;
  })();

  inFlight = task;
  try {
    return await task;
  } finally {
    inFlight = null;
  }
}

/**
 * 确保今日已完成签到与概念 VIP 升级（若今日已签且已升级则秒回本地缓存，不发网）。
 */
export async function ensureKugouCheckin(): Promise<KugouCheckinState> {
  return runKugouCheckin(false);
}
