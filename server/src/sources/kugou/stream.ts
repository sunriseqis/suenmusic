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
import { markKugouCredentialInvalid } from '../../services/kugou-login.ts';
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
  /** 续期票据（/login/token 需要；缺了只能重新扫码） */
  t1?: string;
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
    const p = JSON.parse(raw) as { token?: string; userid?: string; vipToken?: string; vipType?: string; t1?: string };
    if (!p.token || !p.userid) return null;
    return { token: p.token, userid: p.userid, vipToken: p.vipToken, vipType: p.vipType, t1: p.t1 };
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
  // 20018 = token 失效/类型不对：打标让 Web 面板显示「需重新授权」，
  // 并在消息里说人话（否则用户只看到「无音源」，永远不知道要去授权）。
  if (Number(j?.error_code ?? 0) === 20018) {
    markKugouCredentialInvalid('token api error (20018)：酷狗授权已过期');
    throw new Error('酷狗授权已过期，请在设置→音源授权重新扫码');
  }
  const row = (j?.data ?? [])[0] ?? {};
  return { url: String(row?.info?.tracker_url?.[0] ?? '') || null, bitrate: Number(row?.info?.bitrate ?? 0) };
}

/**
 * 音质取值顺序。
 *
 * ⚠️ **不要用 privilege 预过滤**：VIP 账号能播的曲子 relate_goods 里 privilege≠0
 *（实测：私有/付费曲 privilege=5、10）。之前要求 privilege===0 等于把 VIP 用户能播的全部剔除，
 * 表现就是「APP 里能搜到能播，我们这儿全显示无音源」。
 * 正确做法是**让上游回答**：逐个音质调 /v6/priv_url，拿到非空直链即用。
 */
const QUALITY_ORDER = ['flac', 'high', '320', '128'] as const;

export async function resolveKugouSource(track: ResolveInput): Promise<ResolveResult> {
  const creds = readCreds();
  if (!creds) return fail('below_threshold', '未授权酷狗（需要概念版 VIP cookie）');

  const name = String(track.name ?? '').trim();
  if (!name) return fail('no_candidates', '曲目无名');

  const artist = (track.artists ?? [])[0] ?? '';
  const keyword = artist ? name + ' ' + artist : name;

  // 取 30 条：原版经常被现场版/翻唱/DJ 版挤出前 8 名（实测「叱咤红人」原版在 8 条之外）。
  let rows;
  try {
    rows = await kugouSearchSongs(keyword, 30, creds);
  } catch (err) {
    return fail('rejected', '搜索失败：' + (err as Error).message);
  }
  if (!rows.length) return fail('no_candidates', '搜索无结果（' + keyword + '）');

  // 归一化：去空白/括号/常见版本后缀，用于「同名优先」排序（不做硬性等号，避免误杀别名）
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[()（）[\]【】]/g, '');
  const VERSION_RE = /(live|现场|演唱会|dj|翻唱|cover|纯音乐|伴奏|remix|版|钢琴|吉他|合唱|片段)/i;
  const target = norm(name);
  const durTarget = Math.round((track.durationMs ?? 0) / 1000);

  // 匹配规则（用户 2026-10-26 拍板）：**歌名相等 + 歌手命中 + 时长差 ≤8s**；专辑放松（精选集也允许）。
  // 只靠「包含」会错配：实测「晴天」会取到 176s 的另一版（差 93s）、「最伟大的作品」取到网友改编（差 56s）。
  const MAX_DUR_DIFF = 8;
  const artistHit = (r: { singers: Array<{ name: string }> }) => {
    if (!artist) return true;
    const a = norm(artist);
    return r.singers.some((s: { name: string }) => {
      const n = norm(s.name);
      return n.length > 0 && (n.includes(a) || a.includes(n));
    });
  };
  const durOk = (r: { durationSec: number }) =>
    durTarget <= 0 || r.durationSec <= 0 || Math.abs(r.durationSec - durTarget) <= MAX_DUR_DIFF;

  // 第一轮：**歌名相等 + 歌手命中即匹配**（用户规则：这两个错一个就不算匹配；专辑放松）。
  // 时长**不做硬闸**：库里的时长可能是另一个版本（实测《处处吻》库 246s、酷狗原版 199s；
  // 《小城大事》库 236s、酷狗 208s），硬闸会把正版挡掉。时长只用于排序取最接近的。
  const strict = rows.filter(r => norm(r.name) === target && artistHit(r));
  // 放宽轮：仍要求**不是版本后缀**（Live/现场/DJ/翻唱/伴奏/纯音乐/钢琴等），
  // 否则「晴天( Live)」「处处吻(DJ老鹏版)」这类会冒充原版（实测两例）。
  const loose = rows.filter(
    r =>
      norm(r.name) !== target &&
      !VERSION_RE.test(r.name) &&
      (norm(r.name).includes(target) || target.includes(norm(r.name))) &&
      artistHit(r) &&
      durOk(r),
  );
  const scored = [...strict, ...loose].map(r => {
    const durDiff = durTarget > 0 && r.durationSec > 0 ? Math.abs(r.durationSec - durTarget) : 999;
    const versioned = VERSION_RE.test(r.name) ? 1 : 0;
    return { r, versioned, durDiff };
  }).sort((a, b) => (a.versioned - b.versioned) || (a.durDiff - b.durDiff));

  if (!scored.length) return fail('no_candidates', '无匹配（' + keyword + '）');

  // 取前 6 个候选逐个试：每个候选按音质从高到低问上游，拿到非空直链即用
  for (const entry of scored.slice(0, 6)) {
    const cand = entry.r;
    for (const quality of QUALITY_ORDER) {
      try {
        const { url, bitrate } = await fetchPlayUrl(cand.hash, cand.albumAudioId, quality, creds);
        if (!url) continue;
        log.info(
          '酷狗命中 ' + cand.id + ' 「' + cand.name + '」' + quality + '@' + bitrate + 'kbps' +
            ' 时长差=' + (durTarget > 0 ? Math.abs(cand.durationSec - durTarget) : 0) + 's'
        );
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
        log.warn('取流失败 ' + cand.id + '/' + quality + '：' + (err as Error).message);
      }
    }
  }
  return fail('below_threshold', '候选均无可播音质');
}
