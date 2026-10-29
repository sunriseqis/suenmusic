/**
 * 审核 AI（用户拍板：把 60 首 + 4 份 pass 理由交给一个"审核角色"复核）。
 *
 * ## 为什么让 AI 审 AI
 *
 * 生成侧是分批的（15 首一批），每批只能看到自己那一小段上下文 —— 于是会出现：
 *   - 同一歌手在两批里各挑了一首（跨批重复）
 *   - 挑了一首"其实已经 pass 掉同类"的歌（跟 pass 的精神冲突）
 *   - 理由编造用户历史（"他最近收藏了 X"，而收藏里根本没有）
 * 审核侧**一次性看到 60 首 + 4 份 pass 理由**，正好能治这些跨批问题。
 *
 * 输出很短：只报打回的（{"reject":[{"id","why"}]}），通过的不用写 —— 短输出更稳。
 */
import { aiChat } from './ai-client.ts';
import { classifyAiFailure, type AiFailureKind } from './ai-health.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('ai-review');

/**
 * 单次审核最多打回多少首。
 *
 * 实测教训：给到 12 且标准宽松时，弱模型会把"金曲"和"同歌手"都算成重复 →
 * 一轮打回十几首 → 补位再打回 → 整条流程在打转（3 轮补了 61 首）。
 * 现在客观规则全部归代码，审核只判三类主观问题，上限也收到 6。
 */
const REJECT_MAX = 6;
export const REVIEW_HISTORY_MAX = 20;

export interface ReviewItem {
  id: string;
  name: string;
  artist: string;
  source: string;
  listNo: number;
  reason: string;
}

/**
 * 审核要看的"不合适"上下文（流程3 的输入）。
 *
 * 用户口径：生成侧**不再回传 pass**（流程1/2 只产出 15 首 + 推荐理由），
 * "不合适"的判断是审核的活；审核需要的是**历史打回台账**（AI 历次判过的 + 理由），
 * 这样它才能一致地判"这与之前否掉的东西是不是一路货"。
 */
export interface ReviewHistory {
  /** 历史判过"不合适"的（曲名 - 歌手：理由），一行一条 */
  lines: string[];
}

/**
 * 复核结论三态。
 *
 * 用户拍板：失败**不再**"catch → 全部放行"。放行等于让没审过的歌直接落库，
 * 而调用方无法区分"模型说都通过"和"模型根本没答上来" —— 那正是审核形同虚设的原因。
 * `unavailable` 由调用侧决定怎么处置（ai-flow：保留旧歌单，不用未过闸的批次覆盖）。
 */
export type ReviewOutcome =
  /**
   * 模型正常回传（可能打回，也可能一首都不打回）。
   *
   * `rejects` 用 Map 而不是数组：调用侧要按 id 查（`has`）、要计数（`size`）、
   * 要遍历 id→理由；且同一次回传里模型可能对同一首重复列出，Map 天然去重。
   */
  | { status: 'ok'; rejects: Map<string, string> }
  | { status: 'unavailable'; reason: AiFailureKind; message: string };

/**
 * 复核重试：用户拍板「超时可能只是被限流，间隔一会再问」。
 *
 * 最多 3 次重试（= 最多 4 次调用），间隔 5s → 20s → 60s。
 * 仅当原因可恢复（timeout / ratelimit / error）才重试；
 * auth / billing 重试一万次也还是同一个结果，直接判不可用。
 */
export const REVIEW_RETRY_DELAYS_MS = [5_000, 20_000, 60_000] as const;

const RETRYABLE_REVIEW_FAILURES: ReadonlySet<AiFailureKind> = new Set<AiFailureKind>([
  'timeout',
  'ratelimit',
  'error',
]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface RawReview {
  reject: Array<{ id: string; why: string }>;
}

function parseReview(text: string): RawReview {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    // 若模型未输出 JSON（多为"审核通过，无打回项"等自然语言表达），平滑视为全部通过，绝不抛异常打断流程
    return { reject: [] };
  }
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const raw = Array.isArray(obj.reject) ? obj.reject : [];
    return {
      reject: raw
        .map(r => {
          const o = r as Record<string, unknown>;
          return { id: String(o.id ?? '').trim(), why: String(o.why ?? '').trim() };
        })
        .filter(r => r.id && r.why)
        .slice(0, REJECT_MAX),
    };
  } catch {
    return { reject: [] };
  }
}

