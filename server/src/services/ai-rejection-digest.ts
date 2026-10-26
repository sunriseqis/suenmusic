/**
 * 打回理由摘要（压缩上下文）—— 把"一条一条的打回理由"压成十几行偏好结论。
 *
 * ## 真相源：`ai_passed`（**不是** `ai_rejections`）
 *
 * grep 结论（落笔时核对过三处读者 + 两处写入口）：
 *   - `ai_passed.reason` 是**逐首**的打回理由：唯一写入点是 ai-flow.ts 审核打回后
 *     以 `[审核打回] <why>` 落库；已有三处把它当"最近打回理由"读
 *     （ai-flow.ts 的 briefFor、ai-decide.ts 的 recentRejections、ai-memory.ts 的台账）。
 *   - `ai_rejections.last_reason` 是**冷却黑名单**的备注：写入点是"整体归类理由"
 *     （一次落一批 id，理由是审核确认成立的那句归类话术，且被 upsert 覆盖），
 *     回答的是"这批歌为什么整类被否决"，不是"这首歌为什么被打回"。
 * 所以摘要取 `ai_passed`。
 *
 * ## 为什么再要一个 AI 来压
 *
 * 用户拍板：**不要每首歌一条理由**。逐条塞进选曲 prompt 会挤占上下文，
 * 模型也会把它当噪音跳过；压成"哪类东西老被打回"的结论才有指导力。
 *
 * ## 阈值（不是每次生成都调模型）
 *
 *   - 新增 ≥ ${NEW_REJECTIONS_THRESHOLD} 条  或  距上次摘要 ≥ ${STALE_DAYS} 天 → 调一次模型
 *   - 没有新增                                        → 直接跳过（旧摘要就是当前答案）
 *
 * ## 存哪
 *
 * `app_settings` 的 `ai.rejection_digest:<userId>`，与 `ai_memory.summary:<userId>`
 * 同一个多用户口径：摘要是按用户从 `ai_passed` 推出来的，共用一条会把 A 的禁忌喂给 B。
 *
 *   { updatedAt: number, sourceCount: number, lines: string[] }
 *
 * `sourceCount` 是生成时的累计条数，"新增"= 当前条数 - sourceCount。
 *
 * ## 谁消费
 *
 * ai-decide.ts 的 `buildMessages`（选曲 prompt）：摘要 + 最近几条原始理由。
 */
import { getDatabase, now, toNumber } from '../db/index.ts';
import { getSetting, setSetting } from '../db/repo/settings.ts';
import { aiChat } from './ai-client.ts';
import { createLogger } from '../logger.ts';
import { cleanAiText } from '../utils/text.ts';

const log = createLogger('ai-rejection-digest');

/** 累计新增多少条打回理由才值得再压一次 */
export const NEW_REJECTIONS_THRESHOLD = 30;
/** 距上次摘要多少天强制刷新（打回很少的用户也不至于永远没有摘要） */
export const STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = STALE_DAYS * DAY_MS;
/** 摘要行数上限（prompt 里占的行数 = 这个 + 1 个标题） */
export const DIGEST_MAX_LINES = 12;
/** 单行字数上限：只写结论，长了就是细节 */
const LINE_MAX_CHARS = 80;
/** 喂给模型的原始理由条数上限 */
const FEED_LIMIT = 80;
/** prompt 里附带的"最近原始理由"条数 */
export const RECENT_RAW_LIMIT = 5;

const KEY_PREFIX = 'ai.rejection_digest';

export interface RejectionDigest {
  updatedAt: number;
  sourceCount: number;
  lines: string[];
}

export interface RejectionSample {
  name: string;
  artist: string;
  reason: string;
}

export interface DigestRefreshResult {
  refreshed: boolean;
  /** 没刷新时的原因（日志/验收脚本打印用，形如"阈值未到…跳过"） */
  reason: string;
  digest: RejectionDigest | null;
}

export function digestKey(userId: number): string {
  return `${KEY_PREFIX}:${userId}`;
}

