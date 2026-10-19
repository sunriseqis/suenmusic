-- 应用级键值设置。**不属于任何用户** —— 存的是服务端自己持有的凭证。
--
-- 为什么不按用户拆：取 B 站音源这一层是服务端代理的（浏览器发不出 Referer，
-- 见 sources/bilibili/stream.ts），所有本站用户共享同一条出网通道，
-- 因此也只能共享同一份 B 站凭证。按用户拆会得到"这次到底用谁的 Cookie"
-- 这种无法定义的行为 —— 而且拼不出正确答案。
--
-- 值一律存文本：现在只放一个登录信息（JSON 串），将来加设置项不必再开迁移。

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
