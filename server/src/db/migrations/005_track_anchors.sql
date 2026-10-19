-- 曲目 → B 站音源的锚定映射。
--
-- 与 play_sources（短 TTL 解析缓存）的分工：
--   play_sources 缓存的是「带签名时效的音频地址」，30 分钟内有效；
--   本表存的是「这首曲 → 那个视频」的映射本身，**永不过期**。
-- 有了它，播放时只需要重新取流（view + playurl，两次轻请求），
-- 不再需要「搜索 + 打分」这套重流程，也不会因缓存过期而反复打搜索接口。
--
-- pinned = 1 表示用户在锚定弹窗里手动选定的（最高优先级，自动沉淀不得覆盖）；
-- pinned = 0 表示自动匹配成功后顺手沉淀的映射。
CREATE TABLE IF NOT EXISTS track_anchors (
  track_id     TEXT PRIMARY KEY,
  bvid         TEXT    NOT NULL,
  title        TEXT    NOT NULL DEFAULT '',
  author       TEXT    NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL DEFAULT 0,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
