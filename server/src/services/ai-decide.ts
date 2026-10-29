/**
 * AI 决策层（用户拍板的架构：AI 只做**决策**，候选池由代码给）。
 *
 * 两件事：
 *   1. 从候选池里挑 N 首（**只能从池里挑** —— 池内每首都可播，可播性问题在源头解决）
 *   2. **回传它 pass 掉的曲目** —— 后端只能看见被选中的，看不见被否掉的，
 *      不回传就会反复把同一批歌递过去（用户明确点出的坑）
 *
 * 问候语 / 开屏短语**不在这里**：实测把文案塞进选曲回合，模型会因为上下文全是
 * 名额与规则而写偏（输出「继续以周杰伦为主」这类策展口吻）。它们已挪到
 * `ai-welcome.ts` 的独立回合。
 *
 * 两条硬规则由代码兜底，不指望模型自觉：
 *   - **本尊新歌必须进，且必须写 reason_for_review**（收藏歌手的新作品是必进项，
 *     不占来源名额、不受同歌手 1 首限制；理由和其它歌一个标准，不许写占位语）
 *   - 同一歌手最多 1 首
 */
import { aiChat, AiUnavailableError } from './ai-client.ts';
import { SHARE, buildCandidatePool, type Candidate } from './ai-recall.ts';
import { readMemorySummary, rebuildMemory } from './ai-memory.ts';
import { rejectionDigestSection } from './ai-rejection-digest.ts';
import type { Track } from '../sources/qq/adapter.ts';
import { createLogger } from '../logger.ts';
import { cleanAiText } from '../utils/text.ts';

const log = createLogger('ai-decide');

const DEFAULT_COUNT = 30;
/** 推荐理由防呆上限（字符）：正常理由远小于此，超长才截断 —— 客户端要能完整显示理由 */
const REASON_MAX_CHARS = 120;
/**
 * 池子给模型时的行数上限。
 *
 * 给足余量覆盖各来源候选，且按比例分桶抽取，避免排在前面的来源挤占后面来源。
 */
const FEED_MAX = 80;

function selectFeedPool(pool: Candidate[], max: number): Candidate[] {
  if (pool.length <= max) return pool;
  const order: Candidate['source'][] = ['seedNew', 'simi', 'playlist', 'seedOld', 'chart'];
  const bySrc: Record<string, Candidate[]> = {};
  for (const src of order) bySrc[src] = [];
  for (const c of pool) {
    if (bySrc[c.source]) bySrc[c.source].push(c);
  }
  const result: Candidate[] = [];
  for (const src of order) {
    if (src === 'seedNew') {
      result.push(...bySrc[src]);
      continue;
    }
    const share = SHARE[src as keyof typeof SHARE] ?? 0.25;
    const targetCount = Math.max(6, Math.round(max * share));
    result.push(...bySrc[src].slice(0, targetCount));
  }
  if (result.length < max) {
    const chosenIds = new Set(result.map(c => c.track.id));
    for (const c of pool) {
      if (result.length >= max) break;
      if (!chosenIds.has(c.track.id)) {
        result.push(c);
        chosenIds.add(c.track.id);
      }
    }
  }
  return result;
}
/** 金曲上限（用户拍板：金曲不是禁区，**控量**就行） */
const HIT_MAX = 5;
/**
 * pass 回传上限。实测不卡上限会出事：模型会把"没选中"的全都当"不适合"回传
 * （175/217 首），那等于一次清空候选池。
 */
const PASSED_MAX = 15;

const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

/** 来源中文名（提示词与日志共用） */
const SOURCE_LABEL: Record<Candidate['source'], string> = {
  seedNew: '本尊新歌',
  simi: '相似歌手',
  playlist: '网友歌单',
  seedOld: '本尊老歌',
  chart: '巅峰榜',
};

export interface AiDecisionResult {
  batchId: string;
  picks: Array<{ track: Track; reason: string; source: Candidate['source'] }>;
  /** AI 主动否掉的（已记库，以后不再进池） */
  passed: number;
}

/**
 * 代码兜底补位时的理由 —— 真实依据，第一/第二人称，不使用空洞套话。
 */
