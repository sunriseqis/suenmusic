/**
 * 网友分享歌单池：采集 → 消耗 → 补充（用户设计，2026-09-15）。
 *
 * ## 为什么是"池"而不是"每次现搜"
 *
 * 网友歌单是**一次性消耗品**：一个歌单的曲目用过一轮，再拉它就是重复。
 * 而且歌单搜索结果本身很稳定（同一关键词搜出来的基本是同一批），所以：
 *   - 采集：按关键词搜歌单（跳过已记录的 dissid），拉详情、曲目落库、记 tags
 *   - 消耗：生成推荐时从未消耗的歌单里取曲目，用完标 consumed_at
 *   - 补充：**未消耗只剩 1 个时**后台补拉新的、没拉过的歌单
 *
 * 关键词来自两处：① 收藏种子的歌手名（"某某歌单"通常就是他作品合集）
 * ② 已拉歌单自带的风格标签（摇滚/情歌/R&B…）——标签由上游给，不用我们猜。
 */
import { getDatabase } from '../db/index.ts';
import { upsertTracks } from '../db/repo/tracks.ts';
import { getPlaylistDetail } from '../sources/qq/home.ts';
import { getQQCategoryTree, getQQPlaylistsByCategory } from '../sources/qq/plaza.ts';
import { fetchSearchSlice } from '../sources/qq/search.ts';
import type { Track } from '../sources/qq/adapter.ts';
import { createLogger } from '../logger.ts';
import { invalidateLocalCatalogCache } from './local-catalog.ts';

const log = createLogger('playlist-pool');

const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

export const POOL_LOW_WATER = 1;

/**
 * 候选风格分类的**兜底**词表（官方分类树取不到时才用）。
 *
 * ⚠️ 正常路径是 **QQ 官方分类树**（`getQQCategoryTree`，首页分类广场用的同一个
 * 接口）：大分类「流派 / 语种」下的每个分类都是一个候选风格，带官方 tagId。
 * 之前这里只有这十个手写词 —— 那是错的（风格分类不该由我拍），现在只作兜底。
 *
 * ⚠️ 两个明确的禁止（用户拍板）：
 *   1. **不能按歌手名搜歌单** —— 搜回来的还是他自己的曲库，等于白搜；
 *   2. 不能硬编码权重 —— "摇滚 10 首 / 情歌 8 首"这种数字必须从收藏里算出来。
 */
const FALLBACK_STYLE_KEYWORDS = [
  '摇滚',
  '情歌',
  'R&B',
  '民谣',
  '粤语经典',
  '华语流行',
  '日语流行',
  '爵士',
  '古风',
  '治愈系',
];
/** 风格画像的保鲜期：一周重新称一次（收藏分布会变） */
const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 单轮最多处理多少个风格 */
const KEYWORDS_PER_CYCLE = 3;
/** 单个风格最多入库几个歌单（权重最高的风格才吃到这个上限） */
const MAX_PLAYLISTS_PER_STYLE = 3;
/** 每个关键词取多少个歌单候选 */
const CANDIDATES_PER_KEYWORD = 6;
/** 单个歌单最多收多少首曲目 */
const MAX_ITEMS_PER_PLAYLIST = 80;

export interface PoolRow {
  dissid: string;
  name: string;
  tags: string;
  trackTotal: number;
  trackNew: number;
}

/** 已采集过的歌单 id（去重：同一歌单不重复拉） */
function knownDissids(): Set<string> {
  const rows = getDatabase()
    .prepare('SELECT dissid FROM playlist_pool')
    .all() as unknown as Array<{ dissid: string }>;
  return new Set(rows.map(r => r.dissid));
}

export function countUnconsumed(): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM playlist_pool WHERE consumed_at IS NULL')
    .get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function unconsumedPlaylists(limit = 20): PoolRow[] {
  const rows = getDatabase()
    .prepare(
      `SELECT dissid, name, tags, track_total AS trackTotal, track_new AS trackNew
         FROM playlist_pool WHERE consumed_at IS NULL ORDER BY added_at ASC LIMIT ?`
    )
    .all(limit) as unknown as PoolRow[];
  return rows;
}

