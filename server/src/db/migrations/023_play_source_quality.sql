-- 023: play_sources 记录音质（当前档 + 可用档）。
--
-- 音质以前只藏在缓存键后缀里（trackId:mp3:exhigh），读回时靠「猜 trackId 后缀」还原，
-- 猜不出就按音源类型报 high/lossless —— 那是**虚报**：酷狗普通畅听 VIP 只能拿 128k、
-- 网易云非 VIP 拿不到 lossless，客户端据此把「无损/极高」从置灰变可点，用户点完必然降级。
-- 现在把音源层真实产出（currentQuality / availableQualities）直接落库。
--
-- 旧行两列取默认值（空串 / 空数组）：读出方一律保守报 standard，下次解析自然刷新。

ALTER TABLE play_sources ADD COLUMN current_quality TEXT NOT NULL DEFAULT '';
ALTER TABLE play_sources ADD COLUMN available_qualities TEXT NOT NULL DEFAULT '';
