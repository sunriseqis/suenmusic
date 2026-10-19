/**
 * 用户口味记忆区（用户拍板的设计）。
 *
 * ## 形态：一份可读的 MD 产物
 *
 * `data/memory/<userId>.md` —— 每次生成后重新写一遍，用户可以直接打开看
 * "AI 眼里的我是什么样"。内容分三块：
 *
 *   1. **收藏画像**（代码写）：歌手排行 / 受控分类分布 / 语种分布
 *   2. **推荐台账**（代码写）：最近推过哪些、判过哪些"不合适"
 *   3. **AI 摘要**（模型写，≤200 字）：它对这个人口味的理解
 *
 * ## 为什么拆开写（用户明确认可的分工）
 *
 * 让 AI 每轮重写整份长文档 = 又慢又不稳、必然越写越长、上下文越爆。所以：
 * 结构化部分**由代码生成**（确定、可校验、永不跑偏），AI 只负责那一段自然语言
 * 摘要（短任务，模型稳）。
 *
 * ## 它被谁消费
 *
 * 生成推荐时把"AI 摘要 + 画像"喂回模型（"先读记忆，再决策"）；召回侧也用它
 * 做关键词（比如画像里点出的风格倾向）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';
import { getDatabase } from '../db/index.ts';
import { getSetting, getSettingRow, setSetting } from '../db/repo/settings.ts';
import { aiChat } from './ai-client.ts';
import { autoTagUntagged, tagTracksHeuristic } from './ai-tags.ts';
import { favoriteArtistRanking, topArtists } from './artist-stats.ts';
import { createLogger } from '../logger.ts';
import { cleanAiText } from '../utils/text.ts';

const log = createLogger('ai-memory');

/** 记忆文件放在 DB 同级的 memory/ 下（备份数据库时顺手带上） */
const MEMORY_DIR = join(dirname(config.dbPath), 'memory');

/**
 * AI 摘要长度上限。
 *
 * 用户拍板：**不能卡死字数**（"过的时间越长越难补充细节"）。这里给足冗余，
 * 摘要要承载"本轮选了什么/为什么、打回了什么/为什么"——它就是跨轮的唯一上下文
 * 载体（下次读 MD 时天然拿到压缩过的历史），所以不能只有一两句空话，严禁中途截断。
 */
const SUMMARY_MAX = 3000;

/**
 * 清洗与规整用户画像 Markdown：
 * 1. 严格禁止在各级标题中输出版本号（如“第N版”、“第N+1版”、“v1.x”等），保持标题干净专业；
 * 2. 若标题或文本中检测到版本标记，自动剥离并迁移至文末以落款规范呈现（用户拍板：版本输出在底部）；
 * 3. 避免硬切断，保持内容结构完整。
 */
