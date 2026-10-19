-- 用户风格画像：从收藏的实际分布里"称"出各风格的分量。
--
-- 为什么需要：风格关键词不能硬编码、也不能按歌手搜歌单（按歌手搜回来的
-- 就是他自己的曲库，等于白搜）。做法是拿风格词表当候选分类，对每个风格
-- 搜一批网友歌单，统计这些歌单里覆盖了用户收藏中的多少首歌 —— 那个数字
-- 就是该风格的实际权重，入库的歌单数量按权重分配（摇滚 10 首 > 情歌 8 首）。
CREATE TABLE IF NOT EXISTS user_style_profile (
  user_id    INTEGER NOT NULL,
  keyword    TEXT    NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 0,   -- 该风格覆盖到的收藏曲目数
  sample_ids TEXT    NOT NULL DEFAULT '',  -- 抽样收藏曲目 id（便于回溯"称"的依据）
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, keyword)
);
