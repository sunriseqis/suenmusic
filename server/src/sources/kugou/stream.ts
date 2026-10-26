/**
 * 酷狗取流（ResolveResult 契约实现，参照 netease/source.ts）。
 *
 * 链路位置：网易云之后、B 站之前（VIP FLAC 优先于 B 站视频转音频）。
 * 凭据热读 app_settings 的 kugou.credentials（Web 面板扫码写入）；
 * 无凭据 → 直接 below_threshold（不进链，省一次上游）。
 *
 * 协议（2026-10-26 实测）：
 *   - 取流走标准版参数 + gateway + x-router: tracker.kugou.com，
 *     且 JSON body 参与签名：MD5(盐 + 排序参数串 + body + 盐)；
 *     漏掉 body → invalid sign；漏掉 x-router → invalid appid。
 *   - 搜索走概念版盐（见 source.ts）。两套体系不可混用。
 *   - 权益逐档（relate_goods：L2=128/L4=320/L5=FLAC/L6=Hi-Res），
 *     音质按账号真实权益选（privilege===0 才要），不破解。
 *   - 直链在 data[0].info.tracker_url[0]；_msg 以 Allow: 开头是提示不是错误。
 *   - 直链头只需 UA（酷狗 CDN 不校验 Referer）；绝不带账号 Cookie。
 */

import crypto from 'node:crypto';
import { createLogger } from '../../logger.ts';
import { getSetting } from '../../db/repo/settings.ts';
import { kugouSearchSongs } from './source.ts';
import type { ResolveInput, ResolveResult } from '../bilibili/stream.ts';

const log = createLogger('kugou:stream');

const SALT_STD = 'OIlwieks28dk2k092lksi2UIkp';
const APPID = '1005';
const CLIENTVER = '20489';
const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';

const guid = crypto.createHash('md5').update('suenmusic-kugou-device-v1').digest('hex');
const mid = BigInt('0x' + md5(guid)).toString();

interface KugouCreds {
  token: string;
  userid: string;
  vipToken?: string;
  vipType?: string;
}

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

export function getKugouCreds(): KugouCreds | null {
  return readCreds();
}

function readCreds(): KugouCreds | null {
  const raw = getSetting('kugou.credentials');
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { token?: string; userid?: string; vipToken?: string; vipType?: string };
    if (!p.token || !p.userid) return null;
    return { token: p.token, userid: p.userid, vipToken: p.vipToken, vipType: p.vipType };
  } catch {
    return null;
  }
}

function fail(reason: ResolveResult['reason'], message: string): ResolveResult {
  return {
    ok: false, reason, bvid: null, sourceUrl: null, score: 0,
    message: '[酷狗] ' + message, source: 'kugou',
  };
}

interface QualityRow { level?: number; quality?: string; privilege?: number }

async function fetchQualities(hash: string, albumId: string, creds: KugouCreds): Promise<QualityRow[]> {
  const dataMap = {
    appid: Number(APPID), area_code: 1, behavior: 'play', clientver: Number(CLIENTVER),
    need_hash_offset: 1, relate: 1, support_verify: 1,
    resource: [{ type: 'audio', page_id: 0, hash, album_id: Number(albumId) || 0 }],
    qualities: ['128', '320', 'flac', 'high'],
  };
  const dataStr = JSON.stringify(dataMap);
  const base: Record<string, string> = {
    dfid: '-', mid, uuid: guid, appid: APPID, clientver: CLIENTVER,
    clienttime: String(Math.floor(Date.now() / 1000)), token: creds.token, userid: creds.userid,
  };
  const sorted = Object.keys(base).sort().map(k => k + '=' + base[k]).join('');
  const signature = md5(SALT_STD + sorted + dataStr + SALT_STD);
  const res = await fetch('http://gateway.kugou.com/v2/get_res_privilege/lite?' + new URLSearchParams({ ...base, signature }), {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/json', 'x-router': 'media.store.kugou.com',
      mid, dfid: '-', clienttime: base.clienttime,
      'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    },
    body: dataStr,
    signal: AbortSignal.timeout(8000),
  });
  const j: any = await res.json();
  return ((j?.data ?? [])[0] ?? {}).relate_goods ?? [];
}

