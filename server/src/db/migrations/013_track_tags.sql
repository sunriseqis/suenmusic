-- 曲目受控标签（用户拍板：三个独立维度，AI 只能从受控清单里挑，不允许自由造词）
--
-- 为什么必须受控：
--   1. 自由打标会产出大量"语义相同、写法不同"的标签（"摇滚"/"rock"/"摇滚乐"），
--      召回时全废；
--   2. 语种**不是风格**（"中文流行/日文流行"这种混维度标签一律不许出现），
--      所以语种单列一个字段。
-- 召回时只按这三列做 SQL 过滤，不引向量库（缺的是标签，不是相似度计算）。
CREATE TABLE IF NOT EXISTS track_tags (
  track_id     TEXT    PRIMARY KEY,
  /** 风格：JSON 数组，元素必须来自受控词表，最多 3 个 */
  styles       TEXT    NOT NULL DEFAULT '[]',
  /** 语种：华语/粤语/日语/韩语/欧美/其他 */
  language     TEXT    NOT NULL DEFAULT '',
  /** 接受度 1-5：1=很冷门 2=小众 3=有一定知名度 4=大众 5=国民级 */
  acceptance   INTEGER NOT NULL DEFAULT 0,
  /** 打标来源：ai=模型  manual=人工修正 */
  source       TEXT    NOT NULL DEFAULT 'ai',
  model        TEXT    NOT NULL DEFAULT '',
  tagged_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_track_tags_styles ON track_tags (language, acceptance);