/**
 * 复核两份歌单。
 *
 * @param items 两份歌单的全部曲目（listNo 标记属于哪一份）
 * @param passSets 生成侧各批回传的 pass（含理由）
 */
export async function reviewPicks(
  items: ReviewItem[],
  history: ReviewHistory,
  opts: { collectionHint?: string; memory?: string; userActions?: string } = {}
): Promise<ReviewOutcome> {
  if (items.length === 0) return { status: 'ok', rejects: new Map() };

  const system = `你是歌单审核员。生成侧刚刚产出一份**专属候选知音歌单（30 首，每首带推荐理由）**。
请结合用户音乐画像与历史反馈复核整份歌单，把不合格的挑出来打回。

【极简思考要求】：严格控制思考过程长度，用简短中文迅速排查三类禁忌，拿不准的一律放行不打回，迅速收敛，立刻直接输出合法的纯 JSON 对象。严禁冗长英语推导。

## 打回标准（**只打下面三类**，其中客观规则已由代码处理，不要重复判）

代码已经处理好的（**不要评价、不要解释、不要判**）：
曲目 id 去重｜收藏去重（同歌手的其他歌**不算**已收藏）｜一位歌手一首｜来源名额｜金曲≤5。
直接跳过这些，**不要写"代码已处理所以我不打回"这类说明** —— 只输出你确实要打回的项。
另外：理由里标了「为你挑选…」的是系统按标签补位，**不算"理由编造"**。

**你需要判的只有三类（都属于"机器判不了、要靠理解"的）**：
1. **与"你不要的路数"冲突**：某首入选曲属于画像里点明的禁忌路数
   （例："网络口水情歌/年代久远/拼接式合作"）。
   ⚠️ 判的是**路数**，不是"这首歌以前被否过" —— 若一首歌自然又回到池子里、
   你觉得它这次合适，那就放行，不必因为历史而打回（用户口径：自然发生，别太严苛）。
2. **理由编造**：理由里断言了"你最近收藏了 X / 常听 Y"等无依据的编造历史。
3. **明显跑偏**：风格/语种跟口味画像明显不符（例：偏好独立乐队/都市抒情，
   却选了一首早期女团舞曲）。

⚠️ **宁少勿滥**：一共最多打回 ${REJECT_MAX} 首，拿不准的**不要**打回。
打回太多会让下游反复补位、歌单越补越差 —— 上一版就是因为你判滥了导致打转。

## 输出（严格 JSON，不要 markdown，若全合格输出 {"reject":[]}）
{"reject":[{"id":"<原样回填的 id>","why":"一句打回原因"}]}
通过的**不要**列进来。总共最多打回 ${REJECT_MAX} 首。`;

  const passText = history.lines.join('\n');

  const listText = items
    .map(
      i =>
        `[歌单${i.listNo}][${i.source}] ${i.id} | ${i.name} | ${i.artist}` +
        (i.reason ? ` | 理由：${i.reason}` : '')
    )
    .join('\n');

  const user = `## 他最近的操作（**最高权重信号**）
${opts.userActions || '（暂无）'}

## 他的收藏（用于查重：已收藏的一律打回）
${opts.collectionHint || '（未提供）'}

## 历史打回与反思台账（近期被你否决过的曲目/理由）
${passText || '（暂无近期打回记录）'}

## 候选歌单（共 ${items.length} 首）
${listText}

## 关于"他不要什么"
下面这份是他的**口味记忆**（上一轮由模型总结，已经压缩过"什么被否掉、为什么"）：
${opts.memory || '（暂无）'}

请复核并直接输出纯 JSON 对象（以 "{" 开头，以 "}" 结尾，若全部合格则输出 {"reject":[]}，严禁任何前导或尾随闲聊文本）。`;

  const valid = new Set(items.map(i => i.id));
  let failure: { kind: AiFailureKind; message: string } | null = null;

  for (let attempt = 0; attempt <= REVIEW_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0 && failure) {
      const waitMs = REVIEW_RETRY_DELAYS_MS[attempt - 1];
      log.warn(
        `审核调用失败（${failure.kind}）：${failure.message} —— ` +
          `${Math.round(waitMs / 1000)}s 后重试（第 ${attempt}/${REVIEW_RETRY_DELAYS_MS.length} 次）`
      );
      await sleep(waitMs);
    }

    let rawText: string;
    try {
      rawText = await aiChat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // ⚠️ 900s：本地 9router/glm-5.3-flash 是推理模型，实测一次 14k token 的输出要
        // 530.9 秒（其中 8k 是思考 token）。原来的 90s 必然超时。
        { purpose: 'review', jsonMode: true, maxTokens: 8000, timeoutMs: 900_000 }
      );
    } catch (err) {
      failure = classifyAiFailure(err);
      if (!RETRYABLE_REVIEW_FAILURES.has(failure.kind)) {
        log.warn(`审核不可用（${failure.kind}，重试无意义）：${failure.message}`);
        return { status: 'unavailable', reason: failure.kind, message: failure.message };
      }
      continue;
    }

    // 模型答上来了：解析（非 JSON 的自然语言仍按"全部合格"处理，见 parseReview 注释）
    const raw = parseReview(rawText);
    const rejects = new Map<string, string>();
    for (const r of raw.reject) {
      if (valid.has(r.id)) rejects.set(r.id, r.why);
    }
    log.info(`审核完成：打回 ${rejects.size}/${items.length} 首`);
    return { status: 'ok', rejects };
  }

  const last = failure ?? { kind: 'error' as AiFailureKind, message: '审核调用失败（原因未知）' };
  log.warn(`审核重试用尽（${last.kind}）：${last.message}`);
  return { status: 'unavailable', reason: last.kind, message: last.message };
}

