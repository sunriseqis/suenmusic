-- 账号分级：第一个账号是管理员，其余为成员。
-- 管理员独占：音源授权、AI 模型增删改、账号管理、服务端设置。
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
