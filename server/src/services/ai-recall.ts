/**
 * 候选池组装（用户拍板的架构：**数据由代码聚合，AI 只做决策与文案**）。
 *
 * ## 来源与比例（沿用已定口径）
 *
 *   相似歌手 50% · 网友歌单 25% · 本尊老歌 15%（反向权重）· 巅峰榜 10%
 *   本尊新歌：**无条件全进**（只受去重限制）
 *
 * ## 硬约束
 *
 * 1. 池内每首**必须可播**（有曲目 id、能解析）—— AI 只从池里挑，可播性天然成立；
 * 2. 已收藏 / 已推荐过 / 已标"不合适"的**不进池**（去重按内容键 + 曲目 id 双保险）；
 * 3. 带上受控标签（受控分类 + 语种），供 AI 判断与后续召回统计。
 */
import { getDatabase } from '../db/index.ts';
import { getHomeData, getToplistDetail } from '../sources/qq/home.ts';
import { getArtistAlbums } from '../sources/qq/artist.ts';
import { searchQQ, qqCooldown } from '../sources/qq/search.ts';
import { getAlbumDetail } from '../sources/qq/album.ts';
import { enqueueBuildJob, getLibraryTracks, hasBuildJob, saveLibraryTracks } from '../db/repo/library.ts';
import { getRejectionStats, listActiveRejections } from '../db/repo/ai-rejections.ts';
import { heuristicTag, syncLibraryTrackTags } from './ai-tags.ts';
import {
  coolingArtists,
  familiarityTier,
  favoriteRateByArtist,
  referTierArtists,
  pickTopArtistForToday,
  topArtists,
  type FamiliarityTier,
} from './artist-stats.ts';
import { getSimilarArtists } from './similar-artists.ts';
import { buildStyleProfile, refillPlaylistPool, topStyles } from './playlist-pool.ts';
import { isCoverOrInstrumental } from './content-filter.ts';
import type { Track, Album } from '../sources/qq/adapter.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('ai-recall');

/**
 * 池子上限。
 *
 * 用户拍板"缩短工作流、快速产出"：原来 220 首会让每次调用都背着超长上下文
 * （一次生成 10+ 次调用 × 几百行池子 = 又慢又容易飘）。收到 120。
 */
const POOL_MAX = 120;
/**
 * 出歌/候选的占比（用户拍板，本尊新歌不占额、无条件全进）。
 *
 * ⚠️ 这份比例**同时约束两个地方**：候选池的构成，**以及最终 picks 的构成**。
 * 之前只约束了池子，模型自由发挥 → 20 首里 7 首是本尊老歌（用户一眼就看出来了）。
 */
export const SHARE = { simi: 0.5, playlist: 0.25, seedOld: 0.15, chart: 0.1 } as const;
const CHART_TOPLIST_IDS = [62, 26, 27, 4];
/**
 * 读一个数值型设置（缺省回落到默认值）。
 *
 * 为什么不用常量：扩库体检需要在运行时**调大**容量（深挖专辑数、每榜取数），
 * 常量改不了。设置项：`pool.deep_albums` / `pool.chart_top_n`。
 */