// ---------------------------------------------------------------------------
// 归类理由审核（"池子剩下的为什么都不合适"）
// ---------------------------------------------------------------------------

/**
 * 生成侧的一项"放弃声明"：一句整体理由 + 它声称不合适的曲目。
 *
 * 刻意不复用 `ReviewItem`：那边审的是"已选中的歌好不好"，这边审的是
 * "没选中的歌为什么不好"，输入形状与判据都不同。
 */
export interface ExclusionClaim {
  why: string;
  tracks: Array<{ id: string; name: string; artist: string }>;
}

export interface ExclusionReviewResult {
  /** 归类理由是否成立。成立才允许把那些歌写进 AI 黑名单 */
  approved: boolean;
  /** 判定说明（不成立时会作为"重选"的意见回传给生成侧） */
  note: string;
}

interface RawExclusionReview {
  approved: boolean;
  note: string;
}

function parseExclusionReview(text: string): RawExclusionReview {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return { approved: false, note: '审核未返回可解析结果' };
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    return {
      approved: obj.approved === true,
      note: String(obj.note ?? '').trim().slice(0, 300),
    };
  } catch {
    return { approved: false, note: '审核结果解析失败' };
  }
}

/**
 * 复核生成侧的"放弃声明"。
 *
 * ## 为什么必须审
 *
 * 生成侧没挑够时会说"池子里剩下的都不合适"。这句话是**不可证伪的**——
 * 模型可能真觉得不合适，也可能是偷懒、或者输出被截断了。如果直接采信并把这些歌
 * 拉黑，模型就能单方面把用户的候选池掏空。
 *
 * 审核是**唯一闸门**：只有它确认理由成立，那些歌才会进 AI 黑名单（15/30 天 → 永久）。
 *
 * ## 失败时的默认
 *
 * 模型调用失败/超时 → **一律判不成立**（不拉黑）。宁可多跑一轮重选，
 * 也不能让一次网络抖动把一批好歌关进冷却。
 */
