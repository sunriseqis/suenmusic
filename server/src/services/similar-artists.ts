/**
 * 相似歌手（歌手页底部「相似歌手」区）。
 *
 * 数据链路与每日推荐的相似歌手支路完全一致（QQ 名 → 网易云 artistid
 * → simi_artist → 相似歌手名 → 回 QQ 搜出 mid），只是不做歌曲召回：
 * 歌手页只要"能跳转的歌手卡片"。
 *
 * 每一步都是尽力而为：网易云没登录/被风控就返回空数组，让前端整节隐藏，
 * 绝不让它把歌手页搞挂 —— 歌单/曲目才是歌手页的主内容。
 */

import { createLogger } from '../logger.ts';
import { fetchSearchSlice } from '../sources/qq/search.ts';
import { netease, neteaseRequest } from '../sources/netease/vendor.ts';
import { Cooldown } from '../utils/backoff.ts';
import { getDatabase } from '../db/index.ts';

const log = createLogger('similar-artists');

/** 最多返回几位相似歌手。每位都要一次 QQ 搜索换 mid，8 位是收益与风控的平衡 */
const MAX_SIMI = 8;

/** 简易规范化：去空白/大小写，供歌手名比对 */
const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

export interface SimilarArtist {
  /** QQ 歌手 mid，客户端拼 `qq_ar_` 路由键 */
  id: string;
  name: string;
}

/**
 * 网易云冷却。实测教训：相似歌手这条链原本**完全不读缓存** ——
 * 一次调用 = 1 次网易云搜索 + 1 次相似歌手 + 每个邻居一次 QQ 搜索（80 个！），
 * 10 位种子就是几百次上游请求，直接把 QQ（2001）和网易云（405 操作频繁）都打崩。
 */
export const neteaseCooldown = new Cooldown('netease', {
  baseMs: 60_000,
  maxMs: 30 * 60_000,
});

/** 相似歌手缓存（永久）：名字层面对齐 ai-recall 的 artist_simi_cache 表 */
function cacheGet(name: string): string[] | null {
  try {
    const row = getDatabase()
      .prepare('SELECT names_json FROM artist_simi_cache WHERE name = ?')
      .get(name) as { names_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.names_json) as string[];
  } catch {
    return null;
  }
}

function cachePut(name: string, names: string[]): void {
  try {
    getDatabase()
      .prepare(
        `INSERT INTO artist_simi_cache (name, names_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET names_json = excluded.names_json, updated_at = excluded.updated_at`
      )
      .run(name, JSON.stringify(names), Date.now());
  } catch {
    /* 缓存写失败无所谓 */
  }
}

/** 把上游错误打成能读懂的一行（实测 err.message 常是 undefined，真因在 body.msg） */
function errText(err: unknown): string {
  const e = err as Record<string, unknown>;
  const body = e?.body as Record<string, unknown> | undefined;
  const msg = body?.msg ?? body?.message ?? e?.message;
  const status = e?.status;
  return status ? `${status} ${String(msg ?? '')}` : String(msg ?? err);
}

/** QQ 歌手名 → 网易云 artistid（名字规范化后必须相等，防止"周深/周深深"错配） */
async function neteaseArtistIdOf(qqName: string): Promise<number | null> {
  try {
    const res = await netease.search({ keywords: qqName, type: 100, limit: 5 }, neteaseRequest);
    const artists = ((res?.body as any)?.result?.artists ?? []) as Array<{
      id: number;
      name: string;
    }>;
    const hit = artists.find(a => norm(a.name) === norm(qqName));
    neteaseCooldown.reset();
    return hit ? Number(hit.id) : null;
  } catch (err) {
    neteaseCooldown.trip('网易云限流');
    log.warn(`网易云歌手搜索失败 ${qqName}: ${errText(err)}`);
    return null;
  }
}

/** QQ 侧按歌手名搜路由键（search_type=1 分片） */
async function qqArtistMidOf(name: string): Promise<string | null> {
  try {
    const { list } = await fetchSearchSlice('singer', name, 0, 5);
    const hit = list.find((a: any) => norm(a?.singerName ?? a?.name) === norm(name));
    return hit ? String(hit.singerMID ?? hit.mid ?? '') || null : null;
  } catch (err) {
    log.warn(`QQ 歌手搜索失败 ${name}: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/**
 * 取某位歌手的相似歌手。
 *
 * @param qqName  当前歌手名（QQ 侧口径）
 * @param exclude 额外要排除的名字（如路由 query 带来的旧名字）；相似结果里
 *                不能出现当前歌手自己 —— 网易云与 QQ 的同名歌手不少。
 */
export async function getSimilarArtists(
  qqName: string,
  exclude = ''
): Promise<SimilarArtist[]> {
  // ⓪ 缓存优先：命中就直接返回名字（mid 留空，调用方需要时再解析）
  const cached = cacheGet(qqName);
  if (cached) {
    const excluded0 = new Set([norm(qqName), norm(exclude)]);
    return cached
      .filter(n => !excluded0.has(norm(n)))
      .slice(0, MAX_SIMI)
      .map(name => ({ id: '', name }));
  }

  // ⓪' 网易云冷却中就跳过（别硬撞 405）
  if (neteaseCooldown.active()) {
    log.info(`网易云冷却中（${Math.round(neteaseCooldown.remainingMs() / 1000)}s），跳过相似歌手查询 ${qqName}`);
    return [];
  }

  const neId = await neteaseArtistIdOf(qqName);
  if (!neId) return [];

  try {
    const res = await netease.simiArtist({ id: neId }, neteaseRequest);
    const artists = ((res?.body as any)?.artists ?? []) as Array<{ name?: string }>;
    const out: SimilarArtist[] = [];
    const excluded = new Set([norm(qqName), norm(exclude)]);

    for (const a of artists) {
      const name = String(a?.name ?? '').trim();
      if (!name || excluded.has(norm(name))) continue;
      const mid = await qqArtistMidOf(name);
      if (!mid) continue;
      out.push({ id: mid, name });
      if (out.length >= MAX_SIMI) break;
    }
    // 落缓存（名字层面）：下次直接命中，不再打上游
    cachePut(
      qqName,
      out.map(o => o.name)
    );
    neteaseCooldown.reset();
    return out;
  } catch (err) {
    neteaseCooldown.trip('网易云限流');
    log.warn(`相似歌手查询失败 id=${neId}: ${errText(err)}`);
    return [];
  }
}
