-- 器乐/翻奏/片段判定（2026-10-29 用户裁定：方案 B —— 单独一个布尔维度，不塞进风格词表）
--
-- 为什么单开一列、而不是往 STYLE_VOCAB 里加「器乐」：
--   2026-09-15 用户砍掉的是「气质/手法」这一类**风格词**；而「是不是器乐/翻奏/片段」
--   是**能不能进歌单**的准入维度，与风格正交（一首古风可以有人声，一首钢琴曲也可以是古典）。
--   混进风格词表会让 user_style_profile 的统计口径被污染（器乐不是口味，是内容类型）。
--
-- 为什么必须是 AI 打标、而不是关键词表：
--   实测漏网样本 北国之春 | 刘慧敏 | 专辑 琴意绵绵Ⅱ | 205s —— 曲名干净、歌手不在已知
--   名单、专辑名不含「钢琴/纯音乐」。器乐专辑的命名是**无限的**（琴意绵绵/夜色/镜夜/延禧…），
--   关键词方案永远追不上；AI 认得「琴意绵绵」是琴曲集，这是关键词给不了的常识。
--   关键词判定（services/content-filter.ts isCoverOrInstrumental）保留为**第一道防线**，
--   能抓的当场抓掉，不用等打标。
--
-- 取值：
--   NULL = 未判定（新入库还没打标 —— 召回时**不拦**，等打标补齐）
--   0    = 正常歌曲（有人声演唱）
--   1    = 器乐 / 翻奏 / 纯音乐 / 片段 → 召回入池时直接丢弃
ALTER TABLE track_tags ADD COLUMN is_instrumental INTEGER DEFAULT NULL;

-- 召回时按字段过滤要快：建池阶段一次性把 is_instrumental = 1 的 track_id 取进内存
CREATE INDEX IF NOT EXISTS idx_track_tags_instrumental ON track_tags (is_instrumental);