export function sanitizePersonaSummary(raw: string): string {
  if (!raw) return '';
  let text = raw.trim();

  // 0. 剥离模型/网关安全检查与元数据残留（如 "User Safety: safe"、"[Safety: safe]" 等）
  text = text.replace(
    /(?:\[|【)?\b(?:user\s+|content\s+|system\s+)?safety(?:\s+(?:assessment|rating|check|status|result))?\s*[:：]\s*(?:safe|pass|ok|clean|neutral|none|true|false)\b[\s,，;；、\-—]*\]?】?/gi,
    ''
  );
  text = text.replace(/^[，,：:;；、\-—\s]+/, '').trim();

  // 1. 检测标题或正文中出现的版本号标记，例如：（第N版）、(第N+1版)、(第2版)、(v1.2)、(版本3) 等
  let detectedVersion = '';
  const versionMatch = text.match(/(?:第\s*[0-9一二三四五六七八九十Nn\+＋]+\s*版|v(?:er(?:sion)?)?\s*[\d\.]+|版本\s*[\d\.]+)/i);
  if (versionMatch) {
    detectedVersion = versionMatch[0].trim();
  }

  // 2. 从所有标题行（#、##、###）中彻底移除版本号及括号
  text = text.replace(/^(#+\s*[^\n]*?)[（\(][^）\)]*(?:版本|版|ver)[^）\)]*[）\)]([^\n]*)$/gim, '$1$2');
  text = text.replace(/^(#+\s*[^\n]*?)(?:第\s*[0-9一二三四五六七八九十Nn\+＋]+\s*版|v(?:er(?:sion)?)?\s*[\d\.]+|版本\s*[\d\.]+)([^\n]*)$/gim, '$1$2');
  // 清理标题行末尾遗留的多余空格
  text = text.replace(/^(#+[^\n]*?)\s+$/gm, '$1');

  // 3. 如果提取到了版本号，且全文底部尚未有版本标记，则规范追加到底部
  if (detectedVersion && !/(?:画像版本|版本[：:]|\*版本)/i.test(text.slice(-100))) {
    text = text.trim() + `\n\n---\n*画像版本：${detectedVersion}*`;
  }

  return text.trim();
}

export interface MemoryDigest {
  /** AI 写的那段摘要（可能为空 —— 摘要失败不影响主链路） */
  summary: string;
  /** 画像行（给提示词用，一行一个维度） */
  profileLines: string[];
  /** MD 文件路径 */
  path: string;
}

/** 收藏画像：歌手排行 + 分类分布 + 语种分布（全部来自本地数据，零请求） */
function portrait(userId: number): string[] {
  // 预检并静默补全未打标曲目，杜绝画像中分类分布或语种分布出现空缺
  tagTracksHeuristic(500);
  const db = getDatabase();
  const artists = favoriteArtistRanking(userId, 20)
    .map(r => `${r.name}(${r.count})`)
    .join('、');

  /**
   * ★ 核心审美基调（Anchor Artists）单列一段。
   *
   * 起因（2026-09-22）：原来只给模型一个扁平的"收藏歌手排行"，
   * 模型就把"收藏最多"直接当成了"每天都该听" —— 表现为推荐歌单里
   * 永远前两位是收藏量最大的歌手，用户每天都会跳过。
   *
   * 这里把用途讲清楚：这一组只用来**提取曲风/编曲/旋律偏好**，
   * 不代表"每天要听"；并显式标注【深度熟悉 · 易听觉疲劳】，
   * 与下面客观分布的定位区分开。选曲侧的硬约束另见 ai-recall / ai-decide。
   */
  const tops = topArtists(userId);
  const anchorLine = tops.length
    ? `核心审美基调（Anchor Artists）：${tops.map(t => t.name).join('、')}\n` +
      '  - 用途：这些是**曲风/编曲/旋律偏好**的提取依据，用于找"风格相近但歌手新鲜"的歌；\n' +
      '  - 状态：【深度熟悉 · 易听觉疲劳】—— 它们属于**低频偶遇**，不是每日主力，不要因为收藏量高就优先推。'
    : '核心审美基调（Anchor Artists）：（收藏量尚不足以判定）';

  const styles = (
    db
      .prepare(
        `SELECT je.value AS style, COUNT(*) AS n
           FROM favorites f JOIN track_tags g ON g.track_id = f.track_id, json_each(g.styles) je
          WHERE f.user_id = ? GROUP BY style ORDER BY n DESC`
      )
      .all(userId) as unknown as Array<{ style: string; n: number }>
  )
    .map(r => `${r.style}${r.n}`)
    .join(' / ');

  const langs = (
    db
      .prepare(
        `SELECT g.language AS lang, COUNT(*) AS n
           FROM favorites f JOIN track_tags g ON g.track_id = f.track_id
          WHERE f.user_id = ? AND g.language != '' GROUP BY lang ORDER BY n DESC`
      )
      .all(userId) as unknown as Array<{ lang: string; n: number }>
  )
    .map(r => `${r.lang}${r.n}`)
    .join(' / ');

  return [
    anchorLine,
    `收藏歌手排行：${artists || '（无）'}`,
    `收藏分类分布：${styles || '（还没打标）'}`,
    `收藏语种分布：${langs || '（还没打标）'}`,
  ];
}

/**
 * 推荐台账：**只保留真信号**。
 *
 * ⚠️ 这里曾经还有一行「近 7 天已推荐 N 首：歌名裸列」—— 那是幻觉源，已删除：
 * 模型看到一串推荐歌名、又看不到任何负面标记，必然推出"他都接受了"。
 * 实测代价（2026-09-22）：近 7 天推荐 240 首、真正被播过的只有 30 首、
 * 完整听完 8 首，而画像的结论是「近期推荐台账中接受度良好」，
 * 甚至据此断言四个**收藏里 0 首**的歌手"接纳已验证"。
 *
 * 它原本想承担的"别重复推"职责，由 recommend_history 的 7 天物理排除
 * （ai-recall.buildExclusions）承担，不依赖这一段文本。
 */
function ledger(userId: number): string[] {
  const db = getDatabase();
  const passed = db
    .prepare(
      `SELECT name, artist, reason FROM ai_passed WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`
    )
    .all(userId) as unknown as Array<{ name: string; artist: string; reason: string }>;

  // ⚠️ 用户前端操作是**最高权重**的输入，必须真的传进画像提示词里
  // （之前提示词里写了"他自己在前端的操作"，但数据没接上 —— 实验时抓到的 bug）
  const dislikes = db
    .prepare(
      `SELECT type, name FROM user_dislikes WHERE user_id = ? ORDER BY created_at DESC LIMIT 15`
    )
    .all(userId) as unknown as Array<{ type: string; name: string }>;
  const recentFav = db
    .prepare(
      `SELECT json_extract(t.payload_json, '$.name') AS name,
              json_extract(t.artists_json, '$[0].name') AS artist
         FROM favorites f JOIN tracks t ON t.id = f.track_id
        WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 15`
    )
    .all(userId) as unknown as Array<{ name: string; artist: string }>;

  const lines: string[] = [];
  if (dislikes.length > 0) {
    lines.push(
      '**他点过"不喜欢"的（最高权重信号，要分析原因）**：' +
        dislikes.map(d => `${d.name}（${d.type === 'artist' ? '整位歌手' : '单曲'}）`).join('、')
    );
  }
  if (recentFav.length > 0) {
    lines.push(
      '**他最近新收藏的（实际行为优先于既往判断，哪怕与之前的禁忌冲突）**：' +
        recentFav.map(f => `${f.name}-${f.artist}`).join('、')
    );
  }
  lines.push(
    `已判"不合适"（不再推）${passed.length} 首：` +
      (passed.map(p => `${p.name}-${p.artist}（${p.reason || '未写原因'}）`).join('；') || '（无）')
  );
  return lines;
}

/** 让模型写一段 ≤200 字的口味摘要（短任务，稳） */
async function askSummary(
  profile: string[],
  led: string[],
  prevSummary: string
): Promise<string> {
  try {
    const text = await aiChat(
      [
        {
          role: 'system',
          content:
            '你在帮一位用户维护"口味记忆"，供以后给他排歌单时参考。\n' +
            '给你的是客观数据（收藏画像 + 推荐台账 + **他自己在前端的操作**）。\n\n' +
            '【极简思考要求】：严格控制思考过程长度，思考阶段必须用简短中文迅速收敛，严禁冗长英语推导，直接输出最终画像正文 Markdown（600~1000字）。\n\n' +
            '## 你要做的是「提取」，不是「转抄」\n' +
            '从这些材料里提炼出**判断依据**，不要把会话流水账写进去 —— 具体哪些歌上过歌单、' +
            '哪些被否过，代码已经处理掉了，不需要记在画像里。\n\n' +
            '## 三条内容要求\n' +
            '1. **他偏好什么**（风格/语种/歌手类型，粒度要能当筛选依据）；\n' +
            '2. **他不要什么**（归纳成"路数"，例如"网络口水情歌""年代久远""拼接式合作"）。\n' +
            '   —— 允许（也建议）写**一两个代表性例子**，例如"年代久远的（像《海阔天空》那种）"，' +
            '因为例子能让后来的 AI 具体理解这条禁忌指的是什么；\n' +
            '3. **下一轮该注意什么**（例如"本尊老歌优先非主打""粤语可多给"）。\n\n' +
            '## 最高权重的信号\n' +
            '**他自己在前端的操作**（点"不喜欢"、新收藏）权重最高。你要**分析他为什么这么做**：\n' +
            '  - 他点了"不喜欢" → 推断是"太熟了"、"风格不对"还是"年代久远"，写进禁忌；\n' +
            '  - 他新收藏了 → 这是**实际行为，优先于你之前的任何判断**。\n' +
            '    例如你上一版画像写"不要年代久远的"，但他最近入库了几首老歌 → **以他为准，更新这条判断**。\n\n' +
            '直接输出画像正文（字数控制在 600 ~ 1200 字，必须完整闭环），严禁在任何标题中出现“第N版”等版本号字样。',
        },
        {
          role: 'user',
          content:
            `【上一版画像（你要在它的基础上维护）】\n${prevSummary || '（还没有画像，这是第一版）'}\n\n` +
            `【当前客观画像】\n${profile.join('\n')}\n\n【最近推荐台账】\n${led.join('\n')}\n\n` +
            '请**更新**这份画像：\n' +
            '  - 仍然成立的条目 → 保留（可以精简措辞）\n' +
            '  - 与他的实际行为冲突的 → **以他为准**改掉\n' +
            '  - 本轮新暴露的偏好/禁忌 → 补充进去\n' +
            '  - 严禁在各级标题中输出版本号（如需标明版本演进，统一在全文最底部单行落款）；\n' +
            '  - 必须完整输出画像正文，严禁中途截断。只输出画像正文。',
        },
      ],
      // ⚠️ 推理模型要给足额度与时长：思考与生成长篇画像耗时较长，给足 180s 与 12000 tokens
      // ⚠️ 600s：实测本端点（SiliconFlow/DeepSeek-V3.2）生成千字画像要 150~296 秒，
      // 180s 会被频繁掐断（表现为"画像一直不更新"）。真正防永久挂住的是
      // utils/http-agent.ts 里的出站兜底（15 分钟）。
      { purpose: 'memory', maxTokens: 12000, timeoutMs: 600_000, temperature: 0.4 }
    );
    const cleaned = text.replace(/^["'“]|["'”]$/g, '').trim();
    return sanitizePersonaSummary(cleaned.slice(0, SUMMARY_MAX));
  } catch (err) {
    /**
     * ⚠️ 这里**不能吞**。
     *
     * 吞掉的后果是「画像内容没变、但 MD 文件时间戳变了」—— 用户只能靠
     * "更新时间怎么没动"来发现问题（2026-09-21 真实踩过，查了很久）。
     * 失败就如实上抛：
     *   - 手动入口（全量生成/引导调优）→ 路由返回明确错误，前端能看到；
     *   - 后台入口（每日流程）→ 那边是 fire-and-forget + 自带 catch，不会被带崩。
     */
    log.warn(`摘要生成失败：${(err as Error).message}`);
    throw err;
  }
}

/**
 * 重建用户记忆（写 MD + 返回摘要与画像行）。
 *
 * @param opts.refreshSummary false = 沿用上次的摘要（省一次模型调用）
 */
export async function rebuildMemory(
  userId: number,
  opts: { refreshSummary?: boolean } = {}
): Promise<MemoryDigest> {
  const db = getDatabase();
  const profile = portrait(userId);
  const led = ledger(userId);

  const key = `ai_memory.summary:${userId}`;
  let summary = '';
  const prevSummary = readMemorySummary(userId);
  if (opts.refreshSummary !== false) {
    summary = await askSummary(profile, led, prevSummary);
    if (summary) {
      db.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(key, summary, Date.now());
    }
  }
  if (!summary) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    summary = row?.value ?? '';
  }

  const md = [
    `# 口味记忆 · 用户 ${userId}`,
    '',
    `> 自动生成，请勿手改。更新时间：${new Date().toLocaleString('sv')}`,
    '',
    '## 收藏画像',
    ...profile.map(l => `- ${l}`),
    '',
    '## 推荐台账',
    ...led.map(l => `- ${l}`),
    '',
    '## AI 摘要',
    summary || '（摘要生成失败，下次生成时会重试）',
    '',
  ].join('\n');

  const path = join(MEMORY_DIR, `${userId}.md`);
  try {
    mkdirSync(MEMORY_DIR, { recursive: true });
    writeFileSync(path, md, 'utf8');
  } catch (err) {
    log.warn(`记忆文件写入失败：${(err as Error).message}`);
  }
  log.info(`记忆已更新：${path}（摘要 ${summary.length} 字）`);
  return { summary, profileLines: profile, path };
}

/** 读上次的摘要（生成时"先读记忆"用，不触发模型调用） */
export function readMemorySummary(userId: number): string {
  const row = getDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(`ai_memory.summary:${userId}`) as { value: string } | undefined;
  return row?.value ?? '';
}

export interface PersonaDetail {
  summary: string;
  profileLines: string[];
  ledgerLines: string[];
  lastGuidance: string;
  updatedAt: number | null;
}

/** 读取用户画像详情 */
export function getPersonaDetail(userId: number): PersonaDetail {
  const summaryRow = getSettingRow(`ai_memory.summary:${userId}`);
  const guidance = getSetting(`ai_memory.guidance:${userId}`) ?? '';
  const profile = portrait(userId);
  const led = ledger(userId);

  return {
    summary: summaryRow?.value ?? '',
    profileLines: profile,
    ledgerLines: led,
    lastGuidance: guidance,
    updatedAt: summaryRow?.updatedAt ?? null,
  };
}

const personaInFlight = new Map<number, Promise<PersonaDetail>>();

/** 用户引导式调优画像 */
export async function tunePersona(
  userId: number,
  guidance: string
): Promise<PersonaDetail> {
  const trimmed = guidance.trim();
  if (!trimmed) {
    throw new Error('调优意见不能为空');
  }

  // 相同用户并发任务单飞：避免用户多次点击导致重复消耗 Token
  const existing = personaInFlight.get(userId);
  if (existing) {
    log.info(`用户 ${userId} 画像更新任务正在执行中，复用当前任务`);
    return existing;
  }

  const task = (async () => {
    const prevSummary = readMemorySummary(userId);
    const profile = portrait(userId);
    const led = ledger(userId);

    const systemPrompt =
      '你在帮一位用户调优其专属的"音乐口味画像"。这份画像是之后每天为他挑选、排布专属歌单的核心准则。\n' +
      '你手头有：【上一版画像】、【客观曲库画像与交互台账】、以及【用户本人的最新调优引导】。\n\n' +
      '【极简思考要求】：严格控制思考过程长度，思考阶段必须用简短中文迅速收敛，严禁漫长冗余的英文推导，迅速直接输出最终画像正文 Markdown（600~1000字）。\n\n' +
      '## 核心调优原则\n' +
      '1. **绝对遵从用户本人的意志（最高准绳）**：\n' +
      '   - 用户明确排斥或讨厌的（风格/语种/歌手类型），必须立即立为严格禁忌，坚决不推；\n' +
      '   - 用户表示不抵触或想尝试的，解除既有禁忌，转为适度探索；\n' +
      '   - 用户指定的场景偏好（例如“睡前要轻柔钢琴曲”、“跑步要强节奏摇滚”），明确写为场景化选歌规则；\n' +
      '   - 用户对特定风格、年代、语种的权重调整，立刻重构画像中的倾向排序。\n' +
      '2. **提炼与洞察，非流水账**：\n' +
      '   - 结合客观曲库数据与用户引导，输出条理清晰、层次分明、深入本质的口味洞察；\n' +
      '   - 保留依然成立的历史判断，融合用户最新引导，修正或删除已过时/冲突的旧条款；\n' +
      '   - 口吻温润、沉浸、第一人称对话感（面向“我和你”，绝无“他”）；\n' +
      '   - 总字数控制在 600 ~ 1200 字以内，条理清晰，确保完整输出，严禁中途截断。\n' +
      '3. **格式与标题规范**：\n' +
      '   - 直接输出画像正文 Markdown（支持加粗和无序列表），不要包含多余开场白或寒暄；\n' +
      '   - 标题统一为简洁的主题（如：`## 音乐口味画像`），严禁在任何标题中输出“第N版”、“第N+1版”、“版本号”等字样；\n' +
      '   - 若需标明版本演进，必须统一放在画像全文最底部以独立的单行落款形式输出（如：`*画像版本：第 N 版*`）。';

    const userPrompt =
      `【上一版画像】\n${prevSummary || '（暂无历史画像）'}\n\n` +
      `【用户本人的最新调优引导】\n"${trimmed}"\n\n` +
      `【当前客观曲库画像】\n${profile.join('\n')}\n\n` +
      `【最近台账】\n${led.join('\n')}\n\n` +
      '请根据用户的最新调优引导与客观数据，彻底更新并重构这份音乐画像正文（严禁在标题出现版本号，标题保持纯净，若有版本只能在最底部单行落款，必须完整输出）：';

    const newSummary = await aiChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      // ⚠️ 600s：实测本端点（SiliconFlow/DeepSeek-V3.2）生成千字画像要 150~296 秒，
      // 180s 会被频繁掐断（表现为"画像一直不更新"）。真正防永久挂住的是
      // utils/http-agent.ts 里的出站兜底（15 分钟）。
      { purpose: 'memory', maxTokens: 12000, timeoutMs: 600_000, temperature: 0.4 }
    );

    const cleaned = sanitizePersonaSummary(newSummary.trim().slice(0, SUMMARY_MAX));
    if (!cleaned) {
      throw new Error('AI 生成画像正文为空，请检查模型额度或重试');
    }

    setSetting(`ai_memory.summary:${userId}`, cleaned);
    setSetting(`ai_memory.guidance:${userId}`, trimmed);

    // 同步更新本地 markdown 产物文件
    const md = [
      `# 口味记忆 · 用户 ${userId}`,
      '',
      `> 自动生成，请勿手改。更新时间：${new Date().toLocaleString('sv')}`,
      '',
      '## 收藏画像',
      ...profile.map(l => `- ${l}`),
      '',
      '## 推荐台账',
      ...led.map(l => `- ${l}`),
      '',
      '## 用户调优引导',
      trimmed,
      '',
      '## AI 摘要',
      cleaned,
      '',
    ].join('\n');

    const path = join(MEMORY_DIR, `${userId}.md`);
    try {
      mkdirSync(MEMORY_DIR, { recursive: true });
      writeFileSync(path, md, 'utf8');
    } catch (err) {
      log.warn(`记忆文件写入失败：${(err as Error).message}`);
    }

    return getPersonaDetail(userId);
  })();

  personaInFlight.set(userId, task);
  try {
    return await task;
  } finally {
    personaInFlight.delete(userId);
  }
}

/** 基于最新曲库全量刷新画像 */
export async function refreshPersona(userId: number): Promise<PersonaDetail> {
  const existing = personaInFlight.get(userId);
  if (existing) {
    log.info(`用户 ${userId} 画像重构任务正在执行中，复用当前任务`);
    return existing;
  }

  const task = (async () => {
    await rebuildMemory(userId, { refreshSummary: true });
    return getPersonaDetail(userId);
  })();

  personaInFlight.set(userId, task);
  try {
    return await task;
  } finally {
    personaInFlight.delete(userId);
  }
}

/**
 * 导入并覆盖用户的音乐口味画像（支持跨账号导入，自动清洗并落库）。
 * @param userId 当前需要被覆盖的目标用户 ID
 * @param rawPersonaMd 归档中导出的 persona.md 或纯文本画像
 */
export function importPersonaSummary(userId: number, rawPersonaMd: string): boolean {
  if (!rawPersonaMd || typeof rawPersonaMd !== 'string') return false;

  let text = rawPersonaMd.trim();
  // 1. 兼容性清洗：如果包含了 "# 音乐口味画像 · xxx" 头部或 "> 导出时间"
  // 提取 "## 音乐口味画像" 之后的正文内容
  const sectionMatch = text.match(/##\s*音乐口味画像[\s\S]*?(?=\n##|$)/i);
  if (sectionMatch) {
    text = sectionMatch[0].replace(/^##\s*音乐口味画像\s*/i, '').trim();
  } else {
    // 剔除任何前导的一级/二级标题和引用导出时间行
    text = text
      .replace(/^#\s*音乐口味画像[^\n]*\n*/i, '')
      .replace(/^>\s*导出时间[^\n]*\n*/i, '')
      .replace(/^##\s*[^\n]*\n*/i, '')
      .trim();
  }

  // 剔除暂无画像字样
  if (!text || text === '（暂无音乐口味画像）') {
    return false;
  }

  // 清洗标题中的版本号，规范落款
  text = sanitizePersonaSummary(text);

  // 2. 写入数据库 app_settings 表（核心！前端与 AI 推荐实际读取的是这里）
  setSetting(`ai_memory.summary:${userId}`, text);

  // 3. 同时落盘当前用户的 memory/<userId>.md 文件
  const profile = portrait(userId);
  const led = ledger(userId);
  const guidance = getSetting(`ai_memory.guidance:${userId}`) ?? '';

  const md = [
    `# 音乐口味画像（导入） · 用户 ${userId}`,
    '',
    `> 导入时间：${new Date().toLocaleString('sv')}`,
    '',
    '## 收藏画像',
    ...profile.map(l => `- ${l}`),
    '',
    '## 推荐台账',
    ...led.map(l => `- ${l}`),
    ...(guidance ? ['', '## 用户调优引导', guidance] : []),
    '',
    '## 音乐口味画像',
    text,
    '',
  ].join('\n');

  try {
    mkdirSync(MEMORY_DIR, { recursive: true });
    writeFileSync(join(MEMORY_DIR, `${userId}.md`), md, 'utf8');
  } catch (err) {
    log.warn(`导入写入用户 ${userId} 口味画像文件失败:`, err);
  }

  log.info(`用户 ${userId} 口味画像已成功从导入文件中覆盖写入数据库与文件 (长度: ${text.length})`);
  return true;
}

/**
 * 收藏页 AI 品味洞察评语：
 * 存在 DB app_settings 的 ai.favorites.slogan:<userId>。
 * 0 收藏时不生成；有收藏时异步由 AI 提炼一句 20~35 字第一人称/第二人称精炼审美评语。
 */
export function getFavoritesSummary(userId: number): string | null {
  const row = getDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(`ai.favorites.slogan:${userId}`) as { value: string } | undefined;
  const val = row?.value?.trim();
  if (val) return cleanAiText(val);

  // 若为空且有收藏，后台异步触发生成
  const countRow = getDatabase()
    .prepare('SELECT COUNT(*) as c FROM favorites WHERE user_id = ?')
    .get(userId) as { c: number } | undefined;
  if (countRow && countRow.c > 0) {
    triggerFavoritesSummaryUpdate(userId);
  }
  return null;
}

/**
 * 收藏画像更新防抖。
 *
 * 用户快速连续收藏/取消收藏时（如批量操作），每次操作都会触发 triggerFavoritesSummaryUpdate。
 * 旧实现只有一个布尔锁：第一次触发立刻跑 AI，后续全部丢弃 —— 这意味着 AI 看到的是
 * 操作刚开始时的半成品状态，而最终态反而没人处理。
 *
 * 新实现：**尾部防抖 + 生成锁**。
 * - 每次调用重置倒计时（默认 1 小时），倒计时内没有新的收藏/不喜欢动作才真正触发
 * - 如果刷新正在进行中，不启动新的，但会在当前结束后检查是否有排队的请求
 * - 按 userId 隔离，不同用户互不干扰
 */
/**
 * 画像刷新防抖（**1 小时**）。
 *
 * 为什么这么长（2026-09-21 用户拍板）：原来是 30 秒 —— 用户收藏/取消收藏/点不喜欢
 * 往往是一串连续动作，30 秒内还在动，AI 看到的是半成品，而且会把模型调用打得很密。
 * 现在改成「最后一次操作之后满 1 小时没人再动」才真正刷新，并且：
 *   - 新收藏、取消收藏、**点不喜欢**都会重置这个倒计时（不喜欢也要算「还在操作」）；
 *   - 触发时先补齐曲目标签（打标签走 AI，画像依赖 track_tags 才能算准），再生成评语。
 */
const FAV_DEBOUNCE_MS = 60 * 60 * 1000;
const favDebounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
const favGenerating = new Set<number>();
const favPendingAfterGen = new Set<number>();

export async function generateFavoritesSummary(userId: number): Promise<string | null> {
  const db = getDatabase();
  const countRow = db
    .prepare('SELECT COUNT(*) as c FROM favorites WHERE user_id = ?')
    .get(userId) as { c: number } | undefined;

  if (!countRow || countRow.c === 0) {
    setSetting(`ai.favorites.slogan:${userId}`, '');
    return null;
  }

  const profile = portrait(userId);
  if (!profile.length || profile.every(p => p.includes('（无）') || p.includes('（还没打标）'))) {
    return null;
  }

  const system = `你是专属音乐 DJ。你正在与「你」（听歌用户）进行一对一的私享对话。
请根据这位用户收藏列表的整体音乐品味（常听歌手、曲风分布、语种分布），为他的“我喜欢的音乐”收藏页写一句专属的品味洞察评语。
口吻与结构要求：
1. 绝对第一人称/第二人称交互，只有我和你，严禁出现“他”、“该用户”、“此歌单”、“听众”等第三人称；
2. 拒绝空话套话，写出具体的听感质感与画面感；
3. 硬性结构与标点规范：
   - 必须以一句精炼序言短语开头并紧跟中文逗号「，」，该短语长度严格限制在 3 到 6 个汉字以内（例如“你的世界里，”、“独处时光中，”、“旋律漫游间，”、“私享曲库里，”），作为页面大字主标题；
   - 逗号后面紧接着具体的品味洞察评语，作为下方小字副标题展示，句末必须以句号「。」完整结尾；
4. 全文总字数（含标点）严格控制在 20 ~ 35 个汉字，简短精炼、富有诗意，杜绝长篇大论；
5. 直接输出纯文本，严禁输出任何 Markdown 格式字符（如 #、##、*、** 等），严禁任何格式前缀、书名号或引号，绝对禁止输出任何“User Safety: safe”、安全风控评级或系统前缀标签。`;

  const userPrompt = `用户当前收藏画像数据：\n${profile.join('\n')}\n\n请写一句给“你”的收藏页品味专评（20~35字纯文本，不要任何 Markdown 标记）：`;

  try {
    const text = await aiChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      { purpose: 'decide', maxTokens: 4000, timeoutMs: 600_000, temperature: 0.5 }
    );
    let cleaned = cleanAiText(text);
    // 防御截断与过长：确保不超过 45 字，并在完整标点处收尾
    if (cleaned.length > 45) {
      const lastPunct = Math.max(
        cleaned.lastIndexOf('。', 45),
        cleaned.lastIndexOf('！', 45),
        cleaned.lastIndexOf('；', 45)
      );
      if (lastPunct >= 18) {
        cleaned = cleaned.slice(0, lastPunct + 1);
      } else {
        cleaned = cleaned.slice(0, 40) + '。';
      }
    }
    if (cleaned) {
      setSetting(`ai.favorites.slogan:${userId}`, cleaned);
      log.info(`收藏页 AI 品味评语已生成 (userId: ${userId}): 「${cleaned}」`);
      return cleaned;
    }

  } catch (err) {
    log.debug(`生成收藏页评语跳过/失败: ${(err as Error).message}`);
  }
  return null;
}

export function triggerFavoritesSummaryUpdate(userId: number): void {
  // 清除该用户之前的防抖计时器
  const prev = favDebounceTimers.get(userId);
  if (prev) clearTimeout(prev);

  // 如果该用户的 AI 摘要正在生成中，标记"生成完后需要再跑一次"
  if (favGenerating.has(userId)) {
    favPendingAfterGen.add(userId);
    favDebounceTimers.delete(userId);
    return;
  }

  // 设置尾部防抖：满 1 小时没有新操作才真正触发
  const timer = setTimeout(() => {
    favDebounceTimers.delete(userId);
    runFavSummary(userId);
  }, FAV_DEBOUNCE_MS);

  favDebounceTimers.set(userId, timer);
}

function runFavSummary(userId: number): void {
  if (favGenerating.has(userId)) {
    favPendingAfterGen.add(userId);
    return;
  }
  favGenerating.add(userId);
  // ⚠️ 说清楚刷的是什么：这里刷的是**收藏页评语**（附带补打标签），
  // **不是**音乐口味画像。以前写成「开始刷新画像」，直接把排查方向带偏了。
  log.info(`开始刷新收藏评语（并补打标签） (userId: ${userId})…`);

  // 顺序不能反：画像要统计 track_tags，先把还没打标的曲目补上（这一步会调模型）
  void (async () => {
    await autoTagUntagged(200).catch(err =>
      log.warn(`打标签失败（继续生成评语）：${(err as Error)?.message ?? String(err)}`)
    );
    await generateFavoritesSummary(userId);
  })().finally(() => {
    favGenerating.delete(userId);
    // 生成期间有新的收藏/不喜欢排队了，再跑一轮（同样带防抖）
    if (favPendingAfterGen.has(userId)) {
      favPendingAfterGen.delete(userId);
      log.info(`评语刷新期间有新变动，安排再次更新 (userId: ${userId})`);
      triggerFavoritesSummaryUpdate(userId);
    }
  });
}

