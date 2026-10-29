-- 运维日志（三维度：server / cookie / ai）。
-- 只做旁路观测记录，任何业务路径不得依赖本表。
CREATE TABLE IF NOT EXISTS ops_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  dimension  TEXT    NOT NULL,
  level      TEXT    NOT NULL DEFAULT 'info',
  action     TEXT    NOT NULL,
  summary    TEXT    NOT NULL,
  detail     TEXT,
  user       TEXT,
  platform   TEXT,
  latency_ms INTEGER,
  ok         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ops_logs_dimension_ts ON ops_logs (dimension, ts);
CREATE INDEX IF NOT EXISTS idx_ops_logs_level_ts     ON ops_logs (level, ts);
CREATE INDEX IF NOT EXISTS idx_ops_logs_ts           ON ops_logs (ts);