function numSetting(key: string, fallback: number): number {
  const row = getDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  const n = Number(row?.value ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 生成路径的 QQ 上游纪律（2026-09-20 修「建库把全站搜索一起打进 2001」）。
 *
 * 背景（实测报障）：用户手动触发的专属曲库生成**裸奔**打上游 —— 本尊深挖是
 * 「10 位种子 × 每位 1 次专辑搜索 + 每张专辑 1 次专辑详情」，再加榜单 ×8，
 * 一次生成能打近百次 QQ。撞上 `code 2001` 后 `qqCooldown` 被**全局** trip，
 * 于是所有用户的搜索一起 fast-fail（表现就是"生成的时候搜什么都搜不到"）。
 *
 * 三条纪律（与 `library-topup.ts` 的 `ensurePoolHealth` 对齐）：
 *   1. **全局串行** —— 生成路径的上游请求排成一条链，不并发齐发；
 *   2. **最小间隔** —— 两次调用之间至少留 `QQ_GEN_MIN_GAP_MS`；
 *   3. **冷却即拒** —— 冷却期内直接拒绝，调用方跳过这次上游请求。
 *
 * ⚠️ 2001 是**上游按出网 IP** 判的：一旦被打进，拆冷却池也救不回来。
 * 所以这里的目标不是"冷却后还能搜"，而是**让生成永远别把 IP 打进风控**。
 */
const QQ_GEN_MIN_GAP_MS = 800;
let qqGenTail: Promise<unknown> = Promise.resolve();
let qqGenLastAt = 0;

/** @returns true = 可以打上游；false = 冷却中，调用方应跳过这次请求 */
async function qqGate(): Promise<boolean> {
  if (qqCooldown.active()) return false;
  const mine = qqGenTail.then(async () => {
    const wait = qqGenLastAt + QQ_GEN_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    qqGenLastAt = Date.now();
  });
  qqGenTail = mine.catch(() => {});
  await mine;
  return !qqCooldown.active();
}

/**
 * 专辑详情本地缓存（mid -> 曲目），有效期 7 天。
 *
 * 为什么必须缓存：`deepCutsOf` 每次生成都对同一位种子歌手的**同一批专辑**重复取详情
 * （每位种子最多 `pool.deep_albums` 张，体检调大后是 8 张），而专辑曲目几乎是静态的。
 * 不缓存时一次生成就要打 30~80 次专辑详情 —— 这才是把 QQ 打成 2001 的主因。
 * 只缓存非空结果：空曲目专辑（版权限制）不算"已查过"，下次仍可再试。
 */
const albumDetailCache = new Map<string, { songs: Track[]; ts: number }>();
const ALBUM_DETAIL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALBUM_DETAIL_CACHE_MAX = 400;

async function albumDetailCached(mid: string): Promise<Track[]> {
  const hit = albumDetailCache.get(mid);
  if (hit && Date.now() - hit.ts < ALBUM_DETAIL_CACHE_TTL_MS) return hit.songs;
  if (!(await qqGate())) return hit?.songs ?? [];
  const detail = await getAlbumDetail(mid, 40).catch(() => null);
  const songs = detail?.songs ?? [];
  if (songs.length > 0) {
    // 简单容量保护：超上限先丢最早插入的一条（Map 保持插入序）
    if (albumDetailCache.size >= ALBUM_DETAIL_CACHE_MAX) {
      const oldest = albumDetailCache.keys().next().value;
      if (oldest !== undefined) albumDetailCache.delete(oldest);
    }
    albumDetailCache.set(mid, { songs, ts: Date.now() });
  }
  return songs;
}

/**
 * 每个榜单取多少首。
 *
 * 原来 10 首 → 4 个榜单去重后进池的只有 2 首（大多在历史/收藏里被排掉），
 * 导致"巅峰榜"这个来源形同虚设、来源比例守不住。放宽到 30 首。
 */
const CHART_TOP_N_DEFAULT = 30;

const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');
const baseName = (s: string): string =>
  norm(String(s ?? '').replace(/[（(【\[].*?[）)】\]]/g, '').replace(/[-—–].*$/, ''));

export type CandidateSource = 'seedNew' | 'simi' | 'playlist' | 'seedOld' | 'chart';

/**
 * 完整单曲最低时长门槛（秒）：低于 90 秒判定为片段/间奏/宣传片/吟唱/短视频音频，严禁推入歌单。
 */
export const MIN_SONG_DURATION_SEC = 90;

/**
 * 非歌曲与垃圾内容模式：
 * 广告/宣传片/CF、独白/念白/talking/演说、吟唱/纯吟唱、片段/切片/试听/节选、
 * 铃声/彩铃、伴奏/纯音乐伴奏/消音伴奏、skit/intro/outro/prelude/interlude/序曲/前奏/尾声/间奏/过渡、
 * 翻唱合集/合集/串烧/remix/现场版/DJ版/慢摇 等。
 */
export const NON_SONG_RE =
  /(DJ\s*版|慢摇|加长版|remix|剪辑|片段|试听|演唱会|现场版|\(live\)|（live）|live版|伴奏|纯音乐伴奏|纯伴奏|消音伴奏|#\S+|第\d+集|合集|翻唱合集|串烧|吟唱|纯吟唱|人声吟唱|\bCF\b|宣传片|预告|花絮|独白|念白|演说|台词|访谈|采访|\btalking\b|\bskit\b|\bintro\b|\boutro\b|\bprelude\b|\binterlude\b|序曲|前奏|尾声|间奏|过渡|铃声|彩铃|铃声版|饭制|饭制版|抖音|快手|短视频|原声|音效|\bdemo\b|小样)/i;

export function isJunk(track: Track): boolean {
  const name = String(track.name ?? '').trim();
  if (!name) return true;
  if (NON_SONG_RE.test(name)) return true;

  // 无专辑归属的条目不进推荐（用户拍板）
  const albumName = String(track.al?.name ?? track.album?.name ?? '').trim();
  if (!albumName) return true;
  if (/(翻唱合集|铃声|短视频)/i.test(albumName)) return true;

  // 时长过滤：必须为完整单曲（>= 90 秒），杜绝 29 秒无意义短音频/吟唱/间奏
  /**
   * ★ 2026-10-29：`sec <= 0`（拿不到时长）**也判 junk**。
   *
   * 原来写的是 `sec > 0 && sec < MIN`，于是「dt 缺失 / dt=0 / 时长解析失败」的条目
   * 整条从时长过滤里漏过 —— 一个不知道多长的东西照样被推进歌单（片段/试听/间奏
   * 恰恰最可能没有时长字段）。宁可少推一首，也不推一个不知道多长的东西。
   */
  const sec = (track.dt ? track.dt / 1000 : track.duration) || 0;
  if (sec <= 0 || sec < MIN_SONG_DURATION_SEC) return true;

  // UGC 味很重的标题：超长 + 大量符号/标签
  if (name.length > 40) return true;
  return false;
}

export interface Candidate {
  track: Track;
  source: CandidateSource;
  /** 受控分类（可能为空） */
  styles: string[];
  language: string;
  /**
   * 是否是**该歌手的成名曲**（库内热度排名 ≤ 5）。
   *
   * 确定性信号：来自 `getArtistSongs` 的返回顺序（见 library_tracks.hot_rank）。
   * 有了它，"金曲最多几首"由代码控量，**不依赖模型认不认识歌**。
   */
  hot?: boolean;
}

export interface RecallResult {
  candidates: Candidate[];
  /** 各来源最终进池多少（本尊新歌单列） */
  counts: Record<CandidateSource, number>;
  /** 因去重/无标签等原因被丢弃的数量 */
  dropped: number;
}

export interface SeedArtist {
  name: string;
  mid: string;
  /** 收藏该歌手的曲目数（第一歌手口径） */
  hits: number;
  /** 熟悉度分档（阈值 5，见 artist-stats.ts） */
  tier: FamiliarityTier;
}

/**
 * 收藏歌手（名字聚合）—— 与推荐链路同一口径（排除已拉黑歌手）。
 *
 * 2026-10-29 熟悉度阈值（用户拍板，阈值 5）：每位种子按收藏数分档。
 * `refer`（1-2 首）**只作曲风参考、不进 TOP 池**；`top`/`huge`（≥5 首）进 TOP 池。
 * 规则写在建池层（`buildCandidatePool` 的 `push`），不是提示词。
 *
 * ★ P1-A（修复批 3-A）：口径必须是**首歌手** `artists_json[0]`，与 `topArtists` /
 * `referTierArtistNames` / `favoriteRateByArtist` 完全一致。
 * 原来这里用 `json_each` 对每位歌手计 hits（合唱双计），于是同一歌手在两个函数里
 * 得出两个 hits —— 实测「言承旭」「王力宏」在 seedArtists 里 hits=3（liked，进 poolSeeds），
 * 在 referTierArtistNames 里却只有 2 首（判 refer）→ **同一歌手双重身份**：
 * seedOld 的深挖专辑曲能进池，而库内兜底与 seedNew 却被拦。
 */
/** 收藏歌手种子（按收藏数降序，首歌手口径）。导出供实测脚本核对分档口径（verify-batch3a）。 */
export function seedArtists(userId: number): SeedArtist[] {
  const rows = getDatabase()
    .prepare(
      `SELECT json_extract(t.artists_json, '$[0].name') AS artist_name,
              json_extract(t.artists_json, '$[0].mid') AS mid,
              COUNT(DISTINCT f.track_id) AS hits
         FROM favorites f JOIN tracks t ON t.id = f.track_id
        WHERE f.user_id = ?
          AND json_extract(t.artists_json, '$[0].name') IS NOT NULL
          AND json_extract(t.artists_json, '$[0].name') != ''
          AND COALESCE(json_extract(t.artists_json, '$[0].mid'), '') NOT IN (
            SELECT target_id FROM user_dislikes WHERE user_id = ? AND type = 'artist'
          )
        GROUP BY artist_name ORDER BY hits DESC LIMIT 20`
    )
    .all(userId, userId) as unknown as Array<{ artist_name: string; mid: string | null; hits: number }>;
  return rows
    .filter(r => r.mid)
    .map(r => {
      const hits = Number(r.hits);
      return { name: r.artist_name, mid: String(r.mid), hits, tier: familiarityTier(hits) };
    });
}

/** 标签查询：一次把池里用到的曲目标签取出来 */
function tagsOf(trackIds: string[]): Map<string, { styles: string[]; language: string }> {
  const out = new Map<string, { styles: string[]; language: string }>();
  if (trackIds.length === 0) return out;
  const db = getDatabase();
  const ph = trackIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT track_id, styles, language FROM track_tags WHERE track_id IN (${ph})`)
    .all(...trackIds) as unknown as Array<{ track_id: string; styles: string; language: string }>;
  for (const r of rows) {
    let styles: string[] = [];
    try {
      styles = JSON.parse(r.styles) as string[];
    } catch {
      /* 坏数据当空 */
    }
    out.set(r.track_id, { styles, language: r.language });
  }
  return out;
}

/** 库内热度排名（1 = 该歌手最热）；非库内来源返回空 */
function hotRankOf(trackIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (trackIds.length === 0) return out;
  const db = getDatabase();
  const ph = trackIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, hot_rank FROM library_tracks WHERE id IN (${ph})`)
    .all(...trackIds) as unknown as Array<{ id: string; hot_rank: number }>;
  for (const r of rows) out.set(r.id, Number(r.hot_rank));
  return out;
}

/**
 * 已判定为器乐/翻奏/片段的曲目 id（`track_tags.is_instrumental = 1`）。
 *
 * ★ 2026-10-29（方案 B）：关键词方案（content-filter.ts）永远追不上器乐专辑的命名，
 * 所以「是不是器乐」改由 AI 打标判定、落到 `track_tags.is_instrumental`，召回按字段过滤。
 *
 * 性能：候选由 5 路来源在流程中**逐步产生**（相似歌手/网友歌单/本尊老歌/榜单/新歌），
 * 建池前拿不到完整 id 列表，所以这里**一次查询**把已判定为器乐的 id 全取进内存
 * （命中 `idx_track_tags_instrumental`），push 里只做 Set 查找 —— 绝不 per-track 查库。
 */
function instrumentalTrackIds(): Set<string> {
  const rows = getDatabase()
    .prepare('SELECT track_id FROM track_tags WHERE is_instrumental = 1')
    .all() as unknown as Array<{ track_id: string }>;
  return new Set(rows.map(r => r.track_id));
}

/**
 * 曲风参考参考物（用户 2026-10-29）：用**曲风画像**（user_style_profile）当参考物。
 *
 * 链路：曲目标签（ai-tags）→ 聚合出 user_style_profile（topStyles 读取）→ 按 tag 匹配
 * 「曲风相近」的歌喂给候选池的 simi 来源（不再纯按歌手相似发散）。
 * 用户喜不喜欢这种曲风 = 从收藏曲目的标签分布反推（topStyles 权重即喜好度）。
 *
 * @returns 一组 {keyword, weight}（权重降序），供 simi 来源按标签匹配/加权
 */
function styleProfileOf(userId: number): Array<{ keyword: string; weight: number }> {
  return topStyles(userId, 12);
}

/**
 * 曲风匹配分：候选曲目的受控标签与用户曲风画像的加权重叠（越高 = 越符合用户口味）。
 * 用于 simi 来源**加权**（不是过滤）：标签相近的排前面优先占名额，不取消资格。
 */
/**
 * 无标签歌的基础分系数（P1-K）：画像**平均权重 × 0.3**。
 *
 * 为什么需要它：`track_tags` 里没打标的曲目（新歌、冷门歌、刚入库还没打标的）
 * 原来一律 `score = 0`，在 simi 排序里被彻底埋到最末尾 —— 而「没打标」只代表
 * **没有证据**，不代表「不合口味」。给一个中段的基础分，让它们有机会被排到中间，
 * 与画像平均权重对齐（实测画像权重 226/173/53/…/1，平均 ≈ 43，基础分 ≈ 13）。
 */
const UNTAGGED_BASE_FACTOR = 0.3;

export function styleScore(
  trackTags: { styles: string[]; language: string },
  profile: Array<{ keyword: string; weight: number }>
): number {
  if (profile.length === 0) return 0;
  const weightBy = new Map(profile.map(p => [p.keyword, p.weight]));
  let score = 0;
  for (const s of trackTags.styles) {
    score += weightBy.get(s) ?? 0;
  }
  if (trackTags.language) score += (weightBy.get(trackTags.language) ?? 0) * 0.5;
  if (score > 0) return score;
  // ★ P1-K：无标签 / 标签与画像零重叠 = 没有曲风证据 → 给基础分，不钉死在 0 分末尾
  const avg = profile.reduce((sum, p) => sum + p.weight, 0) / profile.length;
  return avg * UNTAGGED_BASE_FACTOR;
}

/**
 * 曲风分桶名（P1-H）：取该曲**在用户画像里权重最高**的那个命中标签当桶名。
 *
 * 为什么必须分桶：`user_style_profile` 权重严重偏斜（实测 华语流行 226 / 情歌 173 /
 * 摇滚 53 / 尾部 4），纯按 styleScore 加权排序时，simi 的 60 个名额几乎必然被
 * 「华语流行 + 情歌」高分曲占满（实测 simi 22/22 全带这两个标签），多样性崩塌。
 * 分桶后每个风格最多占 K 个名额（K 见 `pool.simi_per_style`），尾部风格也留得住位置。
 *
 * 无任何命中标签（含无标签）→ 归入 `__untagged` 桶，它也有自己的名额，不会被挤掉。
 */
export function styleBucket(
  trackTags: { styles: string[]; language: string },
  profile: Array<{ keyword: string; weight: number }>
): string {
  const weightBy = new Map(profile.map(p => [p.keyword, p.weight]));
  let best = '';
  let bestWeight = -1;
  for (const s of trackTags.styles) {
    const w = weightBy.get(s);
    if (w !== undefined && w > bestWeight) {
      best = s;
      bestWeight = w;
    }
  }
  if (best) return best;
  if (trackTags.language && weightBy.has(trackTags.language)) return trackTags.language;
  return '__untagged';
}

/** 冻结窗口：推荐历史只冻结这么久（用户拍板 7 天） */
const FREEZE_MS = 7 * 24 * 60 * 60 * 1000;

/** 去重用的排除集：已收藏（永久）/ 7 天内推过 / 用户黑名单（不喜欢歌曲与歌手） */
function buildExclusions(userId: number): {
  trackIds: Set<string>;
  contentKeys: Set<string>;
  dislikedArtistMids: Set<string>;
} {
  const db = getDatabase();
  const trackIds = new Set<string>(
    (db
      .prepare('SELECT track_id FROM favorites WHERE user_id = ?')
      .all(userId) as unknown as Array<{ track_id: string }>).map(r => r.track_id)
  );
  /**
   * 已推荐历史：只冻结最近 7 天。
   */
  for (const r of db
    .prepare(
      `SELECT DISTINCT track_id FROM recommend_history
        WHERE user_id = ? AND track_id != '' AND created_at > ?`
    )
    .all(userId, Date.now() - FREEZE_MS) as unknown as Array<{ track_id: string }>) {
    trackIds.add(r.track_id);
  }

  // 黑名单物理拦截：用户点了不喜欢的歌曲与歌手，直接在候选池物理剔除
  // 杜绝因下游过滤导致落地歌单不足 30 首
  const dislikedArtistMids = new Set<string>();
  const dislikeRows = db
    .prepare('SELECT type, target_id FROM user_dislikes WHERE user_id = ?')
    .all(userId) as unknown as Array<{ type: string; target_id: string }>;
  for (const d of dislikeRows) {
    if (d.type === 'track') {
      trackIds.add(d.target_id);
    } else if (d.type === 'artist') {
      dislikedArtistMids.add(d.target_id);
    }
  }

  /** 内容键（歌名|歌手）+ 行为键（artist:歌手名） */
  const contentKeys = new Set<string>(
    (db
      .prepare(
        `SELECT json_extract(t.payload_json, '$.name') AS name,
                json_extract(t.artists_json, '$[0].name') AS artist
           FROM favorites f JOIN tracks t ON t.id = f.track_id
          WHERE f.user_id = ?`
      )
      .all(userId) as unknown as Array<{ name: string | null; artist: string | null }>).map(
      r => `${baseName(r.name ?? '')}|${norm(r.artist ?? '')}`
    )
  );

  /**
   * AI 选库否决集（升级式冷却 + 永久黑名单，见 017 迁移）。
   *
   * 与上面用户手动「不喜欢」**刻意分开**：那个是用户意志、永久生效；这个是
   * AI 的判断，冷却到期会重新进池给它一次机会，反复被踢才升级成永久。
   *
   * ⚠️ 没有这一步，模型"没选中"的歌换池子后会原样回来 → 再次不选 → 死循环。
   * 同时按曲目 id 和内容键双保险：同一首歌换个 id 重新进池也挡得住。
   */
  for (const r of listActiveRejections(userId)) {
    trackIds.add(r.track_id);
    if (r.name || r.artist) {
      contentKeys.add(`${baseName(r.name)}|${norm(r.artist)}`);
    }
  }

  return { trackIds, contentKeys, dislikedArtistMids };
}

/** 一首都没缓存过的库里曲目（按歌手 mid 取） */
function libraryTracksOf(artistMids: string[]): Track[] {
  if (artistMids.length === 0) return [];
  return getLibraryTracks(artistMids);
}

/** 库内已有的曲目 id（用来判断"专辑里哪些是我们还没拿到的"） */
function libraryTrackIds(artistMid: string): Set<string> {
  const rows = getDatabase()
    .prepare('SELECT id FROM library_tracks WHERE artist_mid = ?')
    .all(artistMid) as unknown as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
}

/**
 * 本尊老歌要**挖专辑非主打**，不能只吃"歌手热门 30 首"。
 *
 * 实测教训：池子全是热门歌 → 模型挑来挑去都是成名曲（它甚至把《黄昏》说成
 * "避开《黄昏》的冷门佳作"✗ 自相矛盾），用户要的"没听过的东西"根本没机会出现。
 * 这里给每位种子取一张**最近的非 Live/OST 专辑**，把它里面还没进库的曲目补进来。
 */
// 歌手专辑列表本地缓存（mid -> Album[]），有效期 7 天。
// 避免每次生成推荐时都对 10 位种子歌手连续打 10 次 QQ 专辑搜索触发 2001。
const artistAlbumsCache = new Map<string, { albums: Album[]; ts: number }>();
const ALBUM_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ★ 专辑级新作检测（用户 2026-10-29：新歌识别不及时 → 为收藏 ≥5 的种子歌手做专辑级新作检测）。
 *
 * 口径：`getArtistAlbums` 按 `releasedate`（publishTime）排序，取**最新一张**非 Live/OST 专辑，
 * 把它里面的歌当作本尊新歌候选（seedNew，无条件全进）。只认最新一张，避免把老专辑也算成新歌。
 *
 * **最新专辑缓存 TTL = 24h**（见 `LATEST_ALBUM_TTL_MS`）：新专辑发了 24h 内必被识别，
 * 而普通深挖专辑仍是 7 天 TTL（`ALBUM_CACHE_TTL_MS`），两套缓存互不干扰。
 *
 * @returns 最新专辑里还没进库的曲目（作为新歌候选）；拿不到最新专辑时返回空
 */
const LATEST_ALBUM_TTL_MS = 24 * 60 * 60 * 1000;
/** 最新专辑曲目缓存（**TTL = 24h**）：新专辑/新追加曲目 24h 内被识别（用户 2026-10-29） */
const latestAlbumDetailCache = new Map<string, { songs: Track[]; ts: number }>();
async function latestAlbumDetailCached(mid: string): Promise<Track[]> {
  const hit = latestAlbumDetailCache.get(mid);
  if (hit && Date.now() - hit.ts < LATEST_ALBUM_TTL_MS) return hit.songs;
  if (!(await qqGate())) return hit?.songs ?? [];
  const detail = await getAlbumDetail(mid, 40).catch(() => null);
  const songs = detail?.songs ?? [];
  if (songs.length > 0) latestAlbumDetailCache.set(mid, { songs, ts: Date.now() });
  return songs;
}
const latestAlbumCache = new Map<string, { mid: string; ts: number }>();

function isCleanAlbum(a: Album): boolean {
  return (
    !/(live|演唱会|现场|原声|ost|伴奏|精选|remix|混音)/i.test(a.name) &&
    ((a as unknown as { size?: number }).size ?? 0) >= 4
  );
}

/**
 * ★ P0-E：publishTime → 毫秒时间戳（归一口径，无法解析时 NaN）。
 *
 * **为什么不能直接 localeCompare**：上游混用两种格式 —— epoch 数字串
 * （`'1761945600000'`）与 ISO 日期串（`'2026-10-01'`）。按字符串比大小时首字符
 * `'1'` < `'2'`，于是**每一条 epoch 专辑都输给任何 ISO 专辑** → 选错最新专辑。
 *
 * 三种输入的处理：
 * · 纯数字串：10 位当 epoch 秒、11-14 位当 epoch 毫秒；
 * · ISO / 日期串：`Date.parse`；
 * · 空串 / `'0'` 这类占位与解析失败：**NaN** —— 排序时排最后，与改造前
 *   「空串、占位符排在最后」的安全行为一致。
 */
export function publishTimeMs(album: Album): number {
  const raw = String((album as { publishTime?: unknown }).publishTime ?? '').trim();
  if (raw === '') return NaN;
  if (/^\d+$/.test(raw)) {
    // 纯数字串：只有 10-14 位才当 epoch（10 位秒 / 11-14 位毫秒）。
    // 更短的是 `'0'` 之类的占位符（注意 `Date.parse('0')` 会解析成 2000 年，
    // 必须在这里拦掉），一律视为「无日期」。
    if (raw.length < 10 || raw.length > 14) return NaN;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    return raw.length === 10 ? n * 1000 : n;
  }
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : NaN;
}

/**
 * ★ P0-F：挑「最新一张**已发行**的干净专辑」。
 *
 * 为什么必须过滤未来专辑：`publishTime='2027-01-01'` 的预售/未发行专辑按时间戳排是
 * **最新**的，一旦胜出，① 它的曲目会被当成本尊新歌提前进 seedNew（用户根本没听过，
 * 甚至拿不到音源）；② `latestAlbumCache` 的 24h TTL 从 `Date.now()` 起算、不看
 * publishTime，于是这张未来专辑会**永久遮蔽**歌手真实的新专辑（每 24h 续一次，直到
 * 它真的发行）。
 *
 * 所以：`publishTime > now` 的专辑**不进 newest 候选**（`publishTime` 解析不出来的
 * 保持旧行为，不因缺日期就被排除）。
 */
export function pickNewestReleasedAlbum(albums: Album[], nowMs: number = Date.now()): Album | undefined {
  const released = albums.filter(a => {
    const ts = publishTimeMs(a);
    return !(Number.isFinite(ts) && ts > nowMs);
  });
  return [...released].sort(comparePublishTimeDesc)[0];
}

/** ★ P0-E：按真实时间戳降序比较（NaN 一律排最后，两个都 NaN 时保持原序） */
export function comparePublishTimeDesc(a: Album, b: Album): number {
  const ta = publishTimeMs(a);
  const tb = publishTimeMs(b);
  const fa = Number.isFinite(ta);
  const fb = Number.isFinite(tb);
  if (fa && fb) return tb - ta;
  if (fa) return -1;
  if (fb) return 1;
  return 0;
}

/**
 * 新作检测的上游依赖（默认真实 QQ 上游）。
 *
 * 抽成可注入的探针是为了**能实测时序**：比如「专辑详情失败后，下一次必须重新尝试，
 * 而不是被判成 fresh 跳过」（P0-G）。这类 bug 用真上游测不出来，只能注入假探针。
 */
export interface AlbumProbe {
  listAlbums(seed: { name: string; mid: string }): Promise<Album[]>;
  loadSongs(albumMid: string): Promise<Track[]>;
  gate(): Promise<boolean>;
}
const defaultAlbumProbe: AlbumProbe = {
  listAlbums: seed => latestAlbumsOf(seed),
  loadSongs: albumMid => latestAlbumDetailCached(albumMid),
  gate: () => qqGate(),
};

export async function latestAlbumSongsOf(
  userId: number,
  seed: { name: string; mid: string },
  cap: number,
  probe: AlbumProbe = defaultAlbumProbe
): Promise<Track[]> {
  try {
    // 专辑列表：按 releasedate 降序取最新一张。**专用 24h 缓存**（latestAlbumListCache），
    // 不复用 7 天的 artistAlbumsCache —— 否则新专辑最多延迟 7 天才被看到（用户 2026-10-29）。
    const albums = await probe.listAlbums(seed);
    const clean = albums.filter(isCleanAlbum);
    // ★ P0-E 按 publishTime 归一时间戳降序（NaN 排最后）+ ★ P0-F 未来/预售专辑不进候选
    const newest = pickNewestReleasedAlbum(clean);
    if (!newest) return [];
    const mid = String((newest as unknown as { mid?: string }).mid ?? '');
    if (!mid) return [];
    // 最新专辑专用 24h TTL：命中即认为「今天已检查过这张最新专辑」
    const cached = latestAlbumCache.get(seed.mid);
    const fresh = cached && cached.mid === mid && Date.now() - cached.ts < LATEST_ALBUM_TTL_MS;
    // 冷却中：不打上游，但把最新专辑标记入队补拉（不跳过）
    if (!fresh && !(await probe.gate())) enqueueLatestAlbumRefresh(userId, seed.mid, seed.name);
    const songs = await probe.loadSongs(mid);
    /**
     * ★ P0-G：**只有真的拿到歌**才置位「这张最新专辑已检查过」（24h TTL）。
     *
     * 原实现把 set 放在 detail 之前 —— 于是 detail 失败（返回 []，见
     * `latestAlbumDetailCached` 只在 songs>0 时缓存）时也会被判成 fresh，
     * 之后 24h 内既不打上游也不入队补拉 → **永不补拉，新歌漏检到 TTL 过期**。
     * 现在与 `:423` 的缓存条件对齐：拿到歌才算检查过。
     */
    if (songs.length > 0) latestAlbumCache.set(seed.mid, { mid, ts: Date.now() });
    const known = libraryTrackIds(seed.mid);
    const out: Track[] = [];
    for (const t of songs) {
      if (out.length >= cap) break;
      if (out.some(x => x.id === t.id)) continue;
      // 新歌 = 最新专辑里的歌；即使已进库也可能是「刚入库的新歌」，都算本尊新歌候选
      void known;
      out.push(t);
    }
    return out;
  } catch (err) {
    log.warn(`新作检测失败 ${seed.name}: ${(err as Error).message}`);
    return [];
  }
}

/** 最新专辑刷新入队（getHomeData 失败/冷却时不跳过，补拉而非丢弃） */
function enqueueLatestAlbumRefresh(userId: number, artistMid: string, name: string): void {
  try {
    const payload = JSON.stringify({ mid: artistMid, name });
    if (hasBuildJob('artist_songs', payload)) return;
    enqueueBuildJob(userId, 'artist_songs', payload, 'new_album_refresh');
    log.info(`新作检测：${name} 最新专辑待补拉（已入队）`);
  } catch {
    /* 入队失败不影响主流程 */
  }
}

/**
 * ★ 新发现 A：歌手专辑列表的取数口径 —— **扩大上限 + 本地按发行时间降序**。
 *
 * 原来三处（`albumsOf` / `latestAlbumsOf` / `deepCutsOf`）都写死 `limit = 10, page = 1`，
 * 而上游搜索 album 分片返回的是**热度序**，不是时间序 —— 实测五月天最新录音室专辑
 * 根本不在前 10 张里（前 10 张全是 Live/精选），于是「最新专辑」永远选到《自传》2016，
 * **新歌识别因此漏检**。
 *
 * 改法：上限提到 `pool.album_fetch_limit`（默认 50，运行时可调），拿到之后**本地按
 * `publishTime` 归一时间戳降序排序**（复用 P0-E 的 `publishTimeMs` / `comparePublishTimeDesc`）。
 * 这样不依赖上游返回顺序：即便上游只给热度序，扩大上限后最新专辑也能进候选集。
 */
const ALBUM_FETCH_LIMIT_DEFAULT = 50;
async function fetchAlbumsByPublishTime(seed: { name: string; mid: string }): Promise<Album[]> {
  const res = await getArtistAlbums(
    seed.mid,
    seed.name,
    numSetting('pool.album_fetch_limit', ALBUM_FETCH_LIMIT_DEFAULT),
    1
  );
  // NaN（无日期）排最后，两个都 NaN 时保持上游原序
  return [...res.albums].sort(comparePublishTimeDesc);
}

/** 专辑列表（复用 deepCutsOf 的 7 天缓存 + 上游纪律；按发行时间降序，见上） */
async function albumsOf(seed: { name: string; mid: string }): Promise<Album[]> {
  const cached = artistAlbumsCache.get(seed.mid);
  if (cached && Date.now() - cached.ts < ALBUM_CACHE_TTL_MS) return cached.albums;
  if (!(await qqGate())) return cached?.albums ?? [];
  const albums = await fetchAlbumsByPublishTime(seed);
  if (albums.length > 0) {
    artistAlbumsCache.set(seed.mid, { albums, ts: Date.now() });
    return albums;
  }
  return [];
}
/**
 * 专辑列表（**24h 专用缓存**）：只服务最新专辑检测，确保新专辑 24h 内被看到。
 * 与 `albumsOf`（7 天，深挖用）分开，互不拖累。
 */
const latestAlbumListCache = new Map<string, { albums: Album[]; ts: number }>();
async function latestAlbumsOf(seed: { name: string; mid: string }): Promise<Album[]> {
  const cached = latestAlbumListCache.get(seed.mid);
  if (cached && Date.now() - cached.ts < LATEST_ALBUM_TTL_MS) return cached.albums;
  if (!(await qqGate())) return cached?.albums ?? [];
  // ★ 新发现 A：扩大上限 + 按发行时间降序（否则最新录音室专辑可能不在前 10 张热度序里）
  const albums = await fetchAlbumsByPublishTime(seed);
  if (albums.length > 0) {
    latestAlbumListCache.set(seed.mid, { albums, ts: Date.now() });
    return albums;
  }
  return [];
}

async function deepCutsOf(seed: { name: string; mid: string }, cap: number): Promise<Track[]> {
  try {
    // ★ 新发现 A：与 albumsOf 同口径（扩大上限 + 发行时间降序），不再各写一份取数逻辑
    const albums: Album[] = await albumsOf(seed);
    const clean = albums.filter(
      a =>
        !/(live|演唱会|现场|原声|ost|伴奏|精选|remix|混音)/i.test(a.name) &&
        ((a as unknown as { size?: number }).size ?? 0) >= 4
    );
    const known = libraryTrackIds(seed.mid);
    const out: Track[] = [];
    /**
     * **挖多张专辑**（原来只挖 1 张 → 本尊老歌只出 7 首，来源比例守不住）。
     * 每张专辑都能出非主打，池子才有厚度。
     */
    for (const album of clean.slice(0, numSetting('pool.deep_albums', 3))) {
      if (out.length >= cap) break;
      const mid = String((album as unknown as { mid?: string }).mid ?? '');
      if (!mid) continue;
      const songs = await albumDetailCached(mid);
      for (const t of songs) {
        if (out.length >= cap) break;
        if (known.has(t.id)) continue; // 库里那 30 首是热门歌，其余才是非主打
        if (out.some(x => x.id === t.id)) continue;
        out.push(t);
      }
    }
    if (out.length > 0) {
      // 沉淀为曲库资产：只增不减蓄水池模式，非主打曲 hot_rank 为 0
      saveLibraryTracks(seed.mid, out, { isRanked: false });
      log.info(
        `本尊深挖：${seed.name} 挖 ${Math.min(clean.length, numSetting('pool.deep_albums', 3))} 张专辑` +
          ` → ${out.length} 首非主打候选（已增量沉淀入库）`
      );
    }
    return out;
  } catch (err) {
    log.warn(`深挖失败 ${seed.name}: ${(err as Error).message}`);
    return [];
  }
}

export async function resolveArtistMids(names: string[], limit = 40): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names.slice(0, limit)) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    try {
      const res = await searchQQ(name, { limit: 5, slices: ['singer'] });
      const hit =
        res.artists.find(a => norm(a.name) === norm(name)) ?? res.artists[0];
      const mid = String(hit?.mid ?? '');
      if (mid) out.push(mid);
    } catch {
      /* 单个歌手失败无所谓（多半是限流），继续下一个 */
    }
  }
  return [...new Set(out)];
}

