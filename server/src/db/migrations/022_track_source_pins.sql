-- 曲目级「源钉」：用户在锚定页手动指定该曲**只用某个音源**（酷狗 / 网易云）。
--
-- 与 track_anchors 的分工：
--   track_anchors 存「这首曲 → 那个 B 站视频」的映射（bvid）；
--   本表存「这首曲只许走 X 源」的指令 —— X=酷狗时走 /v6/priv_url，
--   X=网易云时走网易云解析。resolve 顺序：pin 优先于默认链。
--
-- 为什么用独立表而不是扩 anchors：anchors 语义是 bvid（B 站视频），
-- 硬塞 source 会把两套概念搅在一起；pin 是解析顺序指令，不是映射。
CREATE TABLE IF NOT EXISTS track_source_pins (
  track_id   TEXT    PRIMARY KEY,
  source     TEXT    NOT NULL,             -- kugou | netease
  created_at INTEGER NOT NULL
);
