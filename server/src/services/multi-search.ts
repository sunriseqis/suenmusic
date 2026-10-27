/**
 * 多源单曲搜索聚合（Step 2 第一片）。
 *
 * 目标（用户 2026-10-26 定稿）：
 *   1. **零翻唱**：只放行官方原唱（酷狗 `IsOriginal === 1`），并清洗器乐/DJ/伴奏/翻唱变种；
 *   2. **元数据即播放源**：酷狗条目自带 hash，转成 `kg_<albumAudioId>` 落库后点播 0 次二次搜索；
 *   3. **限流兜底**：酷狗搜索异常/空结果时回落 QQ（保留门面数据可用性）。
 *
 * 尚未接入：网易云并发辅源（`/api/cloudsearch/pc` + `originCoverType === 1`）。
 * 它是「酷狗没有、只有网易云有」的独有原唱（如《知我》）唯一来源，下一片补。
 */

import { createLogger } from '../logger.ts';
import { kugouSearchSongs, kugouTrackToTrack } from '../sources/kugou/source.ts';
import { searchQQ, QQ_SEARCH_TYPE } from '../sources/qq/search.ts';
import type { Track } from '../sources/qq/adapter.ts';
import { upsertTracks } from '../db/repo/tracks.ts';

const log = createLogger('multi-search');

/** 变种/翻唱清洗：这些词命中的条目一律不当作原唱（Live 单独处理） */
const VARIANT_RE = /(伴奏|纯音乐|钢琴|吉他|器乐|dj|慢摇|变速|remix|片段|消音|和声|翻唱|cover)/i;
/** 原唱本人的官方 Live：保留但排在录音室原版之后 */
const LIVE_RE = /(live|现场|演唱会)/i;

/** 常见异体/简繁差异归一，否则「夏日入侵企划」搜不到「夏日入侵企画」 */
const VARIANT_CHARS: Array<[RegExp, string]> = [
  [/企画/g, '企划'],
  [/計画/g, '计划'],
  [/飛/g, '飞'],
  [/陳/g, '陈'],
];

function norm(s: string): string {
  let out = s.toLowerCase().replace(/\s+/g, '').replace(/[()（）[\]【】]/g, '');
  for (const [re, to] of VARIANT_CHARS) out = out.replace(re, to);
  return out;
}

/** 同曲去重键：歌名 + 是否 Live + 排序后的歌手名（与收藏去重口径一致：不看来源、不看 id） */
function dedupeKey(t: Track): string {
  const live = LIVE_RE.test(t.name) ? '1' : '0';
  const base = norm(t.name.replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, ''));
  const artists = (t.ar ?? [])
    .map(a => norm(a.name))
    .filter(Boolean)
    .sort()
    .join('/');
  return `${base}|${live}|${artists}`;
}

export interface MultiSongsResult {
  songs: Track[];
  /** 酷狗失败/为空而回落 QQ 时为 true */
  degraded: boolean;
  /** 本次实际用到的源 */
  sources: string[];
}

/**
 * 聚合单曲搜索结果。
 *
 * 排序：精确命中（歌名与查询词归一化后相等）置顶，其余按原源排名；同曲去重保留酷狗条目
 * （它带播放凭证，保留 QQ 条目会丢掉「零搜索直取」能力）。
 */
export async function searchSongsMulti(query: string, limit = 20): Promise<MultiSongsResult> {
  const q = query.trim();
  if (!q) return { songs: [], degraded: false, sources: [] };

  const sources: string[] = [];
  let kugouSongs: Track[] = [];

  try {
    const rows = await kugouSearchSongs(q, 30);
    const qNorm = norm(q);
    const original = rows.filter(r => {
      if (VARIANT_RE.test(r.name)) return false;
      // 原唱硬门槛：只放行官方原唱标记；原唱本人的 Live 也放行，但排序靠后
      if (!r.isOriginal) return false;
      // 相关性：歌名或歌手名必须与查询词相关。
      // 不加这层会混进酷狗搜索噪声 —— 实测搜「晴天」会带出告五人的《好不容易》。
      const nameHit = norm(r.name).includes(qNorm) || qNorm.includes(norm(r.name));
      const artistHit = r.singers.some(s => norm(s.name).includes(qNorm) || qNorm.includes(norm(s.name)));
      return nameHit || artistHit;
    });
    kugouSongs = original.map(t => kugouTrackToTrack(t));
    if (kugouSongs.length > 0) {
      // 落库：payload 里带上 kugouMeta，后续点播直取流
      upsertTracks(kugouSongs);
      sources.push('kugou');
    }
    log.debug(`酷狗命中 ${rows.length} 条 → 原唱过滤后 ${kugouSongs.length} 条`);
  } catch (err) {
    log.warn(`酷狗搜索失败，回落 QQ：${(err as Error).message}`);
  }

  let degraded = false;
  let qqSongs: Track[] = [];

  /**
   * 跨源原唱对质（无网易云时的降级版）：
   * 用酷狗认证过的原唱歌手当权威集合，同名的 QQ 条目只要歌手对不上就判为翻唱剔除。
   * 例：搜「晴天」时酷狗认定原唱=周杰伦 → QQ 的「维也纳碎片 / Lucky小爱」版本全部丢掉。
   * 网易云接入后这里升级为三方对质。
   */
  const authority = new Map<string, Set<string>>();
  for (const t of kugouSongs) {
    const key = norm(t.name);
    if (!authority.has(key)) authority.set(key, new Set());
    for (const a of t.ar ?? []) authority.get(key)!.add(norm(a.name));
  }

  try {
    const r = await searchQQ(q, { limit, slices: [QQ_SEARCH_TYPE.song] as never });
    qqSongs = (r.songs ?? []).filter(t => {
      if (VARIANT_RE.test(t.name)) return false;
      const auth = authority.get(norm(t.name));
      if (!auth) return true;           // 酷狗没这首歌的原唱信息 → 保留，交给下游兜底
      // 酷狗已认定原唱 → QQ 侧歌手必须命中，否则就是翻唱
      return (t.ar ?? []).some(a => auth.has(norm(a.name)));
    });
    if (qqSongs.length > 0) {
      upsertTracks(qqSongs);
      sources.push('qq');
    }
  } catch (err) {
    degraded = true;
    log.warn(`QQ 辅源搜索失败：${(err as Error).message}`);
  }
  if (kugouSongs.length === 0) degraded = true;

  // 精确命中置顶 → 其余保持原源顺序；同曲去重保留先出现的（酷狗优先）
  const target = norm(q);
  const exact = (t: Track) => (norm(t.name) === target ? 0 : 1);
  const merged = [...kugouSongs, ...qqSongs].sort((a, b) => exact(a) - exact(b));

  const seen = new Set<string>();
  const songs: Track[] = [];
  for (const t of merged) {
    const k = dedupeKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    songs.push(t);
    if (songs.length >= limit) break;
  }

  return { songs, degraded, sources };
}
