-- AI 选库否决的曲目（升级式冷却 → 永久黑名单）
--
-- 用户口径（2026-09-20 拍板）：这是 AI 自己管理的黑名单，与用户手动点的
-- 「不喜欢」（user_dislikes）**分开存**，界面上要能区分"我拉黑的"和"AI 自动否决的"。
--
-- 为什么需要：
--   候选池每次由代码重建。模型"没选中"的歌如果不记下来，换池子后会原样回来，
--   模型再次不选 → 再次换池子 → 死循环。所以被否决的歌必须进排除集。
--
-- 升级式冷却（strikes 跨冷却期累积，不重置）：
--   第 1 次被否决 → 冷却 15 天
--   第 2 次被否决 → 冷却 30 天
--   第 3 次被否决 → permanent = 1，永久不再解禁
--
-- ⚠️ 写入点只有一个：候选池没选够目标数 **且** 模型给出的整体归类理由
--    **被审核 AI 确认成立**。选满的、理由没被确认的，一律不记 —— 否则模型
--    会单方面把池子掏空。
CREATE TABLE IF NOT EXISTS ai_rejections (
  user_id        INTEGER NOT NULL,
  track_id       TEXT    NOT NULL,
  name           TEXT    NOT NULL DEFAULT '',
  artist         TEXT    NOT NULL DEFAULT '',
  /** 累计被 AI 否决的次数（跨冷却期累积，用于决定下一档冷却时长） */
  strikes        INTEGER NOT NULL DEFAULT 0,
  /** 冷却截止时间戳（毫秒）。permanent = 1 时该字段无意义 */
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  /** 1 = 彻底黑名单，永不再进池子 */
  permanent      INTEGER NOT NULL DEFAULT 0,
  /** 最近一次被否决时审核确认成立的整体归类理由（追溯用） */
  last_reason    TEXT    NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

-- 排除集查询是热路径（每次建池都跑）：按 (用户, 是否永久, 冷却截止) 命中
CREATE INDEX IF NOT EXISTS idx_ai_rejections_cooldown
  ON ai_rejections (user_id, permanent, cooldown_until);