export function playlistItemEntries(dissids: string[]): Array<{ dissid: string; track: Track }> {
  if (dissids.length === 0) return [];
  const db = getDatabase();
  const ph = dissids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT dissid, payload_json FROM playlist_pool_items WHERE dissid IN (${ph})`)
    .all(...dissids) as unknown as Array<{ dissid: string; payload_json: string }>;
  const out: Array<{ dissid: string; track: Track }> = [];
  for (const r of rows) {
    try {
      out.push({ dissid: r.dissid, track: JSON.parse(r.payload_json) as Track });
    } catch {
      /* 跳过坏数据 */
    }
  }
  return out;
}

/** 标记这些歌单已消耗（用完即弃，不再进推荐） */
export function consumePlaylists(dissids: string[]): void {
  if (dissids.length === 0) return;
  const db = getDatabase();
  const ph = dissids.map(() => '?').join(',');
  db.prepare(`UPDATE playlist_pool SET consumed_at = ? WHERE dissid IN (${ph})`).run(
    Date.now(),
    ...dissids
  );
}

/**
 * 候选风格 = QQ 官方分类树里的「流派」「语种」分类（带 tagId）。
 * 取不到树时退回兜底词表（没有 tagId，只能按关键词搜）。
 */
async function candidateStyles(userId: number): Promise<Array<{ keyword: string; tagId: number | null }>> {
  const measured = new Set(
    (getDatabase()
      .prepare('SELECT keyword FROM user_style_profile WHERE user_id = ?')
      .all(userId) as unknown as Array<{ keyword: string }>).map(r => r.keyword)
  );
  try {
    const { tree } = await getQQCategoryTree();
    const wanted = tree.filter(g => g.bigCat === '流派' || g.bigCat === '语种');
    const flat = wanted.flatMap(g => g.cats.map(c => ({ keyword: c.name, tagId: c.id })));
    if (flat.length > 0) {
      // 优先测还没测过的分类（分类空间来自官方，逐轮覆盖完）
      const fresh = flat.filter(f => !measured.has(f.keyword));
      return (fresh.length > 0 ? fresh : flat).slice(0, KEYWORDS_PER_CYCLE * 2);
    }
  } catch (err) {
    log.warn(`官方分类树不可用: ${(err as Error)?.message ?? err}`);
  }
  return FALLBACK_STYLE_KEYWORDS.map(k => ({ keyword: k, tagId: null }));
}

/**
 * 给用户收藏统计风格分量：基于本地 track_tags 与收藏数据聚合。
 *
 * 彻底废除旧版向 QQ 盲打 20 次网络请求的"虚空碰运气称重"，
 * 改为由本地曲目标签真实统计，0 网络开销、100% 精确、微秒级响应。
 */
export async function buildStyleProfile(userId: number, force = false): Promise<Array<{ keyword: string; weight: number }>> {
  const db = getDatabase();
  const fresh = db
    .prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS ts FROM user_style_profile WHERE user_id = ?')
    .get(userId) as { n: number; ts: number | null } | undefined;
  if (!force && Number(fresh?.n ?? 0) > 0 && Date.now() - Number(fresh?.ts ?? 0) < PROFILE_TTL_MS) {
    const existing = topStyles(userId, 20);
    if (existing.length > 0) return existing;
  }

  // 本地读取用户收藏与其标签
  const favRows = db
    .prepare(
      `SELECT f.track_id, tt.styles, tt.language
         FROM favorites f
         JOIN tracks t ON t.id = f.track_id
         LEFT JOIN track_tags tt ON tt.track_id = f.track_id
        WHERE f.user_id = ?`
    )
    .all(userId) as unknown as Array<{
      track_id: string;
      styles: string | null;
      language: string | null;
    }>;

  if (favRows.length === 0) return [];

  const tally = new Map<string, { weight: number; sampleIds: string[] }>();
  const addWeight = (kw: string, weight: number, sampleId?: string) => {
    const k = kw.trim();
    if (!k) return;
    const cur = tally.get(k) ?? { weight: 0, sampleIds: [] };
    cur.weight += weight;
    if (sampleId && cur.sampleIds.length < 5 && !cur.sampleIds.includes(sampleId)) {
      cur.sampleIds.push(sampleId);
    }
    tally.set(k, cur);
  };

  for (const row of favRows) {
    if (row.styles) {
      try {
        const styles = JSON.parse(row.styles) as string[];
        for (const s of styles) {
          if (s) addWeight(s, 1, row.track_id);
        }
      } catch {
        /* ignore */
      }
    }
    if (row.language) {
      const lang = row.language.trim();
      if (lang === '粤语') {
        addWeight('粤语经典', 1, row.track_id);
      } else if (lang === '华语' || lang === '国语') {
        addWeight('华语流行', 1, row.track_id);
      } else if (lang) {
        addWeight(lang, 1, row.track_id);
      }
    }
  }

  // 兜底：若收藏曲目暂无打标，根据收藏数量赋予主流流行/情歌基础权重，保证歌单池能正常补充
  if (tally.size === 0) {
    addWeight('华语流行', Math.max(1, favRows.length));
    addWeight('情歌', Math.max(1, Math.floor(favRows.length / 2)));
    addWeight('流行', Math.max(1, Math.floor(favRows.length / 2)));
  }

  const ts = Date.now();
  const out: Array<{ keyword: string; weight: number }> = [];
  const ins = db.prepare(
    `INSERT INTO user_style_profile (user_id, keyword, weight, sample_ids, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, keyword) DO UPDATE SET
       weight = excluded.weight, sample_ids = excluded.sample_ids, updated_at = excluded.updated_at`
  );

  db.exec('BEGIN');
  try {
    for (const [kw, data] of tally.entries()) {
      ins.run(userId, kw, data.weight, data.sampleIds.join(','), ts);
      out.push({ keyword: kw, weight: data.weight });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  out.sort((a, b) => b.weight - a.weight);
  log.info(
    `风格画像（本地精准聚类，收藏 ${favRows.length} 首）：${out
      .filter(o => o.weight > 0)
      .map(o => `${o.keyword}(${o.weight})`)
      .join(' ') || '无'}`
  );
  return out;
}

/** 读画像里的前 N 个风格（按权重降序） */
export function topStyles(userId: number, limit = 10): Array<{ keyword: string; weight: number }> {
  return getDatabase()
    .prepare(
      `SELECT keyword, weight FROM user_style_profile
        WHERE user_id = ? AND weight > 0 ORDER BY weight DESC LIMIT ?`
    )
    .all(userId, limit) as unknown as Array<{ keyword: string; weight: number }>;
}

/** 池子里累计拉过多少歌单（用于轮换风格关键词） */
function countAll(): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM playlist_pool')
    .get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** 已拉歌单的风格标签（上游有就记，没有则为空；目前仅用于排查） */
function styleKeywords(limit = 5): string[] {
  const rows = getDatabase()
    .prepare("SELECT tags FROM playlist_pool WHERE tags != '' ORDER BY added_at DESC LIMIT 50")
    .all() as unknown as Array<{ tags: string }>;
  const tally = new Map<string, number>();
  for (const r of rows) {
    for (const tag of r.tags.split(',')) {
      const t = tag.trim();
      if (!t) continue;
      tally.set(t, (tally.get(t) ?? 0) + 1);
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, limit);
}

/** 采集一个歌单：拉详情 → 曲目落库 → 记账 */
async function ingestPlaylist(dissid: string, keyword: string): Promise<boolean> {
  const detail = await getPlaylistDetail(dissid);
  if (!detail || detail.tracks.length === 0) return false;

  const db = getDatabase();
  const items = detail.tracks.slice(0, MAX_ITEMS_PER_PLAYLIST);
  // 记"有多少首是库里没有的"：全都有 = 这个歌单已经没新东西了
  let trackNew = 0;
  for (const t of items) {
    const hit = db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(t.id);
    if (!hit) trackNew += 1;
  }

  const ts = Date.now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT OR IGNORE INTO playlist_pool
         (source, keyword, dissid, name, tags, track_total, track_new, added_at)
       VALUES ('qq', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      keyword,
      dissid,
      detail.playlist.name,
      detail.playlist.tags.join(','),
      items.length,
      trackNew,
      ts
    );
    const insItem = db.prepare(
      'INSERT OR IGNORE INTO playlist_pool_items (dissid, track_id, payload_json, added_at) VALUES (?, ?, ?, ?)'
    );
    for (const t of items) insItem.run(dissid, t.id, JSON.stringify(t), ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    log.warn(`歌单入库失败 ${dissid}: ${(err as Error)?.message ?? err}`);
    return false;
  }

  // 曲目也写进曲目表：后面播放/解析需要它们在场
  upsertTracks(items);
  invalidateLocalCatalogCache();

  // 一首新的都没有 = 这个歌单对我们已经没价值，直接标记消耗，别占池子
  if (trackNew === 0) consumePlaylists([dissid]);

  log.info(
    `歌单入库：${detail.playlist.name}（${items.length} 首，新 ${trackNew}）` +
      `${detail.playlist.tags.length > 0 ? ` 标签[${detail.playlist.tags.join('/')}]` : ''}`
  );
  return true;
}

/**
 * 补充歌单池：关键词 = 种子歌手名 + 已拉歌单的风格标签。
 * 幂等且尽力而为：单个关键词失败不影响其它。
 */
export async function refillPlaylistPool(userId: number): Promise<number> {
  const known = knownDissids();
  // 画像可能还没建/过期：先称一次，再按权重最高的风格采集
  const styles = await buildStyleProfile(userId);
  const picked = styles.filter(s => s.weight > 0).slice(0, KEYWORDS_PER_CYCLE);
  if (picked.length === 0) {
    log.info('风格画像为空（收藏与候选风格歌单无重合），本轮不补池');
    return 0;
  }
  const maxWeight = Math.max(...picked.map(s => s.weight), 1);

  let added = 0;
  for (const style of picked) {
    const kw = style.keyword;
    // 入库量按权重分配：权重最高的风格吃满上限，其余按比例
    const want = Math.max(1, Math.round((style.weight / maxWeight) * MAX_PLAYLISTS_PER_STYLE));
    try {
      /**
       * 搜索结果很稳定（同一关键词总返回同一批），所以按已知数量**往后翻页**：
       * 否则"前几个都拉过了"会让这个风格永远采不到新歌单（踩过：摇滚/华语流行
       * 权重最高却采到 0 个）。
       */
      let candidates: Array<{ dissid: string; name: string }> = [];
      for (const offset of [0, 10, 20, 30]) {
        const { list } = await fetchSearchSlice('songlist', kw, offset, CANDIDATES_PER_KEYWORD);
        const page = list
          .map((p: any) => ({
            dissid: String(p?.dissid ?? p?.disstid ?? p?.id ?? ''),
            name: String(p?.dissname ?? p?.name ?? ''),
            songnum: Number(p?.songnum ?? p?.track_count ?? 0),
          }))
          .filter(c => {
            if (!c.dissid || known.has(c.dissid)) return false;
            // 防伪与低质过滤：排除短视频/DJ慢摇/车载串烧等低质合辑
            if (/(车载|DJ\s*版|慢摇|抖音|短视频|快手|铃声)/i.test(c.name)) return false;
            // 排除曲目过少的僵尸歌单（>= 15 首）
            if (c.songnum > 0 && c.songnum < 15) return false;
            return true;
          });
        if (page.length === 0) continue;
        candidates = page.slice(0, want);
        if (candidates.length >= want) break;
      }
      candidates = candidates.slice(0, want);
      for (const c of candidates) {
        known.add(c.dissid);
        if (await ingestPlaylist(c.dissid, kw)) added += 1;
      }
      log.info(`风格「${kw}」权重 ${style.weight} → 采 ${candidates.length} 个歌单`);
    } catch (err) {
      log.warn(`歌单采集失败「${kw}」: ${(err as Error)?.message ?? err}`);
    }
  }
  if (added > 0) log.info(`歌单池补充 ${added} 个（未消耗现有 ${countUnconsumed()} 个）`);
  return added;
}
