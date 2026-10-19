-- play_sources 增加封面列：B 站取流时的视频封面顺路缓存。
--
-- 用途：曲目没有 Q 音专辑封面时（同人翻唱/非专辑上传），客户端用这份
-- B 站视频封面做显示层兜底。仅为展示数据，不代表真实专辑归属。

ALTER TABLE play_sources ADD COLUMN cover_url TEXT NOT NULL DEFAULT '';
