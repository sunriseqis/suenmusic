/**
 * 酷狗音源（元数据 + 取流）。
 *
 * 定位：
 *   · 元数据：QQ 搜不到时的**兜底**（匿名可用，实测 status=1）；
 *   · 取流：有概念版 VIP cookie 时按 privilege/lite 选档（FLAC/320/128），
 *           通过 user_verify → authorization → tracker/v5/url 授权取流。
 *
 * 协议要点（逆向自 MakcRe/KuGouMusicApi / EchoMusic，2026-10 实测）：
 *   · signature = MD5(盐 + 排序参数串 + 盐)，概念版盐见下；纯 MD5 可离线算；
 *   · mid = BigInt('0x' + md5(guid))；dfid 由 /risk/v3/r_register_dev 注册；
 *   · 搜索上游 complexsearch.kugou.com；
 *   · 平台参数即身份：**概念版 = appid 3116 / clientver 11440**。
 */

import { createLogger } from '../../logger.ts';
import * as crypto from 'node:crypto';
import { getKugouDevice } from '../../services/kugou-login.ts';

const log = createLogger('kugou');

/**
 * 签名盐：**标准版与概念版不同**（helper.js:62-64）。
 * 实测：用标准版盐配 appid=3116 → `20006 err signature`；换概念版盐 → status=1。
 */
export const SIGN_SALT_LITE = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
/** 概念版参数（权益跟平台参数走） */
export const APPID_LITE = '3116';
export const CLIENTVER_LITE = '11440';
export const UA_LITE = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';

export interface KugouCredentials {
  /** 登录 token（VIP 必需） */
  token?: string;
  userid?: string;
  /** VIP 取流令牌（可选，概念版 tracker/v5/url 不需要） */
  vipToken?: string;
  /** 概念版 VIP 类型（vip_type），缺省按 6 处理 */
  vipType?: string;
  guid?: string;
  mid?: string;
  dfid?: string;
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

/** MD5 拼接签名（按 key 排序） */
function signParams(params: Record<string, string>, body = ''): string {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('');
  return md5(SIGN_SALT_LITE + sorted + body + SIGN_SALT_LITE);
}

/** 组公共参数 + 签名，返回可直接用于 URLSearchParams / body 的完整参数集 */
function signedParams(extra: Record<string, string>, creds?: KugouCredentials): Record<string, string> {
  const dev = getKugouDevice();
  const mid = creds?.mid || dev.mid;
  const dfid = creds?.dfid || dev.dfid || '-';
  const guid = creds?.guid || dev.guid;
  const p: Record<string, string> = {
    ...extra,
    dfid,
    mid,
    uuid: guid,
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
  const dev = getKugouDevice();
  const mid = creds?.mid || dev.mid;
  const dfid = creds?.dfid || dev.dfid || '-';
  const q = new URLSearchParams(signedParams(params, creds)).toString();
  const res = await fetch(`${url}?${q}`, {
    headers: { 'User-Agent': UA_LITE, mid, dfid },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 搜索歌曲（匿名可用；creds 可选） */
export async function kugouSearchSongs(keyword: string, limit = 30, creds?: KugouCredentials): Promise<KugouTrack[]> {
  const j = await kgFetch(
    'https://complexsearch.kugou.com/v2/search/song',
    {
      keyword, page: '1', pagesize: String(limit),
      privilegefilter: '0',
      platform: 'AndroidFilter', iscorrection: '1', area_code: '1', docipfull: '1',
    },
    creds,
  );
  if (j?.status !== 1) throw new Error(`搜索失败 status=${j?.status} errcode=${j?.errcode}`);
  const rows = (j?.data?.lists ?? []) as Array<Record<string, any>>;
  return rows.map(adaptSearchRow);
}

function adaptSearchRow(r: Record<string, any>): KugouTrack {
  const albumAudioId = String(r.MixSongID ?? r.AlbumAudioID ?? r.Audioid ?? '');
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
