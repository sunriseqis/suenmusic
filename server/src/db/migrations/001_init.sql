-- SuenMusic 服务端 —— 初始化 schema
--
-- 设计原则：
--   1. 服务端是所有状态的唯一真相源。前端 localStorage / IndexedDB 那套不再参与同步。
--   2. QQ 音乐是元数据的真相源，本库的 tracks 只是**缓存**，用 fetched_at 控制刷新。
--   3. 时间统一用毫秒整数（Date.now()），不用 SQLite 的 TEXT 时间，避免时区歧义。
--   4. 所有外键都带 ON DELETE CASCADE，删用户即清干净其所有数据。

-- ---------- 账号 ----------

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  display_name  TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 刷新令牌。存 hash 不存明文，支持单设备吊销（将来"退出所有设备"靠它）。
CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT    PRIMARY KEY,           -- jti
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  user_agent   TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tokens_user   ON tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_hash   ON tokens(token_hash);

-- ---------- 曲目缓存 ----------

-- payload_json 存完整 Track 对象：表结构只为了检索与统计，
-- 返回给客户端时直接用 payload_json，保证字段不因 schema 演进而丢失。
CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT    PRIMARY KEY,          -- qq_<songmid>
  mid          TEXT    NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  artists_json TEXT    NOT NULL DEFAULT '[]',
  album_id     TEXT    NOT NULL DEFAULT '',  -- 路由键 qq_al_<albumMid>
  album_mid    TEXT    NOT NULL DEFAULT '',
  album_name   TEXT    NOT NULL DEFAULT '',
  cover_url    TEXT    NOT NULL DEFAULT '',
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT    NOT NULL DEFAULT '{}',
  fetched_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracks_mid   ON tracks(mid);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);

-- ---------- 音源解析缓存 ----------
--
-- 两个用途：
--   a) 进程重启后仍然命中，不必重新打 B 站搜索（这是风控的主要来源）
--   b) ok=0 是**负缓存**，防止对匹配失败的曲子反复打上游
--
-- expires_at 由解析器按 B 站音频 URL 的时效决定，过期即重解析。

CREATE TABLE IF NOT EXISTS play_sources (
  track_id       TEXT    PRIMARY KEY,
  ok             INTEGER NOT NULL,           -- 1 成功 / 0 失败
  bvid           TEXT    NOT NULL DEFAULT '',
  score          INTEGER NOT NULL DEFAULT 0,
  audio_url      TEXT    NOT NULL DEFAULT '',
  bandwidth      INTEGER NOT NULL DEFAULT 0,
  matched_title  TEXT    NOT NULL DEFAULT '',
  matched_author TEXT    NOT NULL DEFAULT '',
  duration_diff  INTEGER NOT NULL DEFAULT 0,
  reason         TEXT    NOT NULL DEFAULT '',
  message        TEXT    NOT NULL DEFAULT '',
  resolved_at    INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_expires ON play_sources(expires_at);

-- ---------- 歌单 ----------

CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT    PRIMARY KEY,           -- uuid
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  cover_url   TEXT    NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id, sort, created_at);

-- position 用 1000 步长递增，留出插空余量；不加 UNIQUE 约束，
-- 因为重排时中间态必然冲突，硬约束只会让排序逻辑变复杂。
CREATE TABLE IF NOT EXISTS playlist_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id TEXT    NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT    NOT NULL,
  position    INTEGER NOT NULL,
  added_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plitems_playlist ON playlist_items(playlist_id, position, id);
CREATE INDEX IF NOT EXISTS idx_plitems_track    ON playlist_items(track_id);

-- ---------- 收藏 ----------

CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, created_at DESC);

-- ---------- 播放历史 ----------
--
-- 这是"多端实时同步"的核心表。每次上报插一行，不做 upsert：
-- 保留完整时间线，客户端用 since 游标增量拉取，天然支持并发写入
-- （用 offset 分页会漏数据，所以同步一律走游标）。

CREATE TABLE IF NOT EXISTS play_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    TEXT    NOT NULL,
  played_at   INTEGER NOT NULL,
  played_ms   INTEGER NOT NULL DEFAULT 0,    -- 本次播放到第几毫秒，用于跨端续播
  duration_ms INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  source      TEXT    NOT NULL DEFAULT 'unknown',  -- web / android / cli
  device_id   TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_history_user_time  ON play_history(user_id, played_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_history_user_track ON play_history(user_id, track_id, played_at DESC);
