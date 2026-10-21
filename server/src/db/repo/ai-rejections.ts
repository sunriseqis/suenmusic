/**
 * AI 选库否决仓储（升级式冷却 → 永久黑名单）。
 *
 * 与 `library.ts` 里的用户手动黑名单（`user_dislikes`）**刻意分开**：
 * 前者是"我自己点的不喜欢"，后者是"AI 选库时否决的"。两者在界面上语义不同，
 * 而且 AI 否决的是**可撤销**的（冷却到期会重新进池），用户手动的则是永久的。
 *
 * 唯一写入入口是 `recordAiRejection`，调用点只有一处：
 * `ai-flow.ts` 里「候选池没选够目标数 **且** 整体归类理由被审核确认成立」的分支。
 * 别在别处调用 —— 否则模型能单方面把池子掏空。
 */

import { getDatabase, now, toNumber } from '../index.ts';

/** 每档冷却时长（天），按 strikes 顺序取；超出长度即永久黑名单 */
const COOLDOWN_DAYS = [15, 30];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 冷却档位说明（日志用） */
export function cooldownPlanFor(strikes: number): { permanent: boolean; days: number } {
  const days = COOLDOWN_DAYS[strikes - 1];
  return days === undefined ? { permanent: true, days: 0 } : { permanent: false, days };
}

export interface RejectionRow {
  track_id: string;
  name: string;
  artist: string;
  strikes: number;
  cooldown_until: number;
  permanent: number;
  last_reason: string;
}

/**
 * 记录一批被 AI 否决的曲目。
 *
 * 同一首歌每次被否决 strikes 累加，冷却时长随档位升级：
 * 第 1 次 15 天 → 第 2 次 30 天 → 第 3 次永久。
 * `strikes` **跨冷却期累积、不重置** —— 这是"解禁后又进池又被踢就加重"的实现。
 *
 * @returns 本次实际写入的条数
 */
export function recordAiRejection(
  userId: number,
  tracks: Array<{ id: string; name?: string; artist?: string }>,
  reason: string
): number {
  if (tracks.length === 0) return 0;

  const db = getDatabase();
  const ts = now();
  const read = db.prepare(
    'SELECT strikes FROM ai_rejections WHERE user_id = ? AND track_id = ?'
  );
  const upsert = db.prepare(
    `INSERT INTO ai_rejections
       (user_id, track_id, name, artist, strikes, cooldown_until, permanent, last_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, track_id) DO UPDATE SET
       strikes        = excluded.strikes,
       cooldown_until = excluded.cooldown_until,
       permanent      = excluded.permanent,
       last_reason    = excluded.last_reason,
       name           = CASE WHEN excluded.name   != '' THEN excluded.name   ELSE ai_rejections.name   END,
       artist         = CASE WHEN excluded.artist != '' THEN excluded.artist ELSE ai_rejections.artist END,
       updated_at     = excluded.updated_at`
  );

  let written = 0;
  for (const t of tracks) {
    const id = String(t.id ?? '').trim();
    if (!id) continue;

    const prev = read.get(userId, id) as { strikes: number } | undefined;
    const strikes = toNumber(prev?.strikes) + 1;
    const plan = cooldownPlanFor(strikes);
    const cooldownUntil = plan.permanent ? 0 : ts + plan.days * DAY_MS;

    upsert.run(
      userId,
      id,
      String(t.name ?? ''),
      String(t.artist ?? ''),
      strikes,
      cooldownUntil,
      plan.permanent ? 1 : 0,
      String(reason ?? '').slice(0, 500),
      ts,
      ts
    );
    written += 1;
  }
  return written;
}

/**
 * 当前生效的否决集（冷却中 + 永久）。
 *
 * 只返回**需要排除**的：冷却已过期且非永久的会自动放行（重新进池），
 * 记录本身保留 —— 下次再被否决时 strikes 继续累加。
 */
export function listActiveRejections(userId: number): RejectionRow[] {
  return getDatabase()
    .prepare(
      `SELECT track_id, name, artist, strikes, cooldown_until, permanent, last_reason
         FROM ai_rejections
        WHERE user_id = ? AND (permanent = 1 OR cooldown_until > ?)`
    )
    .all(userId, now()) as unknown as RejectionRow[];
}

/**
 * 冷却池规模（可观测指标）。
 *
 * 每天否决几十首的话，15 天窗口内会累积到几百首 —— 池子会因此逐日变小。
 * 出现"数据不足"时先看这两个数，别再去怀疑用户收藏不够。
 */
export function getRejectionStats(userId: number): {
  cooling: number;
  permanent: number;
  total: number;
} {
  const db = getDatabase();
  const ts = now();
  const cooling = db
    .prepare(
      'SELECT COUNT(*) AS n FROM ai_rejections WHERE user_id = ? AND permanent = 0 AND cooldown_until > ?'
    )
    .get(userId, ts) as { n: number };
  const permanent = db
    .prepare('SELECT COUNT(*) AS n FROM ai_rejections WHERE user_id = ? AND permanent = 1')
    .get(userId) as { n: number };
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM ai_rejections WHERE user_id = ?')
    .get(userId) as { n: number };

  return {
    cooling: toNumber(cooling?.n),
    permanent: toNumber(permanent?.n),
    total: toNumber(total?.n),
  };
}

