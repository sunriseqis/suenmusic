-- AI 判定"不合适"的曲目（用户拍板：AI 的产物必须回传它 pass 掉的内容）
--
-- 为什么需要：后端只看得见被选中的，看不见被否掉的 —— 于是会以为候选池里还有货、
-- 反复把同一批歌递给 AI。被 pass 的曲目记在这里，之后**不再进候选池**。
CREATE TABLE IF NOT EXISTS ai_passed (
  user_id    INTEGER NOT NULL,
  track_id   TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  artist     TEXT    NOT NULL DEFAULT '',
  reason     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_passed_user ON ai_passed (user_id, created_at DESC);
