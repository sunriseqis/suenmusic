-- 网友分享歌单的曲目表。
--
-- ⚠️ 表名不能用 `playlist_items` —— 那是 App 自己歌单的表（006 迁移建的
-- playlist_items(playlist_id, track_id, position)）。009 里用了同一个名字，
-- `CREATE TABLE IF NOT EXISTS` 静默跳过，插入时报"没有 dissid 列"。
CREATE TABLE IF NOT EXISTS playlist_pool_items (
  dissid       TEXT    NOT NULL,
  track_id     TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (dissid, track_id)
);
