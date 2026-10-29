/**
 * 收藏歌手的统计口径 —— 画像、选曲、候选池三处共用。
 *
 * 为什么必须收成一个模块：同一段"收藏歌手排行"的 SQL 原本在四处各写了一遍
 * （ai-memory / ai-decide / ai-flow / library-topup），口径一旦不同，
 * "谁是头部歌手"就会各处不一致 —— 而"头部歌手每天不要霸占歌单"这条规则
 * 恰恰依赖这个判定，口径飘了规则就失效。
 */
import { getDatabase } from '../db/index.ts';

export interface ArtistFavoriteCount {
  name: string;
  count: number;
  /**
   * 该歌手的 **mid**（`artists_json[0].mid`，与 count 同口径）。
   *
   * 为什么要把 mid 一并带出来：候选池 `push` 的 TOP / refer 拦截如果只比名字，
   * 上游同一歌手的写法不一致（「五月天」/「五月天 阿信」）就拦不住（P1-A）。
   * 名字做兜底（歌单/榜单来源可能缺 mid），mid 做精确匹配。
   */
  mid?: string;
}

/**
 * 头部歌手的判定线：收藏曲目数 **大于** 这个值的歌手算 TOP。
 *
 * 用户口径（2026-09-22 拍板）：>10 首即 TOP。
 * 实测生产数据是断崖式的 —— 周杰伦 34 首、五月天 28 首，第三名只有 6 首，
 * 所以这条线能把"真正的头部"跟"普通常听"干净分开。
 */
export const TOP_ARTIST_MIN_FAVORITES = 10;

/**
 * 熟悉度阈值（用户 2026-10-29 拍板，阈值 5）。
 *
 * 收藏曲目数分档（规则写在建池层，模型看不见就不会违反）：
 *   1-2 首 → 只喜欢这几首歌（只作曲风参考，**不进 TOP 池**）
 *   3-4 首 → 算喜欢（可推，新歌优先）
 *   ≥5 首 → 深度喜欢（进 TOP 池、新歌必推）
 *   ≥10 首 → 巨量（筛过的）（TOP 池 + 降频、新歌必推）
 */
export const FAMILIAR_MIN_REFER = 1; // 1-2 首只作曲风参考
export const FAMILIAR_MAX_REFER = 2;
export const FAMILIAR_MIN_LIKED = 3; // 3-4 首算喜欢
export const FAMILIAR_MAX_LIKED = 4;
export const FAMILIAR_MIN_TOP = 5; // ≥5 进 TOP 池

/**
 * 歌手熟悉度分档。
 * `refer` = 只作曲风参考（1-2 首收藏）；`liked` = 算喜欢（3-4 首）；
 * `top` = 进 TOP 池（≥5 首）；`huge` = 巨量（≥10 首，TOP 池 + 降频）。
 */
export type FamiliarityTier = 'refer' | 'liked' | 'top' | 'huge';

export function familiarityTier(hits: number): FamiliarityTier {
  if (hits >= TOP_ARTIST_MIN_FAVORITES) return 'huge';
  if (hits >= FAMILIAR_MIN_TOP) return 'top';
  if (hits >= FAMILIAR_MIN_LIKED) return 'liked';
  return 'refer';
}

/**
 * 头部歌手的冷却天数：某位 TOP 歌手一旦进了推荐，这么多天内不再放它进候选池。
 *
 * 用户口径：4 天。目的不是"永不再推"，而是干掉"每天必进"。
 */
export const TOP_ARTIST_COOLDOWN_DAYS = 4;

/** 收藏歌手排行（按收藏曲目数降序） */
export function favoriteArtistRanking(userId: number, limit = 20): ArtistFavoriteCount[] {
  const rows = getDatabase()
    .prepare(
      `SELECT json_extract(je.value, '$.name') AS artist_name, COUNT(DISTINCT f.track_id) AS n
         FROM favorites f JOIN tracks t ON t.id = f.track_id, json_each(t.artists_json) je
        WHERE f.user_id = ? AND json_extract(je.value, '$.name') != ''
        GROUP BY artist_name ORDER BY n DESC LIMIT ?`
    )
    .all(userId, limit) as unknown as Array<{ artist_name: string; n: number }>;
  return rows.map(r => ({ name: r.artist_name, count: Number(r.n) }));
}

