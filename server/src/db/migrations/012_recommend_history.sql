-- 推荐历史 + 反馈闭环（2026-09-15 接 AI 驱动）
--
-- 用途一：投喂给模型时带去重信息（"最近推荐过这些，别再给"）。
-- 用途二：记录推荐结果，形成反馈闭环（用户点"不喜欢"时回写）。
-- 用途三：统计可播率 —— 模型给的曲目有多少最终落到音源，这是验收硬指标。
CREATE TABLE IF NOT EXISTS recommend_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  batch_id   TEXT    NOT NULL,              -- 一次生成 = 一个批次
  source     TEXT    NOT NULL DEFAULT 'ai', -- ai | legacy | chart | playlist
  track_id   TEXT    NOT NULL DEFAULT '',   -- 落地后的曲目 id（解析失败为空）
  name       TEXT    NOT NULL DEFAULT '',   -- 模型给的原名（解析失败也要留痕）
  artist     TEXT    NOT NULL DEFAULT '',
  resolved   INTEGER NOT NULL DEFAULT 0,    -- 是否成功落到可播音源
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recommend_history_user
  ON recommend_history (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recommend_history_track
  ON recommend_history (user_id, track_id);
