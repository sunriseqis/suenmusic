/**
 * 更新产物（release asset）的多镜像自动择优。
 *
 * 为什么只作用于产物下载、不动 API：
 *   · API（列 release）是几 KB 的小请求，现在的代理 2 秒能回，够用；
 *   · 62 MB 的 .fpk 走代理实测只有 31~52 KB/s（30 分钟级），必然中途断 —— 而 release 资产
 *     在公开镜像上是直连可下的（实测 ghfast.top 单流 1.8 MB/s）。
 *
 * 为什么不硬编码一个镜像：这类站点是限时免费、随时失效，今天最快的明天可能挂。
 * 所以每次下载前先并发探活测速，取响应最快的那条；失败自动换下一条。
 * 候选池默认内置 80 个（来自 github.akams.cn 前端节点表），可用
 * SUENMUSIC_UPDATE_MIRRORS=host1,host2 覆盖。
 *
 * ⚠️ 镜像只用于下载，且下游必须做 sha256 校验（verifySha256）——
 * 第三方镜像不经我们控制，只校验文件大小是不够的。
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createLogger } from '../logger.ts';

const log = createLogger('update-mirror');

/** 直连（空串）也是候选之一：镜像全挂时它还在 */
export const DIRECT_PREFIX = '';

/** 内置候选池（仅主机名，实际请求时补 https:// 前缀） */
const DEFAULT_MIRROR_HOSTS: readonly string[] = [
  'ghfast.top',
  'gh-proxy.com',
  'cdn.gh-proxy.com',
  'ghproxy.net',
  'ghproxy.cc',
  'ghproxy.icu',
  'ghpr.cc',
  'gh.dpik.top',
  'github.dpik.top',
  'gh.ddlc.top',
  'gh.catmak.name',
  'gh.b52m.cn',
  'gh.jasonzeng.dev',
  'github.tbap.top',
  'github.starllzy.cn',
  'github.geekery.cn',
  'github.chenc.dev',
  'github.ednovas.xyz',
  'github.gohj99.site',
  'githubproxy.gohj99.site',
  'github.nswrz.cn',
  'github.tmby.shop',
  'github.xxlab.tech',
  'githubdog.com',
  'gitproxy.click',
  'gitproxy.mrhjx.cn',
  'gitproxy.127731.xyz',
  'git.669966.xyz',
  'git.yylx.win',
  'ghp.arslantu.xyz',
  'ghp.keleyaa.com',
  'ghpxy.hwinzniej.top',
  'ghm.078465.xyz',
  'gh.927223.xyz',
  'gh.07150721.xyz',
  'gh.acmsz.top',
  'gh.beimengvv.xyz',
  'gh.bugdey.us.kg',
  'gh.chjina.com',
  'gh.felicity.ac.cn',
  'gh.idayer.com',
  'gh.inkchills.cn',
  'gh.jjj.gv.uy',
  'gh.meali.top',
  'gh.monlor.com',
  'gh.noki.icu',
  'gh.ruan.dpdns.org',
  'gh.sixyin.com',
  'gh.tryxd.cn',
  'gh.zhai.edu.pl',
  'ghgo.de5.net',
  'g.blfrp.cn',
  'gap.andyjin.website',
  'ghfile.geekertao.top',
  'cfgh.ikgy.top',
  'github.ikgy.top',
  'free.cn.eu.org',
  'fastgit.cc',
  'slink.ltd',
  'tvv.tw',
  'jiashu.1win.eu.org',
  'j.1lin.dpdns.org',
  'j.1win.ggff.net',
  'js.jiangss.shop',
  'gp.zkitefly.eu.org',
  'proxy.yaoyaoling.net',
  'xsadwds.kdns.fr',
  'down.mxw.qzz.io',
  'github.mxw.qzz.io',
  '777.z321.cc.cd',
  'g.z321.cc.cd',
  'gg.z321.cc.cd',
  'gh.qfmc0721.cc.cd',
  'ghproxy.cxkpro.top',
  'ghproxy.1888866.xyz',
  'ghproxy.felicity.land',
  'ghproxy.monkeyray.net',
  'cdn.akaere.online',
  'github-cf.947563.xyz',
  'github-proxy.memory-echoes.cn',
];

