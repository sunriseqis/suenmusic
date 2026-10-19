-- 004: play_sources 增加音源来源列。
--
-- 网易云音源接入后，同一条缓存可能是 B 站或网易云的地址。代理层据此决定
-- 出网请求头：B 站 CDN 校验 Referer（必须带），网易云 CDN 不需要——
-- 带错 Referer 反而可能被拒。旧行没有该列时按 'bilibili' 处理（历史事实）。

ALTER TABLE play_sources ADD COLUMN source TEXT NOT NULL DEFAULT 'bilibili';