/** 读摘要；没生成过或内容坏掉都返回 null（坏数据不参与 prompt） */
export function readRejectionDigest(userId: number): RejectionDigest | null {
  const raw = getSetting(digestKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RejectionDigest>;
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines.map(v => String(v ?? '').trim()).filter(Boolean).slice(0, DIGEST_MAX_LINES)
      : [];
    if (lines.length === 0) return null;
    return {
      updatedAt: toNumber(parsed.updatedAt),
      sourceCount: toNumber(parsed.sourceCount),
      lines,
    };
  } catch {
    return null;
  }
}

/** 该用户累计的打回条数（ai_passed 每题一行） */
export function countRejections(userId: number): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM ai_passed WHERE user_id = ?')
    .get(userId) as { n: number } | undefined;
  return toNumber(row?.n);
}

/** 最近若干条打回理由（新→旧），已剥掉 `[审核打回]` 前缀 */
export function recentRejectionSamples(userId: number, limit: number): RejectionSample[] {
  const rows = getDatabase()
    .prepare(
      `SELECT name, artist, reason FROM ai_passed
        WHERE user_id = ? AND reason != ''
        ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, Math.max(1, limit)) as unknown as RejectionSample[];

  return rows.map(r => ({
    name: String(r.name ?? ''),
    artist: String(r.artist ?? ''),
    reason: stripTag(r.reason),
  }));
}

/** `[审核打回] xxx` → `xxx`（前缀是台账标记，不是理由本身） */
function stripTag(reason: string): string {
  return String(reason ?? '').replace(/^\[审核打回\]\s*/, '').trim().slice(0, 60);
}

/**
 * 选曲 prompt 里的那一段。
 *
 * 行数预算：1 行标题 + ≤{@link DIGEST_MAX_LINES} 行摘要 + 1 行标题 + ≤{@link RECENT_RAW_LIMIT} 条原始理由。
 * `recentRaw` 由调用方（brief 里的 `rejections`）给，这里只做截断，不重复查库。
 */
export function rejectionDigestSection(userId: number, recentRaw: string): string {
  const digest = readRejectionDigest(userId);
  const lines = digest?.lines ?? [];
  const digestBlock =
    lines.length > 0 ? lines.map(l => `- ${l}`).join('\n') : '（暂无摘要：还没攒够打回记录）';

  const recent = String(recentRaw ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, RECENT_RAW_LIMIT);
  const recentBlock = recent.length > 0 ? recent.join('\n') : '（暂无）';

  return `## 已否决偏好（摘要）\n${digestBlock}\n\n## 最近 ${RECENT_RAW_LIMIT} 条原始理由\n${recentBlock}`;
}

const SYSTEM_PROMPT = `你在把"被打回的歌曲理由"压缩成一份可复用的选曲禁忌摘要。

## 聚合要求（⚠️ 必须遵守）
1. 维度固定三种：**歌手维度** / **风格维度** / **曲目维度**，每个维度最多 4 行。
2. 一行一条，格式：\`<主体> ×<出现次数>：<一句话结论>\`。
   例：\`五月天 ×3：太吵、编曲重复\`、\`女声民谣 ×5：同类过多\`。
3. **只写结论，不写细节**：不复述原始理由的句子，不写具体曲目编号/时长之类的细节。
4. **严禁逐条罗列**：同一歌手、同一风格的多次打回必须合并成一行，次数累加。
5. 与【上一版摘要】合并：次数累加、同类合并，已经不成立的条目可以删掉。
6. 最多 12 行，按出现次数从高到低排序；依据不够就别硬凑。
7. 只输出这些行本身：不要编号、不要 markdown 标题、不要任何解释或寒暄。`;

function buildDigestMessages(
  prev: RejectionDigest | null,
  samples: RejectionSample[]
): Array<{ role: 'system' | 'user'; content: string }> {
  const prevBlock =
    prev && prev.lines.length > 0 ? prev.lines.map(l => `- ${l}`).join('\n') : '（暂无摘要）';
  const feed =
    samples.length > 0
      ? samples.map(s => `${s.name || '（无歌名）'} | ${s.artist || '（无歌手）'} | ${s.reason}`).join('\n')
      : '（暂无原始理由）';

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `【上一版摘要】\n${prevBlock}\n\n【最近打回理由（逐首）】\n${feed}\n\n请输出合并后的摘要（最多 ${DIGEST_MAX_LINES} 行）：`,
    },
  ];
}