/** 探活采样字节数：够判断吞吐，又不必为了测速把整包下一遍 */
const PROBE_BYTES = 256 * 1024;
/** 单个镜像探活超时 */
const PROBE_TIMEOUT_MS = 4_000;
/** 探活并发：太大互相挤带宽，测出来的数不可比 */
const PROBE_CONCURRENCY = 10;
/** 二阶段精测：取粗筛前几名、用更大样本顺序复测，排序才可信 */
const REFINE_TOP = 4;
const REFINE_BYTES = 1024 * 1024;
const REFINE_TIMEOUT_MS = 20_000;
/** 择优结果缓存时长（同一资产重复刷新时不重复探活） */
const RANK_TTL_MS = 10 * 60_000;

export interface MirrorProbe {
  prefix: string;
  ok: boolean;
  ttfbMs: number | null;
  kbps: number;
  bytes: number;
  error?: string;
}

/** 候选镜像前缀列表：env 覆盖优先，永远包含直连 */
export function mirrorCandidates(env: string | undefined = process.env.SUENMUSIC_UPDATE_MIRRORS): string[] {
  const raw = String(env ?? '').trim();
  const hosts = raw
    ? raw.split(/[,\s]+/).map(h => h.trim()).filter(Boolean)
    : [...DEFAULT_MIRROR_HOSTS];
  const normalized = hosts.map(h => {
    const withScheme = /^https?:\/\//i.test(h) ? h : 'https://' + h;
    return withScheme.replace(/\/+$/, '');
  });
  return [DIRECT_PREFIX, ...new Set(normalized)];
}

/** 镜像前缀 + 原始资产地址 → 实际请求地址（这类镜像都是 host/原始URL 形式） */
export function mirrorUrl(prefix: string, url: string): string {
  if (!prefix) return url;
  return prefix.replace(/\/+$/, '') + '/' + url;
}

/** 按可用性与吞吐排序（ok 优先，其次 kbps，最后 ttfb） */
export function rankByProbe(list: readonly MirrorProbe[]): MirrorProbe[] {
  return [...list].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (b.kbps !== a.kbps) return b.kbps - a.kbps;
    return (a.ttfbMs ?? Number.MAX_SAFE_INTEGER) - (b.ttfbMs ?? Number.MAX_SAFE_INTEGER);
  });
}