async function fetchPlayUrl(hash: string, albumAudioId: string, quality: string, creds: KugouCreds): Promise<{ url: string | null; bitrate: number }> {
  const dataMap = {
    area_code: '1', behavior: 'play', qualities: [quality],
    resource: { album_audio_id: albumAudioId, collect_list_id: '3', collect_time: Date.now(), hash, id: 0, page_id: 1, type: 'audio' },
    token: creds.token,
    tracker_param: {
      all_m: 1, auth: '', is_free_part: 0,
      key: md5(hash + '185672dd44712f60bb1736df5a377e82' + APPID + mid + creds.userid),
      module_id: 0, need_climax: 1, need_xcdn: 1, open_time: '',
      pid: '411', pidversion: '3001', priv_vip_type: '6', viptoken: creds.vipToken ?? '',
    },
    userid: creds.userid, vip: Number(creds.vipType ?? 6),
  };
  const dataStr = JSON.stringify(dataMap);
  const base: Record<string, string> = {
    dfid: '-', mid, uuid: guid, appid: APPID, clientver: CLIENTVER,
    clienttime: String(Math.floor(Date.now() / 1000)),
  };
  const sorted = Object.keys(base).sort().map(k => k + '=' + base[k]).join('');
  const signature = md5(SALT_STD + sorted + dataStr + SALT_STD);
  const res = await fetch('http://gateway.kugou.com/v6/priv_url?' + new URLSearchParams({ ...base, signature }), {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/json', 'x-router': 'tracker.kugou.com',
      mid, dfid: '-', clienttime: base.clienttime,
      'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    },
    body: dataStr,
    signal: AbortSignal.timeout(8000),
  });
  const j: any = await res.json();
  const row = (j?.data ?? [])[0] ?? {};
  return { url: String(row?.info?.tracker_url?.[0] ?? '') || null, bitrate: Number(row?.info?.bitrate ?? 0) };
}

const QUALITY_LEVEL: Record<string, number> = { flac: 5, high: 6, '320': 4, '128': 2 };

function pickQuality(goods: QualityRow[]): string | null {
  for (const q of ['flac', 'high', '320', '128']) {
    const row = goods.find(
      g => String(g.quality ?? '') === q || Number(g.level ?? -1) === QUALITY_LEVEL[q],
    );
    if (row && Number(row.privilege ?? -1) === 0) return q;
  }
  return null;
}

export async function resolveKugouSource(track: ResolveInput): Promise<ResolveResult> {
  const creds = readCreds();
  if (!creds) return fail('below_threshold', '未授权酷狗（需要概念版 VIP cookie）');

  const name = String(track.name ?? '').trim();
  if (!name) return fail('no_candidates', '曲目无名');

  const artist = (track.artists ?? [])[0] ?? '';
  const keyword = artist ? name + ' ' + artist : name;

  let rows;
  try {
    rows = await kugouSearchSongs(keyword, 8, creds);
  } catch (err) {
    return fail('rejected', '搜索失败：' + (err as Error).message);
  }
  if (!rows.length) return fail('no_candidates', '搜索无结果（' + keyword + '）');

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[()（）[\]【】]/g, '');
  const target = norm(name);
  const durTarget = Math.round((track.durationMs ?? 0) / 1000);
  const candidates = rows.filter(r => {
    if (!norm(r.name).includes(target) && !target.includes(norm(r.name))) return false;
    if (durTarget > 0 && r.durationSec > 0 && Math.abs(r.durationSec - durTarget) > 5) return false;
    return true;
  });
  if (!candidates.length) return fail('no_candidates', '无匹配（' + keyword + '）');

  for (const cand of candidates) {
    let goods: QualityRow[];
    try {
      goods = await fetchQualities(cand.hash, cand.albumId, creds);
    } catch (err) {
      log.warn('权益查询失败 ' + cand.id + '：' + (err as Error).message);
      continue;
    }
    const quality = pickQuality(goods);
    if (!quality) continue;

    try {
      const { url, bitrate } = await fetchPlayUrl(cand.hash, cand.albumAudioId, quality, creds);
      if (!url) continue;
      log.info('酷狗命中 ' + cand.id + ' 「' + cand.name + '」' + quality + '@' + bitrate + 'kbps');
      return {
        ok: true,
        bvid: null,
        sourceUrl: url,
        score: 100,
        source: 'kugou',
        matchedTitle: cand.name,
        matchedAuthor: cand.singers.map(s => s.name).join('/'),
        durationDiff: durTarget > 0 ? Math.abs(cand.durationSec - durTarget) : 0,
      };
    } catch (err) {
      log.warn('取流失败 ' + cand.id + '：' + (err as Error).message);
    }
  }
  return fail('below_threshold', '候选均无可播音质');
}
