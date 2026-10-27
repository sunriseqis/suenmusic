/**
 * 酷狗取流（ResolveResult 契约实现，参照 EchoMusic / KuGouMusicApi 概念版三步授权链）。
 *
 * 链路位置：网易云之后、B 站之前。
 * 凭据热读 app_settings 的 kugou.credentials（Web 面板扫码写入）；
 * 无凭据 → 直接 below_threshold（不进链，省一次上游）。
 *
 * 协议（2026-10-26 实测验证）：
 *   - 全程统一概念版参数：appid=3116 / clientver=11440 / SALT_LITE=LnT6xpN3khm36zse0QzvmgTZ3waWdRSA，
 *     不再混用标准版 appid=1005 或 /v6/priv_url（无需 vip_token）。
 *   - Step 0: POST http://media.store.kugou.com/v2/get_res_privilege/lite 获取 relate_goods 各音质独立 hash。
 *   - Step 1: GET http://gateway.kugou.com/v1/user_verify (x-router: trackercdngz.kugou.com, module_id=51) → userAuth。
 *   - Step 2: GET http://gateway.kugou.com/v1/authorization (x-router: trackercdngz.kugou.com, module_id=51, clientver=11561) → songAuth + open_time。
 *   - Step 3: GET https://gateway.kugou.com/tracker/v5/url (pid=411, cmd=26, behavior=play, module_id=51, clientver=11561) → 完整音频直链。
 */

import crypto from 'node:crypto';
import { createLogger } from '../../logger.ts';
import { getSetting } from '../../db/repo/settings.ts';
import { getKugouDevice, ensureDfid, markKugouCredentialInvalid } from '../../services/kugou-login.ts';
import { ensureKugouCheckin, isKugouCheckedInToday } from '../../services/kugou-checkin.ts';
import {
  APPID_LITE,
  CLIENTVER_LITE,
  SIGN_SALT_LITE,
  UA_LITE,
  kugouCoverUrl,
  kugouSearchSongs,
  type KugouTrack,
} from './source.ts';
import type { ResolveInput, ResolveResult } from '../bilibili/stream.ts';

const log = createLogger('kugou:stream');

const KEY_SIGN_SALT = '185672dd44712f60bb1736df5a377e82';

export interface KugouCreds {
  token: string;
  userid: string;
  vipToken?: string;
  vipType?: string;
  t1?: string;
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

function resolveIdentity(creds: KugouCreds, dfidOverride?: string): { mid: string; dfid: string; guid: string } {
  const dev = getKugouDevice();
  const guid = creds.guid || dev.guid;
  const mid = creds.mid || dev.mid;
  const dfid = dfidOverride || creds.dfid || dev.dfid || '-';
  return { mid, dfid, guid };
}

function buildCommonLiteParams(
  extra: Record<string, string>,
  creds: KugouCreds,
  dfidOverride?: string,
  body = '',
): Record<string, string> {
  const { mid, dfid } = resolveIdentity(creds, dfidOverride);
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
  creds: KugouCreds,
  dfidOverride?: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const { mid, dfid } = resolveIdentity(creds, dfidOverride);
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

/**
 * 判断酷狗给的直链是不是完整音频。
 */
async function estimateCoverage(url: string, bitrate: number, expectedSec: number): Promise<boolean> {
  if (expectedSec <= 0 || bitrate <= 0) return true;
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA_LITE }, signal: AbortSignal.timeout(6_000) });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (!len) return true;
    const sec = (len * 8) / (bitrate * 1000);
    return sec >= expectedSec * 0.7;
  } catch {
    return true;
  }
}

export function getKugouCreds(): KugouCreds | null {
  return readCreds();
}