/** 探一个镜像：拿首 512 KB，量首字节与吞吐 */
export async function probeMirror(
  prefix: string,
  url: string,
  opts: { bytes?: number; timeoutMs?: number; dispatcher?: unknown } = {},
): Promise<MirrorProbe> {
  const bytes = opts.bytes ?? PROBE_BYTES;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let ttfbMs: number | null = null;
  let got = 0;
  try {
    const res = await fetch(mirrorUrl(prefix, url), {
      headers: { Range: 'bytes=0-' + (bytes - 1), 'User-Agent': 'suenmusic-server', Accept: '*/*' },
      signal: ctl.signal,
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
    } as never);
    if (!res.ok && res.status !== 206) {
      return { prefix, ok: false, ttfbMs: null, kbps: 0, bytes: 0, error: 'HTTP ' + String(res.status) };
    }
    if (!res.body) {
      return { prefix, ok: false, ttfbMs: null, kbps: 0, bytes: 0, error: 'no body' };
    }
    for await (const chunk of Readable.fromWeb(res.body as never)) {
      if (ttfbMs === null) ttfbMs = Date.now() - started;
      got += (chunk as Uint8Array).length;
      if (got >= bytes) break;
    }
    /**
     * 吞吐只算「首字节之后」的那段时间。
     * 用总耗时（含握手）会系统性低估快镜像：512 KB 在 1.8 MB/s 下只需 0.28s，
     * 但握手可能要 0.6~1s —— 那样 1.8 MB/s 的镜像会被算成 400 KB/s，排序就错。
     */
    const totalMs = Date.now() - started;
    const transferMs = Math.max(50, totalMs - (ttfbMs ?? totalMs));
    return { prefix, ok: got > 0, ttfbMs, kbps: Math.round(got / 1024 / (transferMs / 1000)), bytes: got };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      prefix,
      ok: false,
      ttfbMs: null,
      kbps: 0,
      bytes: got,
      error: e?.name === 'AbortError' ? 'timeout' : (e?.message ?? 'error'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 并发探活所有候选并按快慢排序 */
export async function probeMirrors(
  url: string,
  opts: { bytes?: number; timeoutMs?: number; concurrency?: number } = {},
): Promise<MirrorProbe[]> {
  const candidates = mirrorCandidates();
  const concurrency = Math.max(1, opts.concurrency ?? PROBE_CONCURRENCY);
  const queue = candidates.slice();
  const out: MirrorProbe[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const prefix = queue.shift();
      if (prefix === undefined) return;
      out.push(await probeMirror(prefix, url, opts));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  return rankByProbe(out);
}

const rankCache = new Map<string, { at: number; list: MirrorProbe[] }>();

/** 某个资产地址的镜像排序（10 分钟缓存，force 可强制重测） */
export async function rankMirrorsFor(
  url: string,
  opts: { force?: boolean } = {},
): Promise<MirrorProbe[]> {
  const hit = rankCache.get(url);
  if (!opts.force && hit && Date.now() - hit.at < RANK_TTL_MS) return hit.list;
  /**
   * 两阶段择优：
   *   ① 并发粗筛（512 KB / 10 并发）—— 只要挑出「活着且不慢」的那批，27 秒左右；
   *   ② 对前 REFINE_TOP 名再**顺序**精测（2 MB）—— 顺序测不会互相抢带宽，样本更大，
   *      排序才可信。用户要的是「取响应最快的那条」，粗筛的数字不足以做最终判定。
   */
  const coarse = await probeMirrors(url);
  const heads = coarse.filter(x => x.ok).slice(0, REFINE_TOP);
  const refined: MirrorProbe[] = [];
  for (const h of heads) {
    refined.push(await probeMirror(h.prefix, url, { bytes: REFINE_BYTES, timeoutMs: REFINE_TIMEOUT_MS }));
  }
  const headSet = new Set(heads.map(h => h.prefix));
  const list = rankByProbe([...refined, ...coarse.filter(x => !headSet.has(x.prefix))]);
  rankCache.set(url, { at: Date.now(), list });
  lastRanked = list.filter(x => x.ok && x.prefix).map(x => x.prefix).slice(0, 8);
  const usable = list.filter(x => x.ok).length;
  log.info('镜像探活完成：' + usable + '/' + list.length + ' 可用，最快 ' + (list[0]?.prefix || '直连') + '（' + (list[0]?.kbps ?? 0) + ' KB/s）');
  return list;
}

/** 最近一次择优出的可用镜像（按快慢），供 API 兜底复用，避免为 API 再扫一遍 */
let lastRanked: string[] = [];

/** 最近一次择优结果（同步读，可能为空） */
export function lastRankedPrefixes(): string[] {
  return lastRanked;
}

/**
 * GitHub **API** 的出口候选顺序（HTTP 代理出站已废弃，改为直连 + 镜像）。
 *
 * 顺序：配置的 API 基地址 → 官方 api.github.com → 最近择优过的镜像 → 内置候选池，
 * 去重后截断到 limit。调用方需要**校验响应是 JSON 数组**：有些镜像对任何路径都回 "ok"。
 */
export function apiCandidates(
  opts: { configuredBase?: string; ranked?: readonly string[]; limit?: number } = {},
): string[] {
  const base = String(opts.configuredBase || 'https://api.github.com').replace(/\/+$/, '');
  const ordered: string[] = [base, 'https://api.github.com'];
  for (const p of opts.ranked ?? []) ordered.push(p);
  for (const p of mirrorCandidates().slice(1)) ordered.push(p);
  const out: string[] = [];
  for (const p of ordered) if (!out.includes(p)) out.push(p);
  return out.slice(0, Math.max(2, opts.limit ?? 12));
}

export function resetMirrorRankCache(): void {
  rankCache.clear();
  lastRanked = [];
}

/** 校验 sha256；返回实际值，调用方自行比较 */
export function sha256Of(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export { DEFAULT_MIRROR_HOSTS };


/** 空闲超时：收不到数据就换镜像（不用总时长限制，大文件本来就慢） */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
/** 吞吐下限（KB/s）与宽限期：慢但不停也要换更快的镜像 */
const DEFAULT_MIN_KBPS = 100;
const DEFAULT_GRACE_MS = 15_000;

/**
 * 用最快的镜像下载资产，失败自动换下一条。
 *
 * 设计要点：
 *   1. 断点续传：.part 已存在就用 Range: bytes=<已有>- 续，断了不从 0 开始；
 *   2. 失败换源：超时 / HTTP 错误 / 大小不符 / sha256 不符 → 换下一条继续；
 *   3. 空闲超时：只看多久没收到新字节（轮询 .part 体积），不设总时长；
 *   4. 直连（空前缀）复用调用方给的 dispatcher（即现有代理），镜像一律直连。
 */
export async function downloadWithMirrors(
  url: string,
  destPath: string,
  opts: {
    expectedSize?: number;
    sha256?: string | null;
    dispatcher?: unknown;
    idleTimeoutMs?: number;
    /** 吞吐下限：跑够 graceMs 后均速仍低于它就换镜像（默认 100 KB/s） */
    minKbps?: number;
    /** 判定吞吐下限前的宽限期（默认 15s，避免握手期被误杀） */
    graceMs?: number;
  } = {},
): Promise<{ prefix: string; bytes: number; kbps: number; attempts: number }> {
  const ranked = await rankMirrorsFor(url);
  // 探活成功的排前面；探活失败的也留作兜底（探活失败不等于下载一定失败）
  const order = [...ranked.filter(x => x.ok), ...ranked.filter(x => !x.ok)];
  const part = destPath + '.part';
  const started = Date.now();
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const minKbps = opts.minKbps ?? DEFAULT_MIN_KBPS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  let lastError = 'unknown';
  let attempts = 0;

  for (const candidate of order) {
    attempts += 1;
    const prefix = candidate.prefix;
    const label = prefix || '直连';
    const target = mirrorUrl(prefix, url);
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    /** 抓两种切换条件：① 空闲（收不到字节）② 慢但不停（均速低于下限） */
    let abortedForSpeed = false;
    try {
      const resumeFrom = existsSync(part) ? statSync(part).size : 0;
      const headers: Record<string, string> = {
        Range: 'bytes=' + String(Math.max(0, resumeFrom)) + '-',
        'User-Agent': 'suenmusic-server',
        Accept: '*/*',
      };
      const ctl = new AbortController();
      const channelStartedAt = Date.now();
      let lastSeen = -1;
      idleTimer = setInterval(() => {
        const sizeNow = existsSync(part) ? statSync(part).size : 0;
        // ① 空闲：一整个窗口没有新字节 → 卡死，换镜像
        if (sizeNow <= lastSeen) {
          ctl.abort();
          return;
        }
        lastSeen = sizeNow;
        // ② 慢但不停：过了宽限期均速仍低于下限 → 主动换条更快的（这是「取最快的镜像」的正解）
        const elapsedSec = (Date.now() - channelStartedAt) / 1000;
        if (elapsedSec * 1000 >= graceMs && sizeNow / 1024 / elapsedSec < minKbps) {
          abortedForSpeed = true;
          ctl.abort();
        }
      }, Math.min(5_000, idleMs));
      const res = await fetch(target, {
        headers,
        signal: ctl.signal,
        ...(prefix === DIRECT_PREFIX && opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      } as never);
      if (!res.ok || !res.body) throw new Error('HTTP ' + String(res.status));
      const appendMode = res.status === 206 && resumeFrom > 0;
      const sink = createWriteStream(part, { flags: appendMode ? 'a' : 'w' });
      await pipeline(Readable.fromWeb(res.body as never), sink);
      const bytes = statSync(part).size;
      if (typeof opts.expectedSize === 'number' && opts.expectedSize > 0 && bytes !== opts.expectedSize) {
        throw new Error('大小不符：期望 ' + String(opts.expectedSize) + '，实际 ' + String(bytes));
      }
      renameSync(part, destPath);
      if (opts.sha256) {
        const actual = sha256Of(destPath);
        if (actual !== opts.sha256.toLowerCase()) {
          rmSync(destPath, { force: true });
          throw new Error('sha256 不符');
        }
      }
      const kbps = Math.round(bytes / 1024 / Math.max(0.05, (Date.now() - started) / 1000));
      log.info(
        '资产下载完成（' + label + '）：' + String(Math.round(bytes / 1024 / 1024)) +
          ' MB，均速 ' + String(kbps) + ' KB/s，第 ' + String(attempts) + ' 个候选',
      );
      return { prefix, bytes, kbps, attempts };
    } catch (err) {
      lastError = abortedForSpeed
        ? '吞吐低于 ' + String(minKbps) + ' KB/s，主动换更快镜像'
        : ((err as Error)?.message ?? String(err));
      log.warn('镜像下载失败（' + label + '）：' + lastError + '，换下一条');
    } finally {
      if (idleTimer) clearInterval(idleTimer);
    }
  }
  throw new Error('所有镜像均失败：' + lastError);
}

