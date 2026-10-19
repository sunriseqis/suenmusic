-- 曲目在"该歌手热门歌"里的排名（1 = 最热）。
--
-- 为什么需要：金曲/冷门的判定不该交给模型（弱模型不认识歌就抓瞎，强模型也不稳定）。
-- 而 `getArtistSongs` 返回的**就是按热度排序的前 30 首**，排名本身就是确定性信号：
--   hot_rank ≤ 5  → 该歌手的成名曲（金曲）
--   hot_rank > 5  → 相对冷门/非主打
-- 有了它，"金曲最多几首"就变成代码能算的规则，与模型能力无关。
ALTER TABLE library_tracks ADD COLUMN hot_rank INTEGER NOT NULL DEFAULT 0;
