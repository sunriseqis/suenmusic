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
import { aiChat, AiUnavailableError } from './ai-client.ts';
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

export interface ReviewResult {
  /** trackId → 打回原因 */
  rejects: Map<string, string>;
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
): Promise<ReviewResult> {
  if (items.length === 0) return { rejects: new Map() };

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

  let rawText = '';
  try {
    rawText = await aiChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // ⚠️ 900s：本地 9router/glm-5.3-flash 是推理模型，实测一次 14k token 的输出要
      // 530.9 秒（其中 8k 是思考 token）。原来的 90s 必然超时，且失败时是
      // "安全放行全部曲目"这种静默降级 —— 等于审核环节形同虚设。
      { purpose: 'review', jsonMode: true, maxTokens: 8000, timeoutMs: 900_000 }
    );
  } catch (err) {
    log.warn(`审核阶段模型调用失败或超时，安全放行全部曲目：${(err as Error).message}`);
    return { rejects: new Map() };
  }

  const raw = parseReview(rawText);

  const valid = new Set(items.map(i => i.id));
  const rejects = new Map<string, string>();
  for (const r of raw.reject) {
    if (valid.has(r.id)) rejects.set(r.id, r.why);
  }
  log.info(`审核完成：打回 ${rejects.size}/${items.length} 首`);
  return { rejects };
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