/**
 * 相似歌手名字。
 *
 * 历史实现只读 `artist_simi_cache`，而这张表**只有两个写入口**：歌手详情页
 * （`routes/catalog.ts:292`）与库补全（`library-topup.ts:185`）。于是从没点过歌手页的用户，
 * 这个表是空的 → `SHARE.simi` 那 50% 名额被 water-filling 静默流给公共歌单和榜单
 * （实测来源：playlist 18 / seedOld 13 / chart 9 / simi 0 → 70% 内容来自公共源）。
 *
 * 现在：缓存缺的**现算一次并写回**（`getSimilarArtists` 自带永久缓存），一次最多补
 * `SIMI_FILL_MAX` 位歌手以控制上游压力；仍然全空时打 error，让「50% 名额失效」不再无声。
 */
const SIMI_FILL_MAX = 6;

async function simiNamesOf(artistNames: string[]): Promise<string[]> {
  if (artistNames.length === 0) return [];
  const db = getDatabase();
  const ph = artistNames.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT name, names_json FROM artist_simi_cache WHERE name IN (${ph})`)
    .all(...artistNames) as unknown as Array<{ name: string; names_json: string }>;
  const filled = new Map<string, string[]>();
  for (const r of rows) {
    try {
      filled.set(r.name, JSON.parse(r.names_json) as string[]);
    } catch {
      /* 忽略坏数据 */
    }
  }

  const missing = artistNames.filter(n => !filled.has(n)).slice(0, SIMI_FILL_MAX);
  if (missing.length > 0) {
    await Promise.all(
      missing.map(async name => {
        try {
          // getSimilarArtists 返回 {id,name}：我们只要名字（mid 由另一条路解析）
          const neighbors = await getSimilarArtists(name);
          filled.set(name, neighbors.map(a => a.name).filter(Boolean));
        } catch (e) {
          log.warn(`相似歌手现算失败「${name}」：${(e as Error).message}`);
        }
      })
    );
  }

  const out = [...new Set([...filled.values()].flat().filter(Boolean))];
  if (out.length === 0) {
    log.error(
      `相似歌手全部解析失败（种子 ${artistNames.length} 位）：本次推荐将退化给公共歌单/榜单，` +
        `SHARE.simi=${SHARE.simi} 的名额失效`
    );
  }
  return out;
}

/**
 * 维护（每次生成前跑一次，用户口径："7 天一到直接覆盖"）。
 *
 *  ① 推荐历史只保留 7 天 → 超期直接删（"覆盖"）
 *  ② **AI 踢掉的** + **7 天冻结期内推荐过的** → 从推荐库里删
 *     —— 是"从库里删"而非"永久封杀"：将来后端又抓回来，它照样能进池。
 *
 * ⚠️ 用户的两张清单（收藏 / 不喜欢）**不走这里**：
 *   收藏的**永不删**；不喜欢的**不删库**、只靠池子排除 —— 因为他随时可能取消，
 *   删了就恢复不了（排除是活的，清单改一下立刻生效）。
 */
export function maintainLibrary(userId: number): { historyPruned: number; libraryDropped: number } {
  const db = getDatabase();
  const cutoff = Date.now() - FREEZE_MS;

  // 推荐历史作为用户音乐轨迹、可播率统计与正负反馈闭环的长期核心资产，永久保留（不作物理删除）。
  // 7 天冷却排重已完全在 buildExclusions(userId) 中通过 created_at > cutoff 动态隔离。
  const coolCount = Number(
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM recommend_history WHERE user_id = ? AND created_at > ?')
        .get(userId, cutoff) as { n: number } | undefined
    )?.n ?? 0
  );
  log.debug(`库维护：用户 ${userId} 当前处于 7 天冻结冷却期的推荐曲目共 ${coolCount} 首`);
  // 建库阶段同步打标（用户 2026-10-29）：给 library_tracks 补受控标签，落 track_tags + payload_json。
  // 幂等、只补没打过的；失败不影响主流程。
  try {
    syncLibraryTrackTags(500);
  } catch (err) {
    log.warn(`建库同步打标失败（不影响选歌）：${(err as Error).message}`);
  }
  // 曲风画像（user_style_profile）本地聚合并刷新，供 simi 来源按标签匹配/加权（T5）。
  try {
    buildStyleProfile(userId);
  } catch (err) {
    log.warn(`曲风画像聚合失败（不影响选歌）：${(err as Error).message}`);
  }
  return { historyPruned: 0, libraryDropped: 0 };
}

/**
 * 组装候选池。
 *
 * @param opts.ratios 是否按已定比例限制各来源数量（默认 true）
 */
export async function buildCandidatePool(
  userId: number,
  opts: { ratios?: boolean } = {}
): Promise<RecallResult> {
  const ratios = opts.ratios !== false;
  const seeds = seedArtists(userId);
  if (seeds.length === 0) {
    log.info(`用户 ${userId} 暂无种子歌手，将通过优质网友歌单与巅峰榜流水构建冷启动候选池`);
  }

  const { trackIds: excludedIds, contentKeys: excludedKeys, dislikedArtistMids } = buildExclusions(userId);
  const seen = new Set<string>();
  /**
   * **池子层面就保证"一位歌手最多一首"**。
   *
   * 实测教训：池子里同一歌手有多首时，模型会一次挑好几首同歌手的，然后被下游的
   * "同歌手 1 首"去重掉 —— 要 20 首最后只剩 8 首（它自己还不知道为什么）。
   * 在池子里先收敛，模型怎么挑都不会违反多样性。
   */
  const seenArtists = new Set<string>();
  const droppedRef = { n: 0 };
  const candidates: Candidate[] = [];

  /**
   * ★ TOP 歌手硬约束（用户口径 2026-09-22）。
   *
   * 问题：收藏量最大的歌手（实测：周杰伦 34 首、五月天 28 首，第三名只有 6 首）
   * 凭收藏量必然成为种子、必然每天进池、必然被排到歌单前排 —— 用户每天都在跳过。
   * 根因是"跨天不记忆"，不是"单日超量"（池子里本来就限制每位歌手 1 首）。
   *
   * 规则：
   *   1. TOP 判定：收藏曲目数 > 10 的歌手（见 artist-stats.ts）
   *   2. 每天最多放**一位** TOP 歌手进池
   *   3. 该歌手若近 4 天进过推荐 → 处于冷却期，不得进池
   *   4. 同时够格多位时，选**距上次出现在推荐里最久**的那位（让头部歌手交替出场）
   *   5. **本尊新歌（seedNew）豁免**：偶像发新歌不许被这条规则挡住
   */
  /**
   * 熟悉度阈值（用户 2026-10-29，阈值 5）：1-2 首收藏的歌手**只作曲风参考、不进 TOP 池**。
   * 规则写在建池层（`push`），不是提示词 —— 模型看不见就不会违反。
   * `refer` 名单按**歌手名**（首歌手口径）判定，push 里把这些歌手的本尊歌直接拦掉。
   */
  // 全量 refer 档（1-2 首收藏）歌手：不只 top-20 种子，覆盖所有 1-2 首歌手（熟悉度阈值要求）
  // ★ P1-A：**同时拿 mid** —— push 的拦截必须能按 mid 匹配（名字写法会飘）
  const referArtistRows = referTierArtists(userId);
  const referArtistNames = new Set(referArtistRows.map(a => a.name));
  const referArtistMids = new Set(
    referArtistRows.map(a => a.mid).filter((m): m is string => Boolean(m))
  );
  /** 可进 TOP 池的种子（tier != refer，即收藏 >=3 首）：seedOld/seedNew 只从这些人里取 */
  const poolSeeds = seeds.filter(s => s.tier !== 'refer');
  const topArtistRows = topArtists(userId);
  const topArtistNames = topArtistRows.map(a => a.name);
  const topArtistSet = new Set(topArtistNames);
  /** ★ P1-A：TOP 歌手的 mid 集合（与名字集合并用，任一命中即视为同一位歌手） */
  const topArtistMids = new Set(
    topArtistRows.map(a => a.mid).filter((m): m is string => Boolean(m))
  );
  const cooling = coolingArtists(userId);
  const allowedTopToday = pickTopArtistForToday(
    userId,
    topArtistNames.filter(name => !cooling.has(name))
  );
  /** 今天被放行的那位 TOP 歌手的 mid（用于 mid 口径的豁免判定） */
  const allowedTopMid = allowedTopToday
    ? (topArtistRows.find(a => a.name === allowedTopToday)?.mid ?? '')
    : '';

  /**
   * ★ 器乐/翻奏/片段的**第二道防线**（2026-10-29 用户裁定，方案 B）。
   * 建池开头一次性取好（见 instrumentalTrackIds），push 里只做内存查找。
   */
  const instrumentalIds = instrumentalTrackIds();

  const push = (track: Track, source: CandidateSource): boolean => {
    if (isJunk(track)) {
      droppedRef.n += 1;
      return false;
    }
    /**
     * 翻奏 / 钢琴 / 纯音乐版本**不进候选池**（统一判定见 services/content-filter.ts）。
     *
     * 实测这道口子漏进来的代价很高：池子 2846 条里 100+ 条是钢琴集，而 AI 把
     * 「钢琴 + 流行」当同质好料反复挑，导致某天 40 首里 6 首是纯音乐。
     * 放在 push 里 = 所有来源（相似歌手 / 网友歌单 / 本尊老歌 / 巅峰榜）一次覆盖，
     * 不需要在每个来源各写一遍。
     */
    if (isCoverOrInstrumental(track)) {
      droppedRef.n += 1;
      return false;
    }
    /**
     * 第二道：AI 打标判定的器乐/翻奏/片段（`is_instrumental = 1`）→ 不入池。
     *
     * 为什么两道都要留：关键词能抓的当场抓掉（零成本、零等待），抓不到的
     * （`北国之春 | 刘慧敏 | 琴意绵绵Ⅱ` 这种干净命名的器乐专辑）靠打标兜底。
     * NULL（未判定）**不拦** —— 没有证据不等于有罪，等打标补齐。
     */
    if (instrumentalIds.has(track.id)) {
      droppedRef.n += 1;
      return false;
    }
    const key = `${baseName(track.name)}|${norm((track.ar ?? [])[0]?.name ?? '')}`;
    if (excludedIds.has(track.id) || excludedKeys.has(key)) {
      droppedRef.n += 1;
      return false;
    }
    // 黑名单物理排除：歌手拉黑直接剔除，严禁进入候选池
    if ((track.ar ?? []).some(a => dislikedArtistMids.has(String(a.mid ?? '')))) {
      droppedRef.n += 1;
      return false;
    }
    if (seen.has(track.id) || seen.has(key)) {
      droppedRef.n += 1;
      return false;
    }
    const artist = norm((track.ar ?? [])[0]?.name ?? track.id);
    if (seenArtists.has(artist)) {
      droppedRef.n += 1;
      return false;
    }
    /**
     * TOP 歌手硬约束（规则见上方注释）。
     * 用**原始歌手名**匹配（recommend_history.artist / 收藏排行都是原始写法，
     * 已实测 157/157 精确一致），不要用 norm 后的值，否则两边口径会飘。
     * 本尊新歌豁免。
     */
    const firstArtist = (track.ar ?? [])[0];
    const rawFirstArtist = firstArtist?.name ?? '';
    /** ★ P1-A：首位歌手的 mid（名字 + mid 双口径，任一命中即算同一位歌手） */
    const rawFirstMid = String(firstArtist?.mid ?? '');
    const firstIsTopArtist =
      topArtistSet.has(rawFirstArtist) || (rawFirstMid !== '' && topArtistMids.has(rawFirstMid));
    /** 今天被放行的那位 TOP 歌手：名字或 mid 命中都算 */
    const isAllowedTopToday =
      rawFirstArtist === allowedTopToday || (allowedTopMid !== '' && rawFirstMid === allowedTopMid);
    if (source !== 'seedNew' && firstIsTopArtist && !isAllowedTopToday) {
      droppedRef.n += 1;
      return false;
    }
    /**
     * ★ 熟悉度阈值（用户 2026-10-29）：1-2 首收藏的歌手（refer 档）**只作曲风参考、不进 TOP 池**。
     * 本尊老歌 / 本尊新歌属于「该歌手的歌」= TOP 池来源，refer 档歌手一律拦掉；
     * simi/playlist/chart 是发散来源，不受此限（它们按曲风/相似度进入）。
     * 规则写在建池层，模型看不见就不会违反。
     */
    const firstIsReferArtist =
      referArtistNames.has(rawFirstArtist) || (rawFirstMid !== '' && referArtistMids.has(rawFirstMid));
    if ((source === 'seedOld' || source === 'seedNew') && firstIsReferArtist) {
      droppedRef.n += 1;
      return false;
    }
    seen.add(track.id);
    seen.add(key);
    seenArtists.add(artist);
    candidates.push({ track, source, styles: [], language: '' });
    return true;
  };

  // ---- 1) 本尊新歌：无条件全进（只受去重限制）----
  /**
   * ★ P1-J：本尊新歌的**范围口径必须只有一条：tier `top`/`huge`（收藏 ≥5）**。
   *
   * 原来两条通道口径不同：全站新歌榜（getHomeData）用 `poolSeeds`（tier != refer，即 ≥3 首），
   * 而专辑级新作检测用 `tier top/huge`（≥5 首）—— 于是 3-4 首的「算喜欢」歌手
   * 经 getHomeData 也进了 seedNew。统一到 ≥5（目标模型 A.4：新歌必推只给深度喜欢）。
   */
  const newSongSeeds = seeds.filter(s => s.tier === 'top' || s.tier === 'huge');
  const seedMids = new Set(newSongSeeds.map(s => s.mid));
  // (a) 全站新歌榜（getHomeData）：失败/冷却时**入队补拉**而非跳过（用户 2026-10-29）
  let home: Awaited<ReturnType<typeof getHomeData>> | null = null;
  if (await qqGate()) {
    home = await getHomeData().catch(() => null);
    if (!home) enqueueLatestAlbumRefresh(userId, 'home', 'getHomeData');
  } else {
    // 冷却中：不打上游，但补拉而不是丢掉（下次建库会把这批新歌补回来）
    enqueueLatestAlbumRefresh(userId, 'home', 'getHomeData');
  }
  for (const t of home?.newSongs ?? []) {
    const isSeedArtist = (t.ar ?? []).some(a => seedMids.has(String(a.mid ?? '')));
    if (isSeedArtist) push(t, 'seedNew');
  }
  // (b) 专辑级新作检测（用户 2026-10-29：新歌识别不及时）：
  //     为收藏 ≥5 的种子（top/huge 档）检测**最新一张专辑**，其歌作本尊新歌候选。
  //     最新专辑缓存 TTL = 24h，新专辑 24h 内必被识别。
  //     与 (a) 共用 `newSongSeeds`（P1-J：两条通道口径统一为 ≥5 首）。
  for (const s of newSongSeeds.slice(0, 10)) {
    for (const t of await latestAlbumSongsOf(userId, s, 8)) {
      push(t, 'seedNew');
    }
  }

  // ---- 2) 相似歌手：读缓存名单 → 找库内曲目 ----
  const neighborNames = await simiNamesOf(seeds.map(s => s.name));
  if (neighborNames.length > 0) {
    const db = getDatabase();
    const ph = neighborNames.map(() => '?').join(',');
    const mids = (db
      .prepare(`SELECT mid FROM library_artists WHERE name IN (${ph})`)
      .all(...neighborNames) as unknown as Array<{ mid: string }>).map(r => r.mid);
    const simiCap = ratios ? Math.floor(POOL_MAX * SHARE.simi) : POOL_MAX;
    let added = 0;
    /**
     * 曲风参考加权（用户 2026-10-29）：simi 来源按**用户曲风画像（topStyles）标签匹配度**
     * 优先排序 —— 标签相近的先占名额（加权，不取消资格）。不再纯按歌手相似发散。
     */
    const styleProfile = styleProfileOf(userId);
    const simiTracks = libraryTracksOf(mids);
    const simiTags = tagsOf(simiTracks.map(t => t.id));
    const ranks = hotRankOf(simiTracks.map(t => t.id));
    /**
     * simi 取歌时的标签：**与第 6 步给模型看的标签同口径**。
     *
     * 原来这里只读 `track_tags`，而第 6 步在没打标时会用 `heuristicTag` 兜底 ——
     * 于是「分桶/加权用的标签」与「模型看到的标签」不是同一份：
     * 实测 3 首在取歌阶段算「无标签桶」的歌，最后带上了启发式的情歌标签，
     * 分桶统计与真实分布对不上。这里同步兜底，两边口径一致。
     */
    const tagsOfTrack = (t: Track): { styles: string[]; language: string } => {
      const hit = simiTags.get(t.id);
      if (hit && (hit.styles.length > 0 || hit.language)) return hit;
      return heuristicTag({
        name: t.name,
        artist: (t.ar ?? [])[0]?.name ?? '',
        album: t.al?.name ?? t.album?.name ?? '',
      });
    };
    const scoreOf = (t: Track): number => styleScore(tagsOfTrack(t), styleProfile);
    const ordered = simiTracks.sort((a, b) => {
      const sa = scoreOf(a);
      const sb = scoreOf(b);
      if (sa !== sb) return sb - sa; // 曲风匹配度高的优先
      // 匹配度相同：深挖优先，同一歌手内先给冷门（hot_rank 大）的，金曲占比自然被压低
      return (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0);
    });
    /**
     * ★ P1-H：**按 topStyle 分桶**占名额（每风格 ≤ K 首，K = `pool.simi_per_style`，默认 4）。
     *
     * 原来只按 styleScore 加权排序取前 simiCap 首 → 画像权重偏斜（华语流行 226 /
     * 情歌 173）时，名额几乎全被这两个风格吃掉（实测 simi 22/22 全带标签且集中在头部风格），
     * 尾部风格（独立/古风/古典…）与无标签新歌一首进不来 → 多样性崩塌。
     * 分桶是**加权不是过滤**：桶满只是让位给别的风格，二轮补位会把名额吃满。
     */
    const perStyleCap = numSetting('pool.simi_per_style', 4);
    const bucketGot = new Map<string, number>();
    const taken = new Set<string>();
    /**
     * 两轮取歌：
     *   一轮 —— 每风格 ≤ K（默认 4），保证尾部风格与无标签歌有位置；
     *   二轮 —— 名额没吃满时放宽到 ≤ 2K 补位（**不无限放宽**：无限放宽等于取消分桶，
     *            实测就是这样把 15 首情歌又全放回来、分桶白做）。
     * 仍未吃满就让它欠着：多样性优先于数量，池子缺口由流水补位（网友歌单/榜单）补。
     */
    for (const cap of [perStyleCap, perStyleCap * 2]) {
      for (const t of ordered) {
        if (added >= simiCap) break;
        if (taken.has(t.id)) continue;
        const bucket = styleBucket(tagsOfTrack(t), styleProfile);
        if ((bucketGot.get(bucket) ?? 0) >= cap) continue;
        if (push(t, 'simi')) {
          added += 1;
          taken.add(t.id);
          bucketGot.set(bucket, (bucketGot.get(bucket) ?? 0) + 1);
        }
      }
      if (added >= simiCap) break;
    }
    log.info(
      `相似歌手分桶取歌：每风格上限 ${perStyleCap}（补位 ${perStyleCap * 2}）→ 取 ${added}/${simiCap} 首，` +
        `风格分布 ${JSON.stringify(Object.fromEntries(bucketGot))}`
    );
  }

  // ---- 3) 网友歌单（未消耗的池子，以歌带单优先反查匹配）----
  {
    const db = getDatabase();
    const seedNames = seeds.map(s => s.name);
    // 找出与用户收藏曲目或种子歌手强相关的歌单 ID
    const relDissidRows = db
      .prepare(
        `SELECT DISTINCT pp.dissid
           FROM playlist_pool pp
          WHERE pp.consumed_at IS NULL
            AND (
              pp.dissid IN (
                SELECT pi.dissid FROM playlist_pool_items pi
                JOIN favorites f ON f.track_id = pi.track_id
                WHERE f.user_id = ?
              )
              OR pp.keyword IN (${seedNames.length > 0 ? seedNames.map(() => '?').join(',') : "''"})
            )`
      )
      .all(userId, ...seedNames) as unknown as Array<{ dissid: string }>;
    const relDissids = new Set(relDissidRows.map(r => r.dissid));

    // 先查相关歌单曲目，再查其余未消耗歌单曲目，按相关度优先
    const rows = db
      .prepare(
        `SELECT pi.dissid, pi.payload_json AS payload
           FROM playlist_pool pp JOIN playlist_pool_items pi ON pi.dissid = pp.dissid
          WHERE pp.consumed_at IS NULL
          ORDER BY pp.added_at DESC LIMIT ?`
      )
      .all(POOL_MAX * 2) as unknown as Array<{ dissid: string; payload: string }>;

    const relevantRows: Array<{ payload: string }> = [];
    const regularRows: Array<{ payload: string }> = [];
    for (const r of rows) {
      if (relDissids.has(r.dissid)) {
        relevantRows.push(r);
      } else {
        regularRows.push(r);
      }
    }

    const playlistCap = ratios ? Math.floor(POOL_MAX * SHARE.playlist) : POOL_MAX;
    let added = 0;
    for (const r of [...relevantRows, ...regularRows]) {
      if (added >= playlistCap) break;
      try {
        if (push(JSON.parse(r.payload) as Track, 'playlist')) added += 1;
      } catch {
        /* 坏数据跳过 */
      }
    }
  }

  // ---- 4) 本尊老歌（反向权重：收藏少的歌手优先）+ **专辑非主打深挖** ----
  {
    // 本尊老歌只从可进 TOP 池的种子取（refer 档 1-2 首不进 TOP 池）
    /**
     * 软排序（P0-C）：收藏率只做 **tie-breaker**，不做主排序键 ——
     * 原来按收藏率降序 + seedOldCap 截断 = 收藏率低的歌手被双重降权直接消失
     * （实测 seedOld 仅 5 首可选、SHARE 18 首配额永远吃不满）。
     * 主排序仍是反向权重（收藏数少的歌手优先，沿用原设计）；收藏率只在
     * 收藏数打平时把「听过但未收藏多」的排后面。降权 ≠ 取消资格。
     */
    const seedRates = favoriteRateByArtist(
      userId,
      poolSeeds.map(s => s.name)
    );
    const ordered = [...poolSeeds].sort((a, b) => {
      if (a.hits !== b.hits) return a.hits - b.hits; // 主排序：收藏数少优先（反向权重）
      const ra = seedRates.get(a.name) ?? 1;
      const rb = seedRates.get(b.name) ?? 1;
      return ra - rb; // tie-breaker：收藏率低（听过但未收藏多）= 弱正 = 排后面
    });
    const seedOldCap = ratios ? Math.floor(POOL_MAX * SHARE.seedOld) : POOL_MAX;
    /**
     * 保底名额（P0-C「保留最低保底名额」）：取歌循环按 round-robin 轮转，
     * 第一轮每位种子先各拿 1 个名额机会 —— 低收藏率歌手不再被彻底挤出。
     */
    const perSeedGot = new Map<string, number>();
    const countOf = (s: { mid: string }): number => perSeedGot.get(s.mid) ?? 0;
    let added = 0;
    const deepCutCache = new Map<string, Track[]>();
    const deepCutsFor = async (s: { name: string; mid: string }): Promise<Track[]> => {
      const hit = deepCutCache.get(s.mid);
      if (hit) return hit;
      const out = await deepCutsOf(s, 10);
      deepCutCache.set(s.mid, out);
      return out;
    };

    // 4a) 专辑非主打（这些才是"他很可能没听过"的）：**轮转取歌** ——
    // round-robin 第 round 顺位，天然每人先各 1 首（保底名额），低收藏率歌手不被挤出。
    for (let round = 0; round < 10 && added < seedOldCap; round += 1) {
      for (const s of ordered) {
        if (added >= seedOldCap) break;
        const cuts = await deepCutsFor(s);
        const t = cuts[round];
        if (!t) continue;
        if (push(t, 'seedOld')) {
          added += 1;
          perSeedGot.set(s.mid, countOf(s) + 1);
        }
      }
    }
    // 4b) 剩余名额用库内曲目兜底（同样轮转保底）
    //     ⚠️ 只认**首位歌手就是这位种子**的曲目：合辑里"某某参与合唱"的条目
    //     首位歌手是别人（实测混进来过《我的未来不是梦》挂在胡德夫名下却算本尊）
    const libCache = new Map<string, Track[]>();
    const libFor = (s: { mid: string }): Track[] => {
      const hit = libCache.get(s.mid);
      if (hit) return hit;
      const out = libraryTracksOf([s.mid]).filter(t => norm((t.ar ?? [])[0]?.mid ?? '') === norm(s.mid));
      libCache.set(s.mid, out);
      return out;
    };
    for (let round = 0; round < 20 && added < seedOldCap; round += 1) {
      for (const s of ordered) {
        if (added >= seedOldCap) break;
        const t = libFor(s)[round];
        if (!t) continue;
        if (push(t, 'seedOld')) {
          added += 1;
          perSeedGot.set(s.mid, countOf(s) + 1);
        }
      }
    }
  }

  // ---- 5) 巅峰榜 ----
  {
    const chartCap = ratios ? Math.floor(POOL_MAX * SHARE.chart) : POOL_MAX;
    let added = 0;
    for (const topId of CHART_TOPLIST_IDS) {
      if (added >= chartCap) break;
      if (!(await qqGate())) break;   // 冷却中：不再继续打上游，剩下的用已有来源兜
      try {
        const detail = await getToplistDetail(topId, 0, numSetting('pool.chart_top_n', CHART_TOP_N_DEFAULT));
        for (const t of detail.tracks) {
          if (added >= chartCap) break;
          if (push(t, 'chart')) added += 1;
        }
      } catch (err) {
        log.warn(`榜单 ${topId} 拉取失败：${(err as Error).message}`);
      }
    }
  }

  // ---- 5.5) 流水补位（Water-filling）：若池子不足 80 首，用网友歌单与榜单流水补齐 ----
  // 保底候选池充沛（>= 80 首），彻底消除少样本用户因某一来源空缺而导致下游 AI 选无可选
  const TARGET_MIN_POOL = 80;
  if (candidates.length < TARGET_MIN_POOL) {
    const deficit = TARGET_MIN_POOL - candidates.length;
    log.info(`候选池当前 ${candidates.length} 首，触发流水补位（目标 ≥ ${TARGET_MIN_POOL}，需补 ${deficit} 首）`);

    /**
     * ① 网友歌单流水补位（用户 2026-10-29 裁定：simi 欠额给**网友歌单**，不给榜单）。
     *
     * 三段递进，**绝不因为「歌单被消耗过」就放弃它里面的曲目** ——
     * `consumed_at` 只表示「这份歌单不再当新鲜歌单用」，里面的歌仍是有效曲目。
     * 实测线上 playlist_pool 40 份**全部已消耗**，只查 consumed_at IS NULL 会拿到 0 行，
     * 补位于是全部落到榜单（chart 30→36）—— 这正是用户要避免的。
     */
    const db = getDatabase();
    const fillFromPlaylist = (onlyFresh: boolean): number => {
      const rows = db
        .prepare(
          `SELECT pi.payload_json AS payload
             FROM playlist_pool pp JOIN playlist_pool_items pi ON pi.dissid = pp.dissid
            ${onlyFresh ? 'WHERE pp.consumed_at IS NULL' : ''}
            ORDER BY pp.added_at DESC LIMIT ?`
        )
        .all(POOL_MAX * 3) as unknown as Array<{ payload: string }>;
      let added = 0;
      for (const r of rows) {
        if (candidates.length >= TARGET_MIN_POOL || candidates.length >= POOL_MAX) break;
        try {
          if (push(JSON.parse(r.payload) as Track, 'playlist')) added += 1;
        } catch {
          /* 坏数据跳过 */
        }
      }
      return added;
    };

    // ①-a 先用未消耗的歌单（新鲜优先）
    fillFromPlaylist(true);
    // ①-b 仍有缺口 → 用已消耗歌单里的曲目（曲目本身仍然有效）
    if (candidates.length < TARGET_MIN_POOL) {
      const n = fillFromPlaylist(false);
      if (n > 0) log.info(`流水补位：从已消耗歌单再补 ${n} 首`);
    }
    // ①-c 仍有缺口 → 主动补池（拉新歌单），补完再取一次
    if (candidates.length < TARGET_MIN_POOL) {
      try {
        const refreshed = await refillPlaylistPool(userId);
        if (refreshed > 0) {
          log.info(`流水补位：网友歌单池已补充 ${refreshed} 份，重新取用`);
          fillFromPlaylist(true);
          if (candidates.length < TARGET_MIN_POOL) fillFromPlaylist(false);
        }
      } catch (err) {
        log.warn(`流水补位：补池失败 ${(err as Error).message}`);
      }
    }

    // ② 若仍不足，从榜单放宽深度拉取补位
    if (candidates.length < TARGET_MIN_POOL) {
      for (const topId of CHART_TOPLIST_IDS) {
        if (candidates.length >= TARGET_MIN_POOL || candidates.length >= POOL_MAX) break;
        if (!(await qqGate())) break;   // 冷却中：停止补位拉取，避免把限流窗口越拉越长
        try {
          const detail = await getToplistDetail(topId, 0, 60);
          for (const t of detail.tracks) {
            if (candidates.length >= TARGET_MIN_POOL || candidates.length >= POOL_MAX) break;
            push(t, 'chart');
          }
        } catch {
          /* 忽略单榜拉取失败 */
        }
      }
    }
    log.info(`流水补位完成，候选池扩充至 ${candidates.length} 首`);
  }

  // ---- 6) 补标签（受控分类 + 语种）与热度标记 ----
  const tagMap = tagsOf(candidates.map(c => c.track.id));
  const rankMap = hotRankOf(candidates.map(c => c.track.id));
  for (const c of candidates) {
    const t = tagMap.get(c.track.id);
    if (t && (t.styles.length > 0 || t.language)) {
      c.styles = t.styles;
      c.language = t.language;
    } else {
      const h = heuristicTag({
        name: c.track.name,
        artist: (c.track.ar ?? [])[0]?.name ?? '',
        album: c.track.al?.name ?? c.track.album?.name ?? '',
      });
      c.styles = h.styles;
      c.language = h.language;
    }
    const rank = rankMap.get(c.track.id);
    // 库内排名 ≤ 5 = 该歌手成名曲；专辑深挖/歌单/榜单来源没有排名，按非金曲处理
    c.hot = rank !== undefined && rank > 0 && rank <= 5;
  }

  const counts = emptyCounts();
  for (const c of candidates) counts[c.source] += 1;
  const hotCount = candidates.filter(c => c.hot === true).length;
  /**
   * 冷却池规模一并打出。
   *
   * 每天否决几十首的话，15 天窗口内会累积到几百首，池子会因此逐日变小 ——
   * 出现"数据不足"时先看这两个数，别再去怀疑用户收藏不够。
   */
  const rejStats = getRejectionStats(userId);
  log.info(
    `候选池 ${candidates.length} 首（相似歌手 ${counts.simi} / 网友歌单 ${counts.playlist} / ` +
      `本尊老歌 ${counts.seedOld} / 榜单 ${counts.chart} / **本尊新歌 ${counts.seedNew}**）· ` +
      `其中金曲（歌手热门前 5）${hotCount} 首 · 去重丢弃 ${droppedRef.n} · ` +
      `AI 冷却中 ${rejStats.cooling} 首 / 永久黑名单 ${rejStats.permanent} 首`
  );
  return { candidates, counts, dropped: droppedRef.n };
}

function emptyCounts(): Record<CandidateSource, number> {
  return { seedNew: 0, simi: 0, playlist: 0, seedOld: 0, chart: 0 };
}