export async function reviewExclusions(
  claims: ExclusionClaim[],
  opts: { memory?: string; userActions?: string } = {}
): Promise<ExclusionReviewResult> {
  if (claims.length === 0) return { approved: false, note: '没有需要复核的归类理由' };

  const system = `你是歌单审核员。生成侧从候选池里挑歌，但**没挑够目标数量**，它声称剩下的候选都不合适，并给出了归类理由。
你的任务：判断这些归类理由**是否站得住**。

【极简思考要求】：严格控制思考过程长度，用简短中文迅速判断，立刻输出合法纯 JSON 对象。严禁冗长英语推导。

## 判成立（approved = true）
理由**具体可验证**、与用户口味画像一致、被归类的曲目确实属于该路数。
例："这 40 首都是网络口水情歌" —— 若曲目确实符合画像里点明的禁忌路数，成立。

## 判不成立（approved = false）——出现任一情况即不成立
1. **明显偷懒**：被归类的曲目里有明显符合画像偏好的好歌。
   例：画像说"最爱周杰伦"，却把周杰伦的歌归进"不合适"。
2. **理由空泛**：只说"不合适""不符合口味"这类套话，给不出可验证的路数。
3. **自相矛盾**：归类理由与它自己已选中的曲目冲突（同一路数，一边选一边说不要）。

⚠️ 拿不准时判**不成立**：判错的代价是把好歌关进冷却，比多跑一轮重选严重得多。

## 输出（严格 JSON，不要 markdown）
{"approved":true,"note":"一句说明"}
{"approved":false,"note":"指出哪一类站不住、为什么"}`;

  const claimText = claims
    .map((c, i) => {
      const lines = c.tracks
        .map(t => `  - ${t.id} | ${t.name} | ${t.artist}`)
        .join('\n');
      return `[第 ${i + 1} 类] 理由：${c.why}\n${lines}`;
    })
    .join('\n\n');

  const user = `## 他的口味记忆
${opts.memory || '（暂无）'}

## 他最近的操作
${opts.userActions || '（暂无）'}

## 生成侧的归类理由（它声称下面这些曲目都不合适，所以没选）
${claimText}

请判断这些归类理由是否成立，直接输出纯 JSON 对象（以 "{" 开头，以 "}" 结尾）。`;

  let rawText = '';
  try {
    rawText = await aiChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { purpose: 'review', jsonMode: true, maxTokens: 4000, timeoutMs: 900_000 }
    );
  } catch (err) {
    log.warn(`归类理由审核失败，按"不成立"处理（不拉黑）：${(err as Error).message}`);
    return { approved: false, note: '审核调用失败，未采信归类理由' };
  }

  const result = parseExclusionReview(rawText);
  const total = claims.reduce((a, c) => a + c.tracks.length, 0);
  log.info(
    `归类理由审核：${result.approved ? '成立 ✅' : '不成立 ❌'}（${claims.length} 类 / ${total} 首）` +
      (result.note ? ` · ${result.note}` : '')
  );
  return result;
}

// ---------------------------------------------------------------------------
// 第二轮：理由审核 + 精炼（用户 2026-10-29 新流程）
// ---------------------------------------------------------------------------

/**
 * 选歌 AI 的一首长理由（reason_for_review，给审核看）。
 */
export interface ReasonReviewItem {
  id: string;
  name: string;
  artist: string;
  /** 选歌 AI 写的长听感（reason_for_review） */
  reasonForReview: string;
}

/**
 * 审核结论：approved → 精炼成 12-25 字短句（reason_for_display，给前端）；
 * rejected → 丢掉，前端不展示推荐语（歌还在，只是没推荐语）。
 */
export interface ReasonVerdict {
  verdict: 'approved' | 'rejected';
  /** 审核精炼后的短句（12-25 字，仅 approved 有值） */
  reasonForDisplay: string;
}

interface RawReasonReview {
  reviews: Array<{ id: string; verdict: string; reason_for_display: string }>;
}

function parseReasonReview(text: string): RawReasonReview {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return { reviews: [] };
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const raw = Array.isArray(obj.reviews) ? obj.reviews : [];
    return {
      reviews: raw
        .map(r => {
          const o = r as Record<string, unknown>;
          return {
            id: String(o.id ?? '').trim(),
            verdict: String(o.verdict ?? '').trim().toLowerCase(),
            reason_for_display: String(o.reason_for_display ?? '').trim(),
          };
        })
        .filter(r => r.id),
    };
  } catch {
    return { reviews: [] };
  }
}

/**
 * 第二轮审核（用户 2026-10-29 新流程）：选歌 AI 写长理由 → 审核判断 + 精炼。
 *
 * - 判断：这句推荐理由是否**合理且被强烈认可**（approved）还是**在水**（rejected）。
 * - 精炼：approved 的压成 12-25 字短句（reason_for_display，落前端推荐语页）。
 * - rejected 的**丢掉**，前端不展示推荐语（歌还在，只是没推荐语）。
 *
 * 失败时返回空 Map（= 全部视为无展示短句），调用侧不阻塞落地 —— 与第一轮"失败即停"不同：
 * 理由精炼是**增值**，不是准入闸门（歌单质量由第一轮 reviewPicks 把关）。
 */
import { clampDisplay } from '../utils/reason-text.ts';