function readCreds(): KugouCreds | null {
  const raw = getSetting('kugou.credentials');
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<KugouCreds>;
    if (!p.token || !p.userid) return null;
    return {
      token: String(p.token),
      userid: String(p.userid),
      vipToken: p.vipToken,
      vipType: p.vipType,
      t1: p.t1,
      guid: p.guid,
      mid: p.mid,
      dfid: p.dfid,
    };
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

// ---------- Step 1: /v1/user_verify 缓存与获取 ----------

let cachedUserAuth: { key: string; auth: string; expiresAt: number } | null = null;

async function fetchUserVerifyAuth(creds: KugouCreds, dfid: string, forceRefresh = false): Promise<string> {
  const { mid } = resolveIdentity(creds, dfid);
  const cacheKey = `${creds.userid}|${creds.token}|${mid}`;
  if (!forceRefresh && cachedUserAuth && cachedUserAuth.key === cacheKey && cachedUserAuth.expiresAt > Date.now()) {
    return cachedUserAuth.auth;
  }

  const params = buildCommonLiteParams({ module_id: '51' }, creds, dfid);
  const res = await fetch(`http://gateway.kugou.com/v1/user_verify?${new URLSearchParams(params)}`, {
    method: 'GET',
    headers: buildLiteHeaders(creds, dfid, { 'x-router': 'trackercdngz.kugou.com' }),
    signal: AbortSignal.timeout(8_000),
  });
  const j: any = await res.json();
  const errCode = Number(j?.error_code ?? j?.errcode ?? 0);
  if (errCode === 35005 || errCode === 20018) {
    cachedUserAuth = null;
    markKugouCredentialInvalid(`user_verify 拒绝 (${errCode})：酷狗授权已过期`);
    throw new Error('酷狗授权已过期，请在设置→音源授权重新扫码');
  }
  const auth = String(j?.data?.auth ?? '');
  if (j?.status !== 1 || !auth) {
    throw new Error(`user_verify 失败：${JSON.stringify(j).slice(0, 160)}`);
  }
  cachedUserAuth = { key: cacheKey, auth, expiresAt: Date.now() + 5 * 60_000 };
  return auth;
}

// ---------- Step 0: /v2/get_res_privilege/lite 各音质独立 hash 查询 ----------

interface QualityGoods {
  hash: string;
  quality: string;
  bitrate: number;
}

interface PrivilegeInfo {
  albumAudioId: string;
  albumId: string;
  goodsByQuality: Map<string, QualityGoods>;
}

async function fetchPrivilegeInfo(cand: KugouTrack, creds: KugouCreds, dfid: string): Promise<PrivilegeInfo> {
  const goodsByQuality = new Map<string, QualityGoods>();
  // 先用搜索结果自带的 hash 填底，避免 privilege/lite 偶发失败时无 hash 可用
  if (cand.hash) goodsByQuality.set('128', { hash: cand.hash.toLowerCase(), quality: '128', bitrate: 128 });
  if (cand.qualityHashes.hq) goodsByQuality.set('320', { hash: cand.qualityHashes.hq.toLowerCase(), quality: '320', bitrate: 320 });
  if (cand.qualityHashes.sq) goodsByQuality.set('flac', { hash: cand.qualityHashes.sq.toLowerCase(), quality: 'flac', bitrate: 900 });
  if (cand.qualityHashes.super) goodsByQuality.set('high', { hash: cand.qualityHashes.super.toLowerCase(), quality: 'high', bitrate: 1500 });

  let albumAudioId = cand.albumAudioId || '0';
  let albumId = cand.albumId || '0';

  try {
    const bodyObj = {
      appid: Number(APPID_LITE),
      area_code: 1,
      behavior: 'play',
      clientver: Number(CLIENTVER_LITE),
      need_hash_offset: 1,
      relate: 1,
      support_verify: 1,
      resource: [
        {
          type: 'audio',
          page_id: 0,
          hash: cand.hash,
          album_id: Number(cand.albumId) || 0,
          album_audio_id: Number(cand.albumAudioId) || 0,
        },
      ],
      qualities: ['128', '320', 'flac', 'high', 'viper_atmos', 'viper_tape', 'viper_clear'],
    };
    const bodyStr = JSON.stringify(bodyObj);
    const params = buildCommonLiteParams({}, creds, dfid, bodyStr);
    const res = await fetch(`http://media.store.kugou.com/v2/get_res_privilege/lite?${new URLSearchParams(params)}`, {
      method: 'POST',
      headers: buildLiteHeaders(creds, dfid, {
        'Content-Type': 'application/json',
        'x-router': 'media.store.kugou.com',
      }),
      body: bodyStr,
      signal: AbortSignal.timeout(8_000),
    });
    const j: any = await res.json();
    const item = (j?.data ?? [])[0];
    if (item) {
      if (item.album_audio_id) albumAudioId = String(item.album_audio_id);
      if (item.album_id) albumId = String(item.album_id);
      const relateGoods = Array.isArray(item.relate_goods) ? item.relate_goods : [];
      for (const g of relateGoods) {
        const q = String(g?.quality ?? '').toLowerCase();
        const h = String(g?.hash ?? '').toLowerCase();
        if (q && h) {
          const br = Math.round(Number(g?.info?.bitrate ?? 0)) || (q === 'flac' ? 900 : q === '320' ? 320 : 128);
          goodsByQuality.set(q, { hash: h, quality: q, bitrate: br });
        }
      }
    }
  } catch (err) {
    log.debug(`privilege/lite 查询失败 (${cand.id})，回退搜索自带 hash：${(err as Error).message}`);
  }

  return { albumAudioId, albumId, goodsByQuality };
}

// ---------- Step 2 & Step 3: /v1/authorization → /tracker/v5/url ----------

async function fetchPlayUrlWithAuth(
  qualityHash: string,
  albumId: string,
  albumAudioId: string,
  quality: string,
  userAuth: string,
  creds: KugouCreds,
  dfid: string,
  options?: { preferMp3?: boolean },
): Promise<{ url: string | null; bitrate: number; timeLength: number }> {
  const { mid } = resolveIdentity(creds, dfid);

  // Step 2: 单曲授权 /v1/authorization
  const authParams = buildCommonLiteParams(
    {
      authorization: userAuth,
      module_id: '51',
      album_audio_id: String(Number(albumAudioId) || 0),
      clientver: '11561',
      hash: qualityHash,
    },
    creds,
    dfid,
  );
  const authRes = await fetch(`http://gateway.kugou.com/v1/authorization?${new URLSearchParams(authParams)}`, {
    method: 'GET',
    headers: buildLiteHeaders(creds, dfid, { 'x-router': 'trackercdngz.kugou.com' }),
    signal: AbortSignal.timeout(8_000),
  });
  const authJson: any = await authRes.json();
  const songAuth = String(authJson?.data?.auth ?? '');
  const openTime = authJson?.data?.open_time;
  if (authJson?.status !== 1 || !songAuth || openTime === undefined) {
    return { url: null, bitrate: 0, timeLength: 0 };
  }

  // Step 3: 授权取流 /tracker/v5/url
  const key = md5(`${qualityHash}${KEY_SIGN_SALT}${APPID_LITE}${mid}${creds.userid}`);
  const trackerParams = buildCommonLiteParams(
    {
      album_id: String(albumId || '0'),
      area_code: '1',
      module: '',
      hash: qualityHash,
      need_m: '0',
      ssa_flag: 'is_fromtrack',
      version: '11430',
      open_time: String(openTime),
      ptype: '0',
      need_ogg: options?.preferMp3 ? '0' : '1',
      page_id: '967177915',
      auth: songAuth,
      mtype: '0',
      quality,
      album_audio_id: String(Number(albumAudioId) || 0),
      behavior: 'play',
      pid: '411',
      module_id: '51',
      cmd: '26',
      ppage_id: '356753938,823673182,967485191',
      clientver: '11561',
      pidversion: '3001',
      cdnBackup: '1',
      key,
    },
    creds,
    dfid,
  );

  const trackerRes = await fetch(`https://gateway.kugou.com/tracker/v5/url?${new URLSearchParams(trackerParams)}`, {
    method: 'GET',
    headers: buildLiteHeaders(creds, dfid),
    signal: AbortSignal.timeout(8_000),
  });
  const trackerJson: any = await trackerRes.json();
  const url = Array.isArray(trackerJson?.url) && trackerJson.url[0] ? String(trackerJson.url[0]) : null;
  const rawBr = Number(trackerJson?.bitRate ?? 0);
  const bitrate = rawBr > 1000 ? Math.round(rawBr / 1000) : rawBr || (quality === 'flac' ? 900 : quality === '320' ? 320 : 128);
  const timeLength = Number(trackerJson?.timeLength ?? 0);
  return { url, bitrate, timeLength };
}

/**
 * 音质取值顺序：从高到低依次尝试（概念 VIP 可直接命中 flac/high/320，畅听 VIP 自动回落 128 完整版）。
 */
const QUALITY_ORDER = ['flac', 'high', '320', '128'] as const;


/** 已落库的酷狗播放凭证（搜索时随元数据一起存下，点播时直接取流，0 次二次搜索） */
export interface KugouStoredMeta {
  name: string;
  artists?: string[];
  hash: string;
  qualityHashes?: { hq?: string; sq?: string; super?: string };
  albumId?: string;
  albumAudioId: string;
  durationSec?: number;
  coverTemplate?: string;
}

/**
 * 直取流：元数据里已经带着 hash / albumId / albumAudioId 时，跳过搜索直接走授权链。
 *
 * 为什么值得单独一条路：酷狗搜索结果本身带齐播放凭证，只要搜索时把它存进 tracks，
 * 点播就不必再按「歌名+歌手」搜一次 —— 少一次上游请求，也少一次错配机会。
 * 取流判定（试听片段识别、音质降级、封面兜底）复用 streamFirstPlayable，只有一份实现。
 */
export async function resolveKugouDirect(
  meta: KugouStoredMeta,
  options?: { preferMp3?: boolean },
): Promise<ResolveResult> {
  const creds = readCreds();
  if (!creds) return fail('below_threshold', '未授权酷狗（需要概念版 VIP 授权）');
  if (!meta.hash || !meta.albumAudioId) return fail('no_candidates', '缺少酷狗播放凭证');

  const cand: KugouTrack = {
    id: 'kg_' + String(meta.albumAudioId),
    hash: meta.hash,
    albumAudioId: String(meta.albumAudioId),
    albumId: String(meta.albumId ?? '0'),
    name: meta.name,
    singers: (meta.artists ?? []).map((n: string) => ({ name: n })),
    albumName: '',
    durationSec: meta.durationSec ?? 0,
    qualityHashes: meta.qualityHashes ?? {},
    privilege: 0,
    payType: 0,
    coverTemplate: meta.coverTemplate ?? '',
    // 直取路径不参与零翻唱过滤（曲目已落库，说明搜索阶段已通过）
    isOriginal: true,
    singerIds: [],
  };

  const dfid = await ensureDfid();
  let userAuth: string;
  try {
    userAuth = await fetchUserVerifyAuth(creds, dfid);
  } catch (err) {
    return fail('rejected', (err as Error).message);
  }

  const hit = await streamFirstPlayable([cand], cand.durationSec, creds, dfid, userAuth, options);
  return hit ?? fail('below_threshold', '酷狗直取无可播音质');
}

/**
 * 依次尝试候选，返回第一个能拿到「非试听片段」直链的结果。
 *
 * 抽成独立函数是为了让**直取流**（已存 hash，跳过搜索）复用同一段判定逻辑 ——
 * 试听片段识别、音质降级顺序、封面兜底都只在这里维护一份。
 */
async function streamFirstPlayable(
  candidates: KugouTrack[],
  durTarget: number,
  creds: KugouCreds,
  dfid: string,
  userAuth: string,
  options?: { preferMp3?: boolean },
): Promise<ResolveResult | null> {
  const qualityOrder = options?.preferMp3
    ? (['320', '128'] as const)
    : QUALITY_ORDER;

  for (const cand of candidates) {
    const priv = await fetchPrivilegeInfo(cand, creds, dfid);

    for (const quality of qualityOrder) {
      const goods = priv.goodsByQuality.get(quality);
      if (!goods || !goods.hash) continue;

      try {
        const { url, bitrate, timeLength } = await fetchPlayUrlWithAuth(
          goods.hash,
          priv.albumId,
          priv.albumAudioId,
          quality,
          userAuth,
          creds,
          dfid,
          options,
        );
        if (!url) continue;

        // 校验是否为试听片段：优先用 tracker 返回的 timeLength，缺失时用 HEAD Content-Length 兜底
        const expectedSec = cand.durationSec > 0 ? cand.durationSec : durTarget;
        if (expectedSec > 90 && timeLength > 0 && timeLength < expectedSec * 0.7) {
          log.warn(`酷狗仅返回试听片段（${cand.id}/${quality} timeLength=${timeLength}s < ${expectedSec}s），跳过`);
          continue;
        }
        if (timeLength <= 0) {
          const covered = await estimateCoverage(url, bitrate || goods.bitrate, expectedSec);
          if (!covered) {
            log.warn(`酷狗仅返回试听片段（${cand.id}/${quality}），跳过`);
            continue;
          }
        }

        const actualSec = timeLength > 0 ? timeLength : cand.durationSec;
        log.info(
          `酷狗命中 ${cand.id} 「${cand.name}」${quality}@${bitrate || goods.bitrate}kbps ` +
            `时长=${actualSec}s 时长差=${durTarget > 0 ? Math.abs(actualSec - durTarget) : 0}s`,
        );
        return {
          ok: true,
          bvid: null,
          sourceUrl: url,
          score: 100,
          source: 'kugou',
          matchedTitle: cand.name,
          matchedAuthor: cand.singers.map(s => s.name).join('/'),
          matchedDurationSec: actualSec,
          durationDiff: durTarget > 0 ? Math.abs(actualSec - durTarget) : 0,
          coverUrl: cand.coverTemplate ? kugouCoverUrl(cand.coverTemplate) : undefined,
        };
      } catch (err) {
        log.warn(`取流失败 ${cand.id}/${quality}：${(err as Error).message}`);
      }
    }
  }
  return null;
}

export async function resolveKugouSource(
  track: ResolveInput,
  options?: { preferMp3?: boolean },
): Promise<ResolveResult> {
  const creds = readCreds();
  if (!creds) return fail('below_threshold', '未授权酷狗（需要概念版 VIP 授权）');

  const name = String(track.name ?? '').trim();
  if (!name) return fail('no_candidates', '曲目无名');

  const artist = (track.artists ?? [])[0] ?? '';
  const keyword = artist ? name + ' ' + artist : name;

  let rows: KugouTrack[];
  try {
    rows = await kugouSearchSongs(keyword, 30, creds);
  } catch (err) {
    return fail('rejected', '搜索失败：' + (err as Error).message);
  }
  if (!rows.length) return fail('no_candidates', '搜索无结果（' + keyword + '）');

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[()（）[\]【】]/g, '');
  const VERSION_RE = /(live|现场|演唱会|dj|翻唱|cover|纯音乐|伴奏|remix|版|钢琴|吉他|合唱|片段)/i;
  const target = norm(name);
  const durTarget = Math.round((track.durationMs ?? 0) / 1000);

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

  const strict = rows.filter(r => norm(r.name) === target && artistHit(r));
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

  // 取流前兜底：若今日尚未完成畅听签到 + 概念 SVIP 升级，先自动补签以解锁 320k/FLAC
  if (!isKugouCheckedInToday(creds.userid)) {
    await ensureKugouCheckin().catch(err =>
      log.warn(`取流前自动签到失败：${(err as Error)?.message ?? String(err)}`),
    );
  }

  const dfid = await ensureDfid();
  let userAuth: string;
  try {
    userAuth = await fetchUserVerifyAuth(creds, dfid);
  } catch (err) {
    return fail('rejected', (err as Error).message);
  }

  const hit = await streamFirstPlayable(
    scored.slice(0, 6).map(e => e.r),
    durTarget,
    creds,
    dfid,
    userAuth,
    options,
  );
  return hit ?? fail('below_threshold', '候选均无可播音质');
}