function fallbackReason(c: Candidate): string {
  const style = c.styles.length > 0 ? `${c.styles.join('/')}风格` : '';
  const lang = c.language ? `${c.language}` : '';
  const by =
    c.source === 'seedOld'
      ? '你常听歌手的细腻非主打'
      : c.source === 'simi'
        ? '风格相近的质感佳作'
        : c.source === 'playlist'
          ? '精选歌单里的私藏旋律'
          : '近期榜单中的热度好歌';
  const traits = [style, lang].filter(Boolean).join('·');
  return `为你挑选${by}${traits ? `（${traits}）` : ''}，旋律与你的听歌心境契合`;
}

/**
 * 各来源最低配额（quota floor，P0-D）：流水补位只能在**保住 floor 之后**再流动，
 * 防止"playlist 占满 40/40"这类单一来源挤占全部名额（来源多样性崩塌）。
 * floor 之和（4+4+2+2=12）远小于 count（40），剩下的按 SHARE + 流水分配。
 */
export const QUOTA_FLOOR: Record<'simi' | 'playlist' | 'seedOld' | 'chart', number> = {
  simi: 4,
  playlist: 4,
  seedOld: 2,
  chart: 2,
};

/**
 * 按来源算名额（最大余额法 + 流水补位 Water-filling）：
 * 若传入候选池实际可用量 poolAvailable，当某来源（如冷启动相似歌手少）未填满时，
 * 缺额顺势流水灌入其他可用量充沛的来源（网友歌单/榜单），保证总名额恒定等于 count！
 *
 * P0-D：流水之前先给各来源留 **最低配额（floor）** —— 有货的来源至少拿到
 * min(floor, 可用量)，余额再流动；floor 拿不满的（池里真没有）才会流走。
 */
