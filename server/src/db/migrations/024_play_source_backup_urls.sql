-- 024: play_sources 记录备用 CDN 地址（多镜像）。
--
-- B 站 playurl 的 backupUrl / backup_url、酷狗 tracker 的 url[] 多节点，都是同一条音频
-- 在别的 CDN 上的副本。以前只留主地址，主节点慢/挂了客户端无路可换。
-- 现在把备用地址一起去重落库，随 /api/resolve 的 backupUrls 下发。
--
-- 只做「解析 + 下发」：失败与重试语义不变（重试仍由客户端决定）。
-- 旧行取默认空串 = 空数组（= 没有备用地址），不影响主地址的正常播放。

ALTER TABLE play_sources ADD COLUMN backup_urls TEXT NOT NULL DEFAULT '';
