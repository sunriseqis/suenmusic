/**
 * 开屏文案 AI —— **只**写问候语与欢迎短语。
 *
 * ## 为什么单开一个回合（2026-09-21 用户拍板）
 *
 * 这两句原本挂在**选曲**那一次调用里：一个 system prompt 既要挑 N 首歌
 * （来源名额、金曲上限、多样性、探索配比……几百行选曲规则），末尾再附一句
 * 「## 另外生成：greeting / welcomePhrase」。
 *
 * 结果是模型在选曲语境里顺手把 welcomePhrase 写成了**策展口吻** ——
 * 线上实测出现「继续以周杰伦为主」「老规矩情歌为主」这种句子，
 * 因为它根本没意识到自己在写欢迎词，只当是歌单说明的一部分。
 * 再加上下游把标点删掉、硬切前 8 个字，就成了半截话。
 *
 * 现在这里只有一件事：**读这个人的音乐审美，写两句话**。
 * 不给候选池、不给任何选曲规则 —— 没有可混淆的上下文。
 */

import { aiChat } from './ai-client.ts';
import { createLogger } from '../logger.ts';
import { cleanAiText } from '../utils/text.ts';

const log = createLogger('ai-welcome');

/** 欢迎短语长度上限。宽松取值：宁可留多也不截断，版面留给两行。 */
const PHRASE_MAX = 24;
/** 导语长度上限（原值，界面位置就那么大） */
const GREETING_MAX = 60;

export interface WelcomeCopy {
  /** 首页大字：一句完整通顺、第一人称的欢迎语 */
  welcomePhrase: string;
  /** 每日页导语：首句为 3~8 字短语 + 中文逗号，逗号前作大标题 */
  greeting: string;
}

/**
 * 超长时按标点闭环截断（与收藏页 slogan 的既有做法一致）。
 * 找不到闭合标点才退化为硬切 —— **不删标点、不无脑切**。
 */
function clampAtPunctuation(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  // 优先在句末标点收尾（保留该标点）
  const end = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'));
  if (end > 0) return head.slice(0, end + 1);
  // 退而求其次：收在子句标点**之前**，丢掉挂尾的逗号 —— 否则读起来像被截断
  const clause = Math.max(head.lastIndexOf('，'), head.lastIndexOf('；'));
  if (clause > 0) return head.slice(0, clause);
  return head;
}

function buildMessages(opts: {
  memory: string;
  brief: { artists: string; recent: string; userActions: string; favCount?: number };
}): Array<{ role: 'system' | 'user'; content: string }> {
  const system = `你是这位听众的专属音乐 DJ。现在**只做一件事**：写两句话放在 App 上迎接「你」。

## 唯一任务
依据下面给出的【长期口味记忆】与【偏好摘要】，写：
1. **welcomePhrase**：一句完整的欢迎语，显示在首页大字位置。
2. **greeting**：一句导语，显示在每日推荐页。

## 硬性要求
- **必须第一人称**：说话人是「我」（DJ），听话人是「你」。只能用「我 / 你 / 你的 / 为你」。
- **必须是完整的、通顺的一句话**，不能是短语堆砌，也不要半截话。
- **严禁歌单策展口吻**。以下这类词**绝对不许出现**：歌单、推荐、继续、照旧、老规矩、为主、主打、挑选、精选、入选、曲目、这批、这轮。
- **严禁出现任何歌手名、歌曲名、专辑名**（那是选曲的活，不是欢迎词的）。
- **严禁时段套话**：「早上好 / 中午好 / 晚上好 / 夜深了」这类交给代码兜底，不要你写。
- 严禁 Markdown 标记（#、*、>、\` 等），严禁任何安全风控前缀。
- 语气真诚、具体、有温度；不要空洞抒情，也不要浮夸。

## 格式要求
- **welcomePhrase**：6~20 个汉字，一句完整的话，**句末要有标点**（。！？皆可）。允许含中文逗号。
- **greeting**：不超过 ${GREETING_MAX} 字。必须以一句 3~8 个汉字的短语开头并紧跟中文逗号「，」
  （逗号前的短语会作为每日页大字主标题），逗号后是副标题。
- 两句话**不要重复**，不要是同一句换皮。

## 正例（仅供体会口吻，禁止照抄）
- welcomePhrase：「夜色正好，我留了几首歌陪你慢慢听。」
- welcomePhrase：「又见面了，今天想陪你听点不那么吵的。」
- welcomePhrase：「我在，给你备好了一整天的背景音。」
- greeting：「静夜相伴，为你留了些适合独自放空的慢歌，愿你听得安稳。」
- greeting：「轻快出发，今天的旋律适合边走边听，给自己一点好心情。」

## 输出格式
直接输出合法纯 JSON，不要任何前导语、不要 Markdown 代码块：
{"welcomePhrase":"...","greeting":"..."}`;

  const user = `## 长期口味记忆（先读这个，理解「你」的审美心性）
${opts.memory || '（暂无历史记忆，这是第一次打扰你）'}

## 偏好摘要
你最常听的歌手：${opts.brief.artists}
你最近收藏的歌曲：${opts.brief.recent}
最近的操作：${opts.brief.userActions || '（暂无）'}

请按上面的要求，输出 {"welcomePhrase":"...","greeting":"..."}。`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 写开屏文案。
 *
 * **失败一律返回空串**，由上层回落到时段问候 ——
 * 文案是锦上添花，绝不能因为它挂了就让整条选曲流程失败。
 */
export async function writeWelcome(opts: {
  memory: string;
  brief: { artists: string; recent: string; userActions: string; favCount?: number };
}): Promise<WelcomeCopy> {
  const empty: WelcomeCopy = { welcomePhrase: '', greeting: '' };
  let text = '';
  try {
    text = await aiChat(buildMessages(opts), {
      purpose: 'decide',
      jsonMode: true,
      maxTokens: 4000,
      timeoutMs: 600_000,
    });
  } catch (err) {
    log.warn(`开屏文案生成失败，回落时段问候：${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }

  try {
    const raw = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const obj = JSON.parse(raw) as { welcomePhrase?: unknown; greeting?: unknown };
    const welcomePhrase = clampAtPunctuation(cleanAiText(String(obj.welcomePhrase ?? '')), PHRASE_MAX);
    const greeting = clampAtPunctuation(cleanAiText(String(obj.greeting ?? '')), GREETING_MAX);
    log.info(`开屏文案：短语「${welcomePhrase}」 · 导语「${greeting}」`);
    return { welcomePhrase, greeting };
  } catch (err) {
    log.warn(`开屏文案解析失败，回落时段问候：${text.slice(0, 200)}`);
    return empty;
  }
}
