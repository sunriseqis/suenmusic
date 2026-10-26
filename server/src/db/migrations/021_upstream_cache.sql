-- 通用上游缓存表。
--
-- 为什么需要：QQ 音乐的专辑详情 / 歌手详情 / 歌手歌曲 / 歌手专辑 / 歌词
-- 这些响应都是**稳定数据**（一张专辑的曲目不会天天变），但此前只有内存 Map 缓存——
-- 进程一重启就全部清零，于是每次重启后都要把所有艺人和专辑重新打一遍上游，
-- 既慢又白白消耗 QQ 的频控额度（限流时返回 2001，整条链路退化）。
--
-- 口径（用户拍板）：缓存做成表、表是全局的，所有上游请求先查本地表，
-- 没有才去打上游。kind 区分业务类型，key 唯一标识一次请求，
-- payload_json 存原始适配结果，fetched_at 用于 TTL 判定与清理。
CREATE TABLE IF NOT EXISTS upstream_cache (
  kind       TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  payload_json TEXT  NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);

-- 启动清理按 fetched_at 扫全表删过期行，没有索引就是全表扫
CREATE INDEX IF NOT EXISTS idx_upstream_cache_fetched ON upstream_cache(fetched_at);
