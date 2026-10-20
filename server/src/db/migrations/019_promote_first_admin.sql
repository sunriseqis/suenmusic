-- 兜底提权：018 之前建的账号全部落在默认值 'member' 上，升级后会没有人能进管理面。
-- 仅当库里一个 admin 都没有时，把最早注册的那个账号提成管理员（幂等）。
UPDATE users SET role = 'admin'
WHERE id = (SELECT MIN(id) FROM users)
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
