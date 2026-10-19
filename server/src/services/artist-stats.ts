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
    n: number;
  }>;
  return rows.map(r => ({ name: r.artist_name, count: Number(r.n) }));
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