export async function reviewReasons(
  items: ReasonReviewItem[]
): Promise<Map<string, ReasonVerdict>> {
  if (items.length === 0) return new Map<string, ReasonVerdict>();

  const system = `你是歌单推荐语审核员。选歌 AI 给每首歌写了一句**长听感理由**（reason_for_review，给审核看）。
你的双重任务（每首歌判一次）：
1. **判断**：这句推荐理由是否**具体、合理、你强烈认可**。
   - approved = 理由有具体听感、站得住、值得给用户看。
   - rejected = 理由在水（空洞套话、编造历史、与歌不符、泛泛而谈）。
2. **精炼**（仅 approved）：把长理由压成 **12~25 个字（含标点，总长不超过 25 字）**的短句（reason_for_display），
   保留最打动人的那个听感细节，纯文本、无 Markdown、无安全标签。
   **建议 15~22 字**：贴着 25 字上限写容易被截成「副歌爆」这种残句，写得稍短一点更稳。
   rejected 的 reason_for_display 留空。

【极简思考要求】：简短中文迅速判断每首，立刻输出合法纯 JSON 对象。

## 输出（严格 JSON，不要 markdown）
{"reviews":[{"id":"<原样回填>","verdict":"approved|rejected","reason_for_display":"12~25字短句（approved 时填，rejected 留空）"}]}
每首都要给一条。`;

  const listText = items
    .map(i => `[${i.id}] ${i.name} - ${i.artist} | 长理由：${i.reasonForReview}`)
    .join('\n');

  const user = `## 需要你判断 + 精炼的长理由（共 ${items.length} 首）
${listText}

请对每首输出 verdict 与 reason_for_display，直接输出纯 JSON 对象（以 "{" 开头，以 "}" 结尾）。`;

  let rawText = '';
  let callFailed = false;
  try {
    rawText = await aiChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { purpose: 'review', jsonMode: true, maxTokens: 8000, timeoutMs: 900_000 }
    );
  } catch (err) {
    callFailed = true;
    log.warn(`理由精炼调用失败：${(err as Error).message} —— 走长理由截断兜底`);
  }

  const raw = callFailed ? { reviews: [] } : parseReasonReview(rawText);
  const { map, stats } = finalizeReasonVerdicts(items, raw.reviews);

  const approvedCount = [...map.values()].filter(v => v.verdict === 'approved').length;
  const withDisplay = [...map.values()].filter(v => v.verdict === 'approved' && v.reasonForDisplay).length;
  log.info(
    `理由精炼完成：approved ${approvedCount}/${items.length} 首 · 有展示短句 ${withDisplay} 首` +
      `（长理由截断兜底 ${stats.fallbackCount} 首` +
      (stats.unknownVerdictCount > 0 ? ` · verdict 未识别 ${stats.unknownVerdictCount} 首` : '') +
      (stats.downgradedCount > 0 ? ` · approved 空短句降级 ${stats.downgradedCount} 首` : '') +
      '）'
  );
  return map;
}

/** 审核模型能回传的合法 verdict。其余一律视为模型跑偏（P1-E） */
const KNOWN_VERDICTS: ReadonlySet<string> = new Set(['approved', 'rejected']);

/**
 * 长理由兜底时跳过的占位短语：seedNew（本尊新歌必进）没有真听感，
 * 拿它截出来的"推荐语"是骗人的。
 */
const PLACEHOLDER_REASON = /本尊新歌（必进项）/;

export interface ReasonFinalizeStats {
  /** 用长理由截断兜底的数量（P0-A） */
  fallbackCount: number;
  /** 模型回了非法 verdict 的条数（P1-E） */
  unknownVerdictCount: number;
  /** approved 但最终无展示短句、被降级为 rejected 的条数（P1-D） */
  downgradedCount: number;
}

/**
 * 把审核模型的原始回传落成最终结论（reviewReasons 的纯逻辑部分，导出便于定点复验）。
 *
 * 三步，顺序不能换：
 * 1. **落原始结论**：approved 收下短句，其余（含未识别 verdict）归 rejected。
 * 2. **长理由兜底（P0-A）**：没拿到合格短句的，从 reason_for_review 截 25 字顶上 ——
 *    空推荐语比截短的推荐语更伤体验（实测 40 首里 12~30 首无推荐语）。
 *    两种长理由兜不动：① 不足 12 字；② 占位短语「本尊新歌（必进项）」。
 * 3. **矛盾态降级（P1-D）**：兜底后仍出现 approved 却无短句，说明短句与长理由都不合格，
 *    这不是"approved"该有的样子 —— 降级为 rejected 并 log.warn，别让前端拿到空推荐语。
 */
