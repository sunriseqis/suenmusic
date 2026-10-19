-- 曲库池（每日推荐快路径的数据底座）+ 推荐黑名单。
--
-- 设计要点（2026-09-11 与用户对齐）：
--   * 歌手实体全局共享：A 建库拉了周杰伦，B 的池子要周杰伦时只加归属关联，
--     热门歌不重拉（library_artists 是唯一实体，library_user_artists 是归属）。
--   * 曲库曲目自带 payload 快照，不依赖 tracks 表 —— 那张表有 30 天清理任务，
--     曲库引用的行不能被它顺带清掉。
--   * 建库是懒启动分阶段的：生成时只入队，后台单飞循环逐条拉取。
--
-- user_dislikes：推荐黑名单（按用户）。歌曲不喜欢按曲目 id，歌手不喜欢按 mid；
-- name 冗余存一份，设置页黑名单列表直接显示，不用回查。

CREATE TABLE IF NOT EXISTS library_artists (
  mid            TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  hot_fetched_at INTEGER
);

CREATE TABLE IF NOT EXISTS library_user_artists (
  user_id    INTEGER NOT NULL,
  artist_mid TEXT    NOT NULL,
  origin     TEXT    NOT NULL DEFAULT '',
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, artist_mid)
);

CREATE TABLE IF NOT EXISTS library_tracks (
  id           TEXT PRIMARY KEY,
  artist_mid   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  added_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_tracks_artist ON library_tracks (artist_mid);

CREATE TABLE IF NOT EXISTS library_build_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  origin     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_dislikes (
  user_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, type, target_id)
);