/** 模型输出 → 摘要行（去编号/项目符号/空行/重复，超长截断） */
export function parseDigestLines(raw: string): string[] {
  const out: string[] = [];
  for (const rawLine of String(raw ?? '').split('\n')) {
    let line = cleanAiText(rawLine).trim();
    if (!line || line.startsWith('```')) continue;
    line = line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*•·]\s*/, '')
      .replace(/^\d+[.、)]\s*/, '')
      .trim();
    if (!line) continue;
    if (line.length > LINE_MAX_CHARS) line = `${line.slice(0, LINE_MAX_CHARS - 1)}…`;
    if (out.includes(line)) continue;
    out.push(line);
    if (out.length >= DIGEST_MAX_LINES) break;
  }
  return out;
}

/** 同用户并发单飞：每日流程与别的触发点同时进来时只花一次 token */
const inFlight = new Map<number, Promise<DigestRefreshResult>>();

/**
 * 按阈值决定要不要重压摘要。
 *
 * **永不抛异常**：它是生成流程里的旁路，失败只 warn 并保留旧摘要。
 */
export async function maybeRefreshDigest(userId: number): Promise<DigestRefreshResult> {
  const running = inFlight.get(userId);
  if (running) return running;

  const task = refresh(userId);
  inFlight.set(userId, task);
  try {
    return await task;
  } finally {
    inFlight.delete(userId);
  }
}

async function refresh(userId: number): Promise<DigestRefreshResult> {
  const prev = readRejectionDigest(userId);
  const total = countRejections(userId);

  if (total === 0) {
    return { refreshed: false, reason: '没有任何打回记录 —— 跳过', digest: prev };
  }

  const pending = Math.max(0, total - (prev?.sourceCount ?? 0));
  if (pending === 0) {
    return { refreshed: false, reason: `没有新增打回记录（累计 ${total} 条已在摘要里）—— 跳过`, digest: prev };
  }

  const elapsed = prev ? now() - prev.updatedAt : Number.POSITIVE_INFINITY;
  if (pending < NEW_REJECTIONS_THRESHOLD && elapsed < STALE_MS) {
    const days = prev ? Math.floor(elapsed / DAY_MS) : 0;
    return {
      refreshed: false,
      reason:
        `阈值未到：新增 ${pending}/${NEW_REJECTIONS_THRESHOLD} 条、距上次 ${days}/${STALE_DAYS} 天 —— 跳过`,
      digest: prev,
    };
  }

  const samples = recentRejectionSamples(userId, FEED_LIMIT);
  try {
    const raw = await aiChat(buildDigestMessages(prev, samples), {
      purpose: 'memory',
      maxTokens: 1600,
      timeoutMs: 120_000,
      temperature: 0.3,
    });
    const lines = parseDigestLines(raw);
    if (lines.length === 0) {
      log.warn('模型没有产出可用摘要行，保留旧摘要');
      return { refreshed: false, reason: '模型输出为空 —— 保留旧摘要', digest: prev };
    }

    const digest: RejectionDigest = { updatedAt: now(), sourceCount: total, lines };
    setSetting(digestKey(userId), JSON.stringify(digest));
    log.info(
      `打回摘要已刷新：${lines.length} 行 · 来源 ${samples.length} 条（累计 ${total} 条，本次新增 ${pending}）`
    );
    return { refreshed: true, reason: `已刷新：新增 ${pending} 条 → ${lines.length} 行摘要`, digest };
  } catch (err) {
    // 失败不是错误路径：旧摘要继续用，下次生成还会再试
    log.warn(`打回摘要生成失败，保留旧摘要：${(err as Error).message}`);
    return { refreshed: false, reason: `生成失败：${(err as Error).message}`, digest: prev };
  }
}