export function finalizeReasonVerdicts(
  items: ReasonReviewItem[],
  reviews: RawReasonReview['reviews']
): { map: Map<string, ReasonVerdict>; stats: ReasonFinalizeStats } {
  const map = new Map<string, ReasonVerdict>();
  const valid = new Set(items.map(i => i.id));

  // ① 落模型原始结论
  const unknown: string[] = [];
  /**
   * **审核明确否决**的 id（verdict 是已知值且非 approved）。
   *
   * 2026-10-29 用户裁定（方案 A）：审核说「完全在水」的歌**不给前端看**。
   * ② 的长理由兜底只救「审核没工作」（整体失败 / 漏回 / verdict 未识别），
   * **绝不能把审核明确否决的翻回 approved** —— 否则「审核当筛子」这条设计就失效了。
   */
  const explicitRejected = new Set<string>();
  for (const r of reviews) {
    if (!valid.has(r.id)) continue;
    const known = KNOWN_VERDICTS.has(r.verdict);
    if (!known) unknown.push(`${r.id}=${r.verdict || '(空)'}`);
    const approved = r.verdict === 'approved';
    const display = clampDisplay(r.reason_for_display);
    if (known && !approved) explicitRejected.add(r.id);
    map.set(r.id, {
      verdict: approved ? 'approved' : 'rejected',
      reasonForDisplay: approved ? display : '',
    });
  }

  /**
   * P1-E：未识别 verdict（`maybe` / 拼错 `apporved` / 空串）原先静默归 rejected ——
   * 会把一句本可展示的推荐语无声杀掉，且从日志里完全看不出模型跑偏。现在带原值告警。
   */
  if (unknown.length > 0) {
    const shown = unknown.slice(0, 5).join('、');
    log.warn(
      `理由审核：${unknown.length} 首 verdict 未识别（既非 approved 也非 rejected），按 rejected 处理` +
        ` —— 疑似模型跑偏，原值：${shown}` +
        (unknown.length > 5 ? ` …（共 ${unknown.length} 条）` : '')
    );
  }

  // ② 长理由兜底（P0-A）—— 只救「审核没工作」，不覆盖「审核明确否决」
  let fallbackCount = 0;
  for (const item of items) {
    // 审核明确说 rejected → 尊重结论，不兜底（2026-10-29 用户裁定方案 A）
    if (explicitRejected.has(item.id)) continue;
    const v = map.get(item.id);
    const ok = v && v.verdict === 'approved' && !!v.reasonForDisplay;
    if (ok) continue;
    const long = String(item.reasonForReview ?? '');
    if (PLACEHOLDER_REASON.test(long)) continue;
    const display = clampDisplay(long);
    if (!display) continue;
    map.set(item.id, { verdict: 'approved', reasonForDisplay: display });
    fallbackCount += 1;
  }

  // ③ 矛盾态降级（P1-D）：approved 必须有展示短句，否则降级 rejected
  const contradictions: string[] = [];
  let downgradedCount = 0;
  for (const item of items) {
    const v = map.get(item.id);
    if (!v) {
      // 模型漏回 + 长理由也兜不动（<12 字 / 占位短语）→ 明确记 rejected。
      // 保证「每首都有结论」，调用侧不用再区分「没结论」和「没推荐语」。
      map.set(item.id, { verdict: 'rejected', reasonForDisplay: '' });
      continue;
    }
    if (v.verdict === 'approved' && !v.reasonForDisplay) {
      map.set(item.id, { verdict: 'rejected', reasonForDisplay: '' });
      contradictions.push(item.id);
      downgradedCount += 1;
    }
  }
  if (downgradedCount > 0) {
    const shown = contradictions.slice(0, 5).join('、');
    log.warn(
      `理由审核：${downgradedCount} 首 approved 却无展示短句（短句不合格且长理由也兜不动），已降级为 rejected` +
        ` —— 疑似模型跑偏，id：${shown}` +
        (contradictions.length > 5 ? ` …（共 ${contradictions.length} 条）` : '')
    );
  }

  return { map, stats: { fallbackCount, unknownVerdictCount: unknown.length, downgradedCount } };
}
