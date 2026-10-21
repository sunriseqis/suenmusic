-- 移除用户自建歌单功能（2026-10-21，用户拍板）。
--
-- 背景：Web 端一直没有歌单页面，服务端 routes/playlists.ts + repo/playlists.ts 的
-- 整条链路三端零调用；同日把路由、repo 与三处测试一并删掉，这里把表也清掉
--（当前无实际用户，可直接修表）。
--
-- 顺带清掉 009 迁移里那段用错表名的死 DDL 遗留：009 想建 "网友歌单曲目"
-- 却写成了 `playlist_items`（与 001 的用户歌单表同名），CREATE TABLE IF NOT EXISTS
-- 静默跳过，直到 010 才用 `playlist_pool_items` 建表。这里删掉那张被误占的表。
--
-- 注意：`playlist_pool` / `playlist_pool_items`（每日推荐的候选池）**不动**。

DROP INDEX IF EXISTS idx_plitems_playlist;
DROP INDEX IF EXISTS idx_plitems_track;
DROP INDEX IF EXISTS idx_playlists_user;
DROP TABLE IF EXISTS playlist_items;
DROP TABLE IF EXISTS playlists;

-- tokens.last_used_at 恒为 0：刷新令牌每次使用都会轮换（旧行立即吊销、
-- 新行刚创建），所以"最后使用时间"恒等于 created_at，这个列与
-- /api/auth/sessions 的 lastUsedAt 字段从来没有真实语义。
ALTER TABLE tokens DROP COLUMN last_used_at;