/**
 * TOP 歌手名单（收藏曲目数 > TOP_ARTIST_MIN_FAVORITES）。
 *
 * 注意取的是**每首曲目的第一歌手**（`artists_json[0]`），与候选池里
 * `track.ar[0].name` 的用法保持一致 —— 否则"五月天"与"五月天 阿信"这类
 * 拆分写法会让冷却判不到，规则静默失效。
 */
export function topArtists(userId: number): ArtistFavoriteCount[] {
  const rows = getDatabase()
    .prepare(
      `SELECT json_extract(t.artists_json, '$[0].name') AS artist_name,
              MAX(json_extract(t.artists_json, '$[0].mid')) AS mid,
              COUNT(DISTINCT f.track_id) AS n
         FROM favorites f JOIN tracks t ON t.id = f.track_id
        WHERE f.user_id = ?
          AND json_extract(t.artists_json, '$[0].name') IS NOT NULL
          AND json_extract(t.artists_json, '$[0].name') != ''
        GROUP BY artist_name
       HAVING n > ?
        ORDER BY n DESC`
    )
    .all(userId, TOP_ARTIST_MIN_FAVORITES) as unknown as Array<{
    artist_name: string;
    mid: string | null;
    n: number;
  }>;
  return rows.map(r => ({
    name: r.artist_name,
    count: Number(r.n),
    mid: r.mid ? String(r.mid) : undefined,
  }));
}

/**
 * 处于冷却期的 TOP 歌手：近 `days` 天内进过推荐。
 *
 * 数据源是 `recommend_history.artist`（写入时取的就是曲目第一歌手）。
 * 已实测：该列出现过的 157 个歌手名与曲目库**100% 精确匹配**，
 * 不需要额外的名字归一化。
 */
export function coolingArtists(userId: number, days = TOP_ARTIST_COOLDOWN_DAYS): Set<string> {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = getDatabase()
    .prepare(
      `SELECT DISTINCT artist FROM recommend_history
        WHERE user_id = ? AND created_at > ? AND artist != ''`
    )
    .all(userId, since) as unknown as Array<{ artist: string }>;
  return new Set(rows.map(r => r.artist));
}

/**
 * 距上次出现在推荐里最久的那位 TOP 歌手 —— 多个 TOP 同时够格时用它挑一个。
 *
 * 用户口径：每天最多放**一个** TOP 歌手进池；同时符合多个时，
 * 优先选"最久没出现的"那个，让几位头部歌手**交替**出场，
 * 而不是永远同一个。从未出现过的排最前。
 */