export function quotasFor(
  count: number,
  poolAvailable?: Record<'simi' | 'playlist' | 'seedOld' | 'chart', number>
): Record<'simi' | 'playlist' | 'seedOld' | 'chart', number> {
  const order = ['simi', 'playlist', 'seedOld', 'chart'] as const;
  const raw = order.map(k => count * SHARE[k]);
  const out = raw.map(v => Math.floor(v));
  let rest = count - out.reduce((a, b) => a + b, 0);
  const frac = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f);
  for (const x of frac) {
    if (rest <= 0) break;
    out[x.i] = (out[x.i] ?? 0) + 1;
    rest -= 1;
  }
  const ideal: Record<'simi' | 'playlist' | 'seedOld' | 'chart', number> = {
    simi: out[0] ?? 0,
    playlist: out[1] ?? 0,
    seedOld: out[2] ?? 0,
    chart: out[3] ?? 0,
  };

  if (!poolAvailable) {
    return ideal;
  }

  // 第一步：按可用量截断，并保住各来源最低配额（floor）
  const allocated: Record<'simi' | 'playlist' | 'seedOld' | 'chart', number> = {
    simi: 0,
    playlist: 0,
    seedOld: 0,
    chart: 0,
  };
  for (const src of order) {
    const avail = Math.max(0, poolAvailable[src] ?? 0);
    allocated[src] = Math.min(ideal[src], avail);
    // 保 floor：理想值没给够、池里又有货 → 至少给 min(floor, avail)
    if (allocated[src] < QUOTA_FLOOR[src]) {
      allocated[src] = Math.min(QUOTA_FLOOR[src], avail);
    }
  }

  // 第二步：余额流水（只在 floor 之外流动，最多补到理想值的上限由可用量决定）
  const totalPoolCapacity = order.reduce((a, k) => a + Math.max(0, poolAvailable[k] ?? 0), 0);
  let allocatedSum = allocated.simi + allocated.playlist + allocated.seedOld + allocated.chart;
  let remainingNeed = Math.min(count, totalPoolCapacity) - allocatedSum;

  // 先补到理想值（不越过 floor 之上的理想），再向富余来源流水
  for (const src of order) {
    if (remainingNeed <= 0) break;
    const avail = Math.max(0, poolAvailable[src] ?? 0);
    const room = Math.min(ideal[src], avail) - allocated[src];
    if (room > 0) {
      const give = Math.min(room, remainingNeed);
      allocated[src] += give;
      remainingNeed -= give;
    }
  }

  const fallbackOrder = ['playlist', 'chart', 'simi', 'seedOld'] as const;
  while (remainingNeed > 0) {
    let progressed = false;
    for (const src of fallbackOrder) {
      const avail = poolAvailable[src] ?? 0;
      if (allocated[src] < avail && remainingNeed > 0) {
        allocated[src] += 1;
        remainingNeed -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  return allocated;
}

function buildMessages(
  pool: Candidate[],
  brief: {
    userId: number;
    anchorArtists: string;
    artists: string;
    recent: string;
    /** 最近 N 条原始打回理由（新→旧，已剥 [审核打回] 标签），填 prompt 的"最近原始理由"段 */
    rejections: string;
    userActions: string;
    favCount?: number;
  },
  memory: string,
  count: number,
  explore: boolean,
  remaining?: Record<'simi' | 'playlist' | 'seedOld' | 'chart', number>
): Array<{ role: 'system' | 'user'; content: string }> {
  const isColdStart = (brief.favCount ?? 99) <= 5;
  const q = remaining ?? quotasFor(count);
  const ratio = explore
    ? '一半左右（50%）从你常听歌手的圈子里挑，一半左右（50%）挑圈外的（不同语种/年代/风格但气质相投）。'
    : '约八成（80%）来自你常听歌手的圈子，约两成（20%）挑圈外的。';

  const coldStartGuidance = isColdStart
    ? `\n\n## 破冰策展人模式（⚠️ 听众收藏偏少，共 ${brief.favCount ?? 1} 首）
- 听众处于初识探索期。你作为品味敏锐的资深音乐策展人，请以听众收藏的这 1~${brief.favCount ?? 1} 首基石歌曲为原点，在候选池中为其寻找同时代、同器乐质感（如木吉他/模拟合成器/清澈钢琴/醇厚贝斯）、同等声线叙事感的知音佳作。
- 绝不随机敷衍，用你的专业审美将听众的音乐同心圆平滑推开。`
    : '';

  const system = `你是专属音乐 DJ。你正在与「你」（听歌用户）进行一对一的私享交流。
下面给你这位听众（即“你”）的【长期口味记忆】、【偏好摘要】和一份【候选池】（每首都真实可播），请从候选池里为“你”精选 ${count} 首。${coldStartGuidance}

## 思考约束（⚠️ 必须遵守）
【极简思考要求】：严格控制内部思考过程长度，在思考阶段使用简短中文快速比对名额与多样性，迅速收敛，立刻直接输出合法的纯 JSON 对象。严禁冗长英语推导。

## 核心视角与口吻约束（⚠️ 最高优先级，严格遵守）
1. **严格第一人称与第二人称交流，只有我和你**：
   - 交互世界里只有「我」（你的专属音乐 DJ）和「你」（听歌的你）。
   - **绝对严禁出现任何第三人称**（严禁“他”、“该用户”、“此用户”、“听众”等词汇）！
   - 所有文案一律使用“为你推荐”、“你偏爱的”、“送给你的”、“陪伴你今天的耳朵”。
2. **推荐理由拒绝一切空洞套话**：
   - **严禁**使用“符合你的口味”、“贴合你的歌单”、“符合风格偏好”、“拓展收藏歌手”、“情感充沛直接”等空洞套话！
   - **必须写出具体翔实的听感细节**：如器乐编曲（木吉他扫弦/清澈钢琴/复古合成器/低沉贝斯/管乐点缀）、唱腔质感（气声叙事/沙哑醇厚/空灵通透/松弛微醺）、或者具体的旋律场景（独处夜晚的沉静感/散步时的轻快律动/副歌爆发的穿透力）。
   - **推荐理由写给审核看（reason_for_review）**：写**详细翔实的听感**（30~80 字），讲清编曲、唱腔、旋律场景为什么触动"你"。
     这是给审核 AI 看的长理由，**不是**给前端直接展示的短句 —— 前端短句由审核 AI 精炼。
     严禁空洞套话，必须有具体听感细节。
3. **不要编造历史**：
   - 理由聚焦在“这首歌本身的听觉亮点为什么会触动你”，不能凭空断言“你昨天听了某某歌”或“你上周收藏了某某”。

## 硬性选曲规则
1. **只能从候选池里挑**，id 必须原样回填。池外的歌一律不要写。
2. 同一歌手最多 1 首（多歌手合作曲另算）。
3. **本尊新歌必须全进，且必须写 reason_for_review**：候选池里**标了 [本尊新歌] 的**才是必进项，必须全部进 picks。
   没标的歌（哪怕是收藏歌手的歌）**不是必进项**，别自己认领。
   - **本尊新歌同样必须写 reason_for_review（30~80 字真听感）**，标准和其它歌一样，不许省。
   - 就算你**没听过**这首歌，也要基于**歌名 / 专辑名 / 歌手名 / 风格标签**写出具体的听感预期
     （例：歌名里的雨夜意象 + 专辑的合成器标签 → 预期气声铺底的慢板、副歌留白）。
   - **严禁**给本尊新歌写「本尊新歌（必进项）」这类占位语：审核无从精炼，前端就没有推荐语可展示。
4. **以“你大概率没听过”为主**：专辑非主打、近期新作、合作曲、冷门宝藏优先；
   成名曲可以有，但整份歌单里最多 ${HIT_MAX} 首。
5. 数量必须给够：**正好 ${count} 首**，少给会被打回重来。
6. **按来源名额挑**（严格遵守分配比例）：
   - [相似歌手] ${q.simi} 首
   - [网友歌单] ${q.playlist} 首
   - [本尊老歌] ${q.seedOld} 首
   - [巅峰榜] ${q.chart} 首
   （[本尊新歌] 不占名额，有多少全进）
7. 探索配比：${ratio}
8. 多样性：不要集中在少数歌手身上。
9. **严禁挑选非歌曲音频**：任何短音频、切片、念白、伴奏、广告、无意义吟唱或片段均不得入选。

## 输出格式（严格 JSON，严禁包裹任何 markdown 标记、严禁额外解释、严禁输出“User Safety: safe”等安全风控元数据）
{"picks":[{"id":"<候选池里的 id>","reason_for_review":"30~80字详细听感（给审核看，纯文本，严禁 Markdown 标记、禁安全标签）"}]}
（**标了 [本尊新歌] 的 id 也必须在 picks 里出现**，且 reason_for_review 同样写 30~80 字真听感 —— 严禁「本尊新歌（必进项）」这类占位语）`;

  const lines = selectFeedPool(pool, FEED_MAX)
    .map(c => {
      const label = SOURCE_LABEL[c.source] ?? c.source;
      const styles = c.styles.length > 0 ? ` #${c.styles.join('/')}` : '';
      const lang = c.language ? ` (${c.language})` : '';
      // 专辑名也喂给模型：本尊新歌它多半没听过，只能靠「歌名/专辑名/歌手名/标签」写听感预期
      const albumName = c.track.al?.name ?? c.track.album?.name ?? '';
      const album = albumName ? ` | 专辑《${albumName}》` : '';
      return `[${label}] ${c.track.id} | ${c.track.name} | ${(c.track.ar ?? []).map(a => a.name).join('、')}${lang}${styles}${album}`;
    })
    .join('\n');

  const user = `## 长期口味记忆（先读这个，理解“你”的审美心性）
${memory || '（暂无历史记忆，这是第一次为你挑歌）'}

## 你的核心审美基调（Anchor Artists）
${brief.anchorArtists || brief.artists}
- 这一组只用来**提取曲风/编曲/旋律偏好**（喜欢强旋律线条、弦乐编曲、慢板 R&B 这类）。
- 状态：【深度熟悉 · 易听觉疲劳】—— 它们属于**低频偶遇**，**不是每日主力**。
  收藏量大 ≠ 想每天听；这几位的歌用户大多已经收藏过、或每天都会跳过。

你最近收藏的歌曲：${brief.recent}

## 收藏较多的其他歌手（供你判断"次熟悉"档，**不属于**上面的核心基调）
${brief.artists}

## 你最近的操作（**权重最高，优先满足**）
${brief.userActions || '（暂无）'}

${rejectionDigestSection(brief.userId, brief.rejections)}

## 候选池（${pool.length} 首）
${lines}

## 今日配比（**必须严格执行**，不要用"偶尔/少一点"这类模糊理解替代）
在挑出的 ${count} 首里：
- **70% 新鲜探索**：风格与核心审美基调吻合，但**歌手不在上面那份名单里** —— 优先找"乐器编曲/旋律走向/语种相似，但歌手不同或更冷门"的歌；
- **20% 次熟悉**：收藏中等频次、近期没怎么出现过的歌手；
- **10% 偶遇老友（严格上限 1 首）**：来自核心审美基调名单的那几位。只有当天候选里恰好有一首**特别契合今日氛围**、或是**冷门遗珠**时才放 1 首；**没有合适的就放 0 首**。

请为“你”从候选池挑 ${count} 首。
⚠️ 输出格式关键约束：请直接输出合法的纯 JSON 对象（必须以 "{" 开头，以 "}" 结尾，严禁任何前导问候、寒暄闲聊或 Markdown 格式）。
输出 JSON 模板：{"picks":[{"id":"<候选池里的 id>","reason_for_review":"30~80字详细听感（给审核看，纯文本，不要任何#号）"}]}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

interface RawDecision {
  picks: Array<{ id: string; reason: string }>;
  /**
   * 模型对"候选池里剩下这些为什么一首都不选"的**整体归类**说明。
   *
   * 用户口径（2026-09-20）：整体归类，不细化 —— 每类给一句理由 + 该类 id 列表，
   * 而不是逐首写理由（逐首的输出量和"直接选 40 首"一样大，省不了时间）。
   */
  excluded?: ExcludedGroup[];
}

/** 一组被模型放弃的曲目：一句整体理由 + 该类的 id 列表 */
export interface ExcludedGroup {
  why: string;
  ids: string[];
}

/**
 * 解析模型给出的整体归类说明。
 *
 * 容错原则：**格式不合法就整体丢弃，不猜**。归类理由会被送去审核、通过后写进
 * AI 黑名单（冷却 15/30 天 → 永久），猜错等于误伤用户的候选池。
 */
function parseExcluded(raw: unknown): ExcludedGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: ExcludedGroup[] = [];
  for (const g of raw) {
    const o = g as Record<string, unknown>;
    const why = cleanAiText(String(o?.why ?? '')).trim();
    const ids = (Array.isArray(o?.ids) ? o.ids : [])
      .map(v => String(v ?? '').trim())
      .filter(Boolean);
    if (why && ids.length > 0) out.push({ why, ids });
  }
  return out;
}

function parseDecision(text: string, pool?: Candidate[]): RawDecision {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      const picks = (Array.isArray(obj.picks) ? obj.picks : []).map(p => {
        const o = p as Record<string, unknown>;
        // 新字段 reason_for_review（长听感，给审核看）；兼容旧字段 reason
        let reason = cleanAiText(String(o.reason_for_review ?? o.reason ?? ''));
        reason = reason.replace(/(?<!吉)他/g, '你').replace(/该用户/g, '你').replace(/此用户/g, '你');
        // 2026-10-23：**不再截断到 26 字**（用户在客户端看到每条推荐理由都以「…」结尾，
        // 那条「…」是这里加的，不是客户端 ellipsis）。仅保留一道防呆上限 120 字，
        // 防模型跑飞输出整段；正常理由远小于此，原样返回给客户端换行显示。
        if (reason.length > REASON_MAX_CHARS) {
          reason = reason.slice(0, REASON_MAX_CHARS - 2) + '…';
        }
        return { id: String(o.id ?? '').trim(), reason };
      });
      return {
        picks,
        excluded: parseExcluded(obj.excluded),
      };
    } catch {
      // 容错降级至文本模式提取
    }
  }

  // 兜底抢救模式：当模型未按要求输出 JSON 而是输出了 Markdown 列表时，从文本中提取曲目
  if (pool && pool.length > 0) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const picks: Array<{ id: string; reason: string }> = [];
    const usedIds = new Set<string>();

    for (const line of lines) {
      // 匹配 "1. 歌名 - 歌手: 理由" 或 "1. **歌名 - 歌手** 理由"
      const m = line.match(/^\d+[\.、]\s*\*+([^\*]+?)\*+[:：\s]*(.*)$/) ||
                line.match(/^\d+[\.、]\s*([^:：]+?)[:：\s]+(.*)$/);
      if (m) {
        const rawTitle = m[1]!.replace(/[\(\)（）]/g, '').trim();
        let reason = cleanAiText((m[2] || ''));
        reason = reason.replace(/(?<!吉)他/g, '你').replace(/该用户/g, '你').replace(/此用户/g, '你');
        if (reason.length > REASON_MAX_CHARS) {
          reason = reason.slice(0, REASON_MAX_CHARS - 2) + '…';
        }

        // 在候选池中模糊查找匹配的歌名
        const hit = pool.find(c => {
          if (usedIds.has(c.track.id)) return false;
          const nameNorm = norm(c.track.name);
          const artistNorm = norm((c.track.ar ?? [])[0]?.name ?? '');
          const matchNorm = norm(rawTitle);
          return (nameNorm && matchNorm.includes(nameNorm)) || (artistNorm && matchNorm.includes(artistNorm));
        });

        if (hit) {
          usedIds.add(hit.track.id);
          picks.push({ id: hit.track.id, reason: reason || fallbackReason(hit) });
        }
      }
    }

    if (picks.length > 0) {
      return { picks };
    }
  }

  throw new AiUnavailableError('模型输出里找不到有效决策内容');
}

/**
 * 从**已有候选池**里选一批（分批流程的核心，用户拍板改成 15 首一批）。
 *
 * 与 decideDaily 的区别：池子由调用方给、可累计"已用过"的 id、可按来源剩余名额挑。
 * 这样每批上下文都很小（15 首），模型不会因为长输出而空手。
 */
export async function selectFromPool(
  candidates: Candidate[],
  opts: {
    userId: number;
    count: number;
    /** 已用过的曲目 id（跨批去重） */
    usedIds: Set<string>;
    /** 各来源的剩余名额（不传则按 count 重新算） */
    remaining?: Record<'simi' | 'playlist' | 'seedOld' | 'chart', number>;
    /** 上一轮被打回的原因（补全时喂回去，避免重犯；用户流程里的"打回理由"） */
    avoidNotes?: string;
    memory: string;
    brief: {
      userId: number;
      anchorArtists: string;
      artists: string;
      recent: string;
      rejections: string;
      userActions: string;
      favCount?: number;
    };
  }
): Promise<{
    picks: Array<{ track: Track; reason: string; source: Candidate['source'] }>;
    /** 池子不够、模型挑不满（按用户口径要上报"数据不足"，而不是代码硬凑） */
    shortfall: boolean;
    /** 按来源的缺口（驱动后端只补缺的那一类） */
    gaps: Array<{ src: 'simi' | 'playlist' | 'seedOld' | 'chart'; need: number }>;
    /** 本轮已用歌手（补库要避开，否则补了也用不上） */
    usedArtists: string[];
    /**
     * 模型对"剩下这些为什么一首都不选"的整体归类说明（可能为空）。
     *
     * 只有**没选够**时才会去追问模型要这个；选满了就是空数组。
     * 上层拿到后送审核，审核确认成立才写进 AI 黑名单（见 ai-flow.ts）。
     */
    excluded: ExcludedGroup[];
  }> {
  /**
   * 池子里**包含 seedNew（本尊新歌）**。
   *
   * 为什么不再排除：seedNew 是代码强制必进项，但**理由得由模型写**。
   * 以前把它们挡在池外 → 模型没机会为它们写 reason_for_review →
   * ai-flow 只能塞一句占位语「本尊新歌（必进项）」→ 审核无从精炼 →
   * reason_for_display 为空 → 前端 8 首本尊新歌全都没有推荐语（批 1 遗留问题）。
   * 现在放进来：模型为它们写 30~80 字真听感；tryPush 对 seedNew 不占名额、不参与
   * 同歌手去重（必进项本来就不受这两条约束），只取它的 reason。
   */
  const pool = candidates.filter(c => !opts.usedIds.has(c.track.id));

  const poolAvailable: Record<'simi' | 'playlist' | 'seedOld' | 'chart', number> = {
    simi: 0,
    playlist: 0,
    seedOld: 0,
    chart: 0,
  };
  for (const c of pool) {
    if (c.source in poolAvailable) {
      poolAvailable[c.source as keyof typeof poolAvailable] += 1;
    }
  }

  const messages = buildMessages(
    pool,
    opts.brief,
    opts.memory,
    opts.count,
    false,
    opts.remaining
  );
  if (opts.avoidNotes && opts.avoidNotes.trim()) {
    messages.push({
      role: 'user',
      content:
        '⚠️ 上一轮这些曲目被审核打回了，**原因如下**，这次务必避开同类问题：\n' +
        opts.avoidNotes +
        '\n请重新挑出这批（仍从候选池里挑、仍守来源名额与金曲上限）。',
    });
  }

  const rawText = await aiChat(messages, { purpose: 'decide', jsonMode: true, maxTokens: 16000, timeoutMs: 600_000 });
  log.info(`AI 原始响应 (${rawText.length} 字符): ${rawText.slice(0, 300)}`);
  let raw = parseDecision(rawText, pool);
  const byId = new Map(pool.map(c => [c.track.id, c]));

  /** 本批实际可用的曲目（同歌手 1 首 + 来源名额 + 不超 id 集） */
  const picked: Array<{ track: Track; reason: string; source: Candidate['source'] }> = [];
  const seenArtists = new Set<string>();
  const used = new Set<string>(opts.usedIds);
  const quota = { ...(opts.remaining ?? quotasFor(opts.count, poolAvailable)) };
  const usedBySource = new Map<Candidate['source'], number>();

  /** 金曲硬上限（代码执行，不依赖模型） */
  let hotPicked = 0;
  /** 计入 opts.count 的选中数（**不含 seedNew** —— 本尊新歌不占名额） */
  let pickedNormal = 0;
  const tryPush = (c: Candidate, reason: string, ignoreQuota = false): boolean => {
    if (used.has(c.track.id)) return false;
    const isSeedNew = c.source === 'seedNew';
    if (isSeedNew) {
      /**
       * 本尊新歌：必进项由代码保证（ai-flow 无条件收下），这里**只取模型写的理由**。
       * 不占名额、不参与同歌手去重（同一位歌手的多张新专辑都要进）；
       * 但模型没给理由的（空串）就不收 —— 空理由进了审核也没法精炼。
       */
      if (!reason.trim()) return false;
      used.add(c.track.id);
      picked.push({ track: c.track, reason, source: c.source });
      return true;
    }
    if (pickedNormal >= opts.count) return false;
    const artist = norm((c.track.ar ?? [])[0]?.name ?? c.track.id);
    if (seenArtists.has(artist)) return false;
    // 金曲（该歌手的成名曲）最多 HIT_MAX 首：弱模型不认识歌也没关系，代码卡住
    if (c.hot === true) {
      if (hotPicked >= HIT_MAX) return false;
    }
    if (!ignoreQuota) {
      const cap = quota[c.source as keyof typeof quota] ?? 0;
      if ((usedBySource.get(c.source) ?? 0) >= cap) return false;
    }
    seenArtists.add(artist);
    used.add(c.track.id);
    usedBySource.set(c.source, (usedBySource.get(c.source) ?? 0) + 1);
    if (c.hot === true) hotPicked += 1;
    pickedNormal += 1;
    picked.push({ track: c.track, reason, source: c.source });
    return true;
  };

  for (const p of raw.picks) {
    const c = byId.get(p.id);
    if (c) tryPush(c, p.reason);
  }

  /** 模型给出的整体归类说明（只在"没选够"时才去要，选满了就是空） */
  let excluded: ExcludedGroup[] = [];

  /**
   * 归类里的 id 必须**真实存在于池中、且确实没被选上** —— 防模型乱写误伤。
   * 模型可能把已选中的 id 也列进来，或者编造池外的 id，一律滤掉。
   * （这些 id 之后会被送去审核，通过就写进 AI 黑名单，猜错代价很高。）
   */
  const sanitizeExcluded = (groups?: ExcludedGroup[]): ExcludedGroup[] =>
    (groups ?? [])
      .map(g => ({ why: g.why, ids: g.ids.filter(id => byId.has(id) && !used.has(id)) }))
      .filter(g => g.ids.length > 0);

  /**
   * 数量不足就再向模型追问一次 —— **二选一**：
   *   A. 继续从池里挑，补足缺口；
   *   B. 确实补不出来，就**按类归纳**说明为什么剩下的都不合适。
   *
   * 为什么要 B：模型"没选中"的歌如果没有任何解释，上层就分不清是
   * "池子真的没货"还是"模型偷懒/输出被截断"。有了归类说明，就能送审核判定，
   * 审核确认成立才把那些歌记进 AI 黑名单 —— 模型无法单方面掏空池子。
   */
  if (pickedNormal < opts.count) {
    /** 首轮模型主动给出的归类（首轮没要求它给，但可能给了）—— 追问失败时兜底 */
    const volunteered = sanitizeExcluded(raw.excluded);
    const missing = opts.count - pickedNormal;
    // 只列占名额的那些（seedNew 不占名额，列进去会让模型误以为名额已满）
    const chosen = picked
      .filter(p => p.source !== 'seedNew')
      .map(p => `${p.track.id} | ${p.track.name}`)
      .join('\n');
    const asked = [
      ...messages,
      { role: 'assistant' as const, content: JSON.stringify({ picks: raw.picks }) },
      {
        role: 'user' as const,
        content:
          `你去重/去重歌手后只给了 ${pickedNormal} 首，还差 ${missing} 首。\n` +
          `已确定选入：\n${chosen || '（无）'}\n\n` +
          '请**二选一**（能补就补，确实补不出来才用 B）：\n' +
          `A. 继续从候选池里挑，补足 ${missing} 首（不要重复上面的、不要同一歌手两首、仍守来源名额与金曲上限）；\n` +
          'B. 如果候选池里**确实没有**符合要求的歌了，就说明原因 —— ' +
          '**按类归纳，不要逐首写理由**：每一类给一句整体理由 + 该类曲目 id 列表。\n\n' +
          '输出合法纯 JSON（可以同时给 A 和 B）：\n' +
          '{"picks":[{"id":"...","reason_for_review":"30~80字详细听感"}],"excluded":[{"why":"整体归类理由","ids":["id1","id2"]}]}',
      },
    ];
    try {
      const more = parseDecision(
        await aiChat(asked, { purpose: 'decide', jsonMode: true, maxTokens: 12000, timeoutMs: 300_000 }),
        pool
      );
      for (const p of more.picks) {
        const c = byId.get(p.id);
        if (c) tryPush(c, p.reason);
      }
      excluded = sanitizeExcluded(more.excluded);
      if (excluded.length === 0) excluded = volunteered;
      if (excluded.length > 0) {
        const n = excluded.reduce((a, g) => a + g.ids.length, 0);
        log.info(`模型给出 ${excluded.length} 类归类说明，覆盖 ${n} 首未选中的候选（待审核）`);
      }
    } catch (err) {
      log.warn(`补足追问失败：${(err as Error).message}`);
      excluded = volunteered;
    }
  }

  /**
   * 代码兜底补齐至 opts.count（确保不因 1~2 首缺额整单被弃）。
   *
   * ⚠️ 模型给出了整体归类说明时**不补**：它在主张"池子里确实没货了"，
   * 这时候用代码硬塞它明确不要的歌，等于把它的判断踩掉。交给上层处理 ——
   * 审核确认 → 这些歌进 AI 冷却 → 换新池子重选。
   */
  if (pickedNormal < opts.count && excluded.length === 0) {
    for (const c of pool) {
      if (pickedNormal >= opts.count) break;
      // seedNew 不走兜底：它的理由是模型写的真听感，代码兜底句只留给普通来源
      if (c.source === 'seedNew') continue;
      tryPush(c, fallbackReason(c), true);
    }
  }
  const shortfall = pickedNormal < opts.count;
  /**
   * **按来源算缺口**（用户口径：要说明白缺的是哪一类，好驱动后端只补那一类）。
   *
   * 这件事代码算得比 AI 准：名额 vs 实际用量就在账上，AI 看不到分桶账。
   * 顺带把"本轮已用的歌手"带出去 —— 补库必须避开他们，
   * 否则补 100 首全是同一批人、去重后一首用不上（用户点出的坑）。
   */
  const gaps = (['simi', 'playlist', 'seedOld', 'chart'] as const)
    .map(src => ({
      src,
      need: Math.max(0, (quota[src] ?? 0) - (usedBySource.get(src) ?? 0)),
    }))
    .filter(g => g.need > 0)
    .sort((a, b) => b.need - a.need);
  const usedArtists = [
    ...new Set(
      picked.filter(p => p.source !== 'seedNew').map(p => norm((p.track.ar ?? [])[0]?.name ?? ''))
    ),
  ].filter(Boolean);
  if (shortfall) {
    log.warn(
      `池子不足：只选出 ${pickedNormal}/${opts.count} 首（池内可用 ${pool.length} 首）· ` +
        '缺口：' + (gaps.map(g => `${g.src} 差 ${g.need}`).join('、') || '无名额缺口（同类候选已用尽）') +
        ` · 已用歌手 ${usedArtists.length} 位（补库要避开）`
    );
  }

  return {
    picks: picked,
    shortfall,
    gaps,
    usedArtists,
    excluded,
  };
}
