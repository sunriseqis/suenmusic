-- 相似歌手名单缓存。
--
-- 网易云 simi 名单是**稳定数据**（一位歌手的相似歌手不会天天变），但接口有频控：
-- 实测被限流时返回 405，整条扩散链直接空掉（当天歌单从 27 首塌到 13 首）。
-- 缓存下来既省请求又抗限流；TTL 到期后再刷新。
CREATE TABLE IF NOT EXISTS artist_simi_cache (
  name       TEXT PRIMARY KEY,
  names_json TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL
);
