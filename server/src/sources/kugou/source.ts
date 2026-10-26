/**
 * 酷狗音源（元数据 + 取流）。
 *
 * 定位：
 *   · 元数据：QQ 搜不到时的**兜底**（匿名可用，实测 status=1）；
 *   · 取流：有概念版 VIP cookie 时按 privilege/lite 选档（FLAC/320/128），
 *           无 VIP 只拿 128 —— 权益是逐档的（relateGoods），不破解。
 *
 * 协议要点（逆向自 MakcRe/KuGouMusicApi，2026-10 实测）：
 *   · signature = MD5(盐 + 排序参数串 + 盐)，标准版盐见下；纯 MD5 可离线算；
 *   · mid = BigInt('0x' + md5(guid))；dfid 可用 '-' 顶（搜索可用，直链需注册设备）；
 *   · 搜索上游 complexsearch.kugou.com；取流 trackercdn /priv_url（tracker）；
 *   · 直链头只需 UA + Referer（B 站式的防盗链酷狗没有；但 20028 风控看的是请求方指纹）；
 *   · 平台参数即身份：**概念版 = appid 3116 / clientver 11440**（issue #156 教训）。
 *
 * 本文件刻意**不实现**：
 *   · 自动签到 / 伪造广告播放上报（/youth/v1/ad/play_report）—— 那是刷量，不做；
 *   · viper_tape/clear/atmos（需超级 VIP，概念版权益拿不到）。
 */

import { createLogger } from '../../logger.ts';
import * as crypto from 'node:crypto';

const log = createLogger('kugou');

/**
 * 签名盐：**标准版与概念版不同**（helper.js:62-64）。
 * 实测：用标准版盐配 appid=3116 → `20006 err signature`；换概念版盐 → status=1。
 */
const SIGN_SALT = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
/** 概念版参数（权益跟平台参数走，见 issue #156） */
const APPID_LITE = '3116';
const CLIENTVER_LITE = '11440';
const UA_LITE = 'Android13-1070-11440-3116-0-0-wifi';

export interface KugouCredentials {
  /** 登录 token（VIP 必需） */
  token?: string;
  userid?: string;
  /** VIP 取流令牌（/login/cellphone 等回传） */
  vipToken?: string;
  /** 概念版 VIP 类型（vip_type），缺省按 6 处理 */
  vipType?: string;
}

export interface KugouTrack {
  /** 酷狗唯一键：kg_<albumAudioId>（跨源对齐的主键） */
  id: string;
  hash: string;
  albumAudioId: string;
  albumId: string;
  name: string;
  singers: Array<{ name: string; id?: string }>;
  albumName: string;
  durationSec: number;
  /** 各音质档的 hash（HQ/SQ/Super 各自不同） */
  qualityHashes: { hq?: string; sq?: string; super?: string };
  privilege: number;
  payType: number;
  coverTemplate: string;
}

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

/** 生成一套稳定设备参数（进程内固定，避免指纹漂移引来风控） */
const DEVICE = (() => {
  const guid = md5('suenmusic-kugou-device-v1');
  const mid = BigInt('0x' + md5(guid)).toString();
  return { guid, mid, dfid: '-' };
})();

/** MD5 拼接签名（按 key 排序） */
function signParams(params: Record<string, string>): string {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('');
  return md5(SIGN_SALT + sorted + SIGN_SALT);
}

/** 组公共参数 + 签名，返回可直接用于 URLSearchParams / body 的完整参数集 */
function signedParams(extra: Record<string, string>, creds?: KugouCredentials): Record<string, string> {
  const p: Record<string, string> = {
    ...extra,
    dfid: DEVICE.dfid,
    mid: DEVICE.mid,
    uuid: DEVICE.guid,
    appid: APPID_LITE,
    clientver: CLIENTVER_LITE,
    clienttime: String(Math.floor(Date.now() / 1000)),
  };
  if (creds?.token) {
    p.token = creds.token;
    if (creds.userid) p.userid = creds.userid;
  }
  p.signature = signParams(p);
  return p;
}

async function kgFetch(url: string, params: Record<string, string>, creds?: KugouCredentials): Promise<any> {
  const q = new URLSearchParams(signedParams(params, creds)).toString();
  const res = await fetch(`${url}?${q}`, {
    headers: { 'User-Agent': UA_LITE, mid: DEVICE.mid, dfid: DEVICE.dfid },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 搜索歌曲（匿名可用； creds 可选） */
export async function kugouSearchSongs(keyword: string, limit = 30, creds?: KugouCredentials): Promise<KugouTrack[]> {
  const j = await kgFetch(
    'https://complexsearch.kugou.com/v2/search/song',
    {
      keyword, page: '1', pagesize: String(limit),
      platform: 'AndroidFilter', iscorrection: '1', privilegefilter: '1', area_code: '1', docipfull: '1',
    },
    creds,
  );
  if (j?.status !== 1) throw new Error(`搜索失败 status=${j?.status} errcode=${j?.errcode}`);
  const rows = (j?.data?.lists ?? []) as Array<Record<string, any>>;
  return rows.map(adaptSearchRow);
}

function adaptSearchRow(r: Record<string, any>): KugouTrack {
  const albumAudioId = String(r.MixSongID ?? r.AlbumAudioID ?? '');
  return {
    id: `kg_${albumAudioId}`,
    hash: String(r.FileHash ?? ''),
    albumAudioId,
    albumId: String(r.AlbumID ?? ''),
    name: String(r.SongName ?? '').replace(/<[^>]+>/g, ''),
    singers: [{ name: String(r.SingerName ?? '').replace(/<[^>]+>/g, '') }],
    albumName: String(r.AlbumName ?? ''),
    durationSec: Number(r.Duration ?? 0),
    qualityHashes: { hq: r.HQFileHash || undefined, sq: r.SQFileHash || undefined, super: r.SuperFileHash || undefined },
    privilege: Number(r.Privilege ?? 0),
    payType: Number(r.PayType ?? 0),
    coverTemplate: String(r.Image ?? ''),
  };
}

/** 封面模板 → 定尺寸 URL（酷狗封面是 {size} 占位） */
export function kugouCoverUrl(template: string, size = 480): string {
  return template.replace('{size}', String(size));
}