export function pickTopArtistForToday(userId: number, candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT artist, MAX(created_at) AS last_at FROM recommend_history
        WHERE user_id = ? AND artist IN (${candidates.map(() => '?').join(',')})
        GROUP BY artist`
    )
    .all(userId, ...candidates) as unknown as Array<{ artist: string; last_at: number }>;
  const lastAt = new Map(row.map(r => [r.artist, Number(r.last_at)]));
  // 从未出现过的（last_at 缺失）视为最久未出现
  return [...candidates].sort((a, b) => (lastAt.get(a) ?? 0) - (lastAt.get(b) ?? 0))[0] ?? null;
}

/**
 * 未收藏 = 弱负信号（用户 2026-10-29）：从 favorites 反推「收藏 X 首 / 该歌手总 Y 首」，
 * 即该歌手的**收藏率**。收藏率越低 = 听过但未收藏越多 = 越弱的正信号。
 *
 * 用途：候选池里同歌手的歌按收藏率**降权**（不取消资格，给「没想起来」留口子）。
 * 分母取 `tracks` 表**全曲目**（不限建库）—— 实测 `library_tracks` 覆盖率太低
 * （uid=1 的 151 个收藏歌手里 114 个 libTot=0，分母为 0 → 收藏率一律 0，弱负信号失效），
 * 而 `tracks` 表是收藏/推荐全链路的曲目快照，按首歌手 join 覆盖所有收藏歌手（实测 0 缺失）。
 * 不依赖 play_history —— 历史/播放记录不作为建库/选歌参考，见目标模型 2026-10-29 用户裁定。
 *
 * @returns name -> 收藏率（0~1）。**库内/曲目表无该歌手曲目（分母 0）时返回 1（不降权）**：
 * 分母缺失是数据缺口而非「听过没收藏」，此时若按 0 处理会把歌手一棍子打死（P0-B）。
 * fav > total（口径差）时截到 1。
 */
export function favoriteRateByArtist(userId: number, artistNames: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (artistNames.length === 0) return out;
  const db = getDatabase();
  const holes = artistNames.map(() => '?').join(',');
  // 分母：tracks 表该歌手（首歌手）全曲目数（不限建库）
  const totals = db
    .prepare(
      `SELECT json_extract(artists_json, '$[0].name') AS an, COUNT(*) AS n
        FROM tracks
       WHERE json_extract(artists_json, '$[0].name') IN (${holes})
       GROUP BY an`
    )
    .all(...artistNames) as unknown as Array<{ an: string; n: number }>;
  const totalBy = new Map(totals.map(r => [r.an, Number(r.n)]));
  // 分子：该歌手被收藏的曲目数（与 topArtists 同口径：第一歌手）
  const favs = db
    .prepare(
      `SELECT json_extract(t.artists_json, '$[0].name') AS an, COUNT(DISTINCT f.track_id) AS n
        FROM favorites f JOIN tracks t ON t.id = f.track_id
       WHERE f.user_id = ? AND json_extract(t.artists_json, '$[0].name') IN (${holes})
       GROUP BY an`
    )
    .all(userId, ...artistNames) as unknown as Array<{ an: string; n: number }>;
  const favBy = new Map(favs.map(r => [r.an, Number(r.n)]));
  for (const name of artistNames) {
    const total = totalBy.get(name) ?? 0;
    const fav = favBy.get(name) ?? 0;
    out.set(name, total > 0 ? Math.min(1, fav / total) : 1);
  }
  return out;
}

/**
 * 所有「1-2 首收藏」的歌手名（refer 档，只作曲风参考、不进 TOP 池）。
 *
 * 与 `seedArtists`（取 top-20）不同：这里取**全部**收藏数 1-2 的歌手 ——
 * 熟悉度阈值要求「1-2 首歌手的歌根本不进 TOP 池」，必须覆盖所有 refer 档歌手，
 * 不能只看 top-20（top-20 基本都是 >=3 首，refer 档都在后面）。
 *
 * @returns 歌手名集合（**第一歌手口径**，与 topArtists/seedArtists 一致 —— 2026-10-29 修复批 3-A 起
 * `seedArtists` 也改用 `artists_json[0]`，不再对合唱双计，两边分档不会再打架）
 */
export function referTierArtists(userId: number): ArtistFavoriteCount[] {
  const rows = getDatabase()
    .prepare(
      `SELECT json_extract(t.artists_json, '$[0].name') AS an,
              MAX(json_extract(t.artists_json, '$[0].mid')) AS mid,
              COUNT(DISTINCT f.track_id) AS n
         FROM favorites f JOIN tracks t ON t.id = f.track_id
        WHERE f.user_id = ?
          AND json_extract(t.artists_json, '$[0].name') IS NOT NULL
          AND json_extract(t.artists_json, '$[0].name') != ''
        GROUP BY an
       HAVING n BETWEEN 1 AND 2`
    )
    .all(userId) as unknown as Array<{ an: string; mid: string | null; n: number }>;
  return rows.map(r => ({
    name: r.an,
    count: Number(r.n),
    mid: r.mid ? String(r.mid) : undefined,
  }));
}

/**
 * refer 档歌手名集合（名字口径）。
 *
 * ⚠️ 只是 `referTierArtists` 的便利封装 —— 候选池的拦截请优先用带 mid 的版本：
 * 上游同一歌手的名字写法会飘（「五月天」/「五月天 阿信」），只比名字会漏拦（P1-A）。
 */
export function referTierArtistNames(userId: number): Set<string> {
  return new Set(referTierArtists(userId).map(a => a.name));
}
