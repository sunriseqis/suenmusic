-- 网友分享歌单池：采集 → 消耗 → 补充（用户设计，2026-09-15）
--
-- 为什么要有池：网友歌单是**一次性消耗品** —— 一个歌单的曲目用完（都进过推荐）
-- 再拉它就是重复。所以要记下"拉过哪些、每个歌单有多少首是新入库的、是否已消耗"，
-- 未消耗的只剩 1 个时后台补拉新的、没拉过的歌单。
CREATE TABLE IF NOT EXISTS playlist_pool (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL DEFAULT 'qq',   -- qq（网易云待接）
  keyword     TEXT    NOT NULL DEFAULT '',     -- 触发采集的关键词：歌手名 / 风格标签
  dissid      TEXT    NOT NULL,                -- 歌单 id（去重的依据）
  name        TEXT    NOT NULL DEFAULT '',
  tags        TEXT    NOT NULL DEFAULT '',     -- 风格标签，用于"按风格找更多歌单"
  track_total INTEGER NOT NULL DEFAULT 0,
  track_new   INTEGER NOT NULL DEFAULT 0,      -- 采集时有多少首是库里没有的
  added_at    INTEGER NOT NULL,
  consumed_at INTEGER,                         -- NULL = 还没被推荐用过
  UNIQUE (source, dissid)
);

CREATE INDEX IF NOT EXISTS idx_playlist_pool_unconsumed
  ON playlist_pool (consumed_at, added_at);

-- 歌单里的曲目（消耗时从这里取歌）
CREATE TABLE IF NOT EXISTS playlist_items (
  dissid       TEXT    NOT NULL,
  track_id     TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (dissid, track_id)
);
