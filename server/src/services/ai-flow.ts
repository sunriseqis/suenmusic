/**
 * 每日歌单整条流程（用户拍板的形态）。
 *
 * ```
 * ① 池子（代码聚合，按已定比例 + 受控标签）
 * ② 两份歌单，各自分批挑：
 *      歌单A = 第1批 15 首 + 第2批 15 首（每批都带理由、都回传 pass）
 *      歌单B = 第3批 15 首 + 第4批 15 首（同上）
 *    —— 分批是为了**避开长输出**（实测一次要 30 首时模型会空手/偷懒）
 * ③ 审核 AI：把 60 首 + 4 份 pass 理由一次性交给它复核
 * ④ 打回的缺几首补几首（同样的分批挑选，只是数量小）
 * ⑤ 写记忆（MD）：结构化由代码写，AI 只写摘要段
 * ⑥ 两份歌单落库（一份入库 = 当日生效，一份备用）
 * ```
 *
 * 为什么这么绕：用户要的是"不用我干预质量"。把质量把关交给审核角色，
 * 把可靠性问题交给分批，把可播性交给"只从池里挑"。
 */
import { getDatabase, transaction } from '../db/index.ts';
import { setSetting } from '../db/repo/settings.ts';
import { upsertTracks } from '../db/repo/tracks.ts';
import type { Track } from '../sources/qq/adapter.ts';
import { buildCandidatePool, maintainLibrary, type Candidate } from './ai-recall.ts';
import { quotasFor, selectFromPool, type ExcludedGroup } from './ai-decide.ts';
import { writeWelcome } from './ai-welcome.ts';
import { todayStr } from '../utils/dates.ts';
import {
  reviewPicks,
  reviewExclusions,
  reviewReasons,
  type ReviewItem,
  type ReasonReviewItem,
  type ReviewOutcome,
  type ExclusionClaim,
} from './ai-review.ts';
import {
  recordAiFailure,
  recordAiSuccess,
  classifyAiFailure,
  type AiFailureKind,
} from './ai-health.ts';
import { readMemorySummary, rebuildMemory } from './ai-memory.ts';
import { RECENT_RAW_LIMIT, maybeRefreshDigest } from './ai-rejection-digest.ts';
import { topArtists } from './artist-stats.ts';
import { consumePlaylists } from './playlist-pool.ts';
import { recordAiRejection } from '../db/repo/ai-rejections.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('ai-flow');

/**
 * 每批多少首。
 *
 * 用户拍板"缩短工作流、快速产出"：原来 15 首/批 ×2 批（每份歌单），4 批下来
 * 上下文越滚越长、越挑越慢。现在**一份歌单一次挑完**（30 首），
 * 挑不满时靠"补足追问"再要一次，而不是切成两批。
 */
/** 缺口来源的中文名（日志与补库任务共用） */
const GAP_LABEL: Record<'simi' | 'playlist' | 'seedOld' | 'chart', string> = {
  simi: '相似歌手',
  playlist: '网友歌单',
  seedOld: '本尊老歌',
  chart: '巅峰榜',
};

const BATCH = 40;
/** 生成几份歌单（用户定：2 份，一份入库一份备用） */
/**
 * 用户拍板改成 **1 份**：实测我们的库**撑不起每天 60 首高质量歌单**，
 * 所以前端也不放刷新按钮（没有"备选上位"这回事）。等扩库上来了再说。
 */
const LISTS = 1;
/** 每日目标首数（用户拍板：合格线 30 首，最大 40 首） */
const DAILY_COUNT = 40;
const DAILY_MAX = 40;
/** 本尊新歌每日硬上限（P0-D）：计入 40 名额，防止 seedNew 挤爆名额 */
const SEED_NEW_DAILY_CAP = 8;
/**
 * 本尊新歌的**兜底**长理由（模型确实没给 seedNew 写 reason_for_review 时才用）。
 *
 * 只用手上真有的元数据（歌名 / 专辑名 / 歌手名 / 风格标签）拼一句听感预期。
 * 刻意**不写**「本尊新歌（必进项）」这类占位语：审核 AI 拿占位语无从精炼，
 * reason_for_display 就为空，前端这 8 首全都没有推荐语（批 1 遗留问题）。
 */
function seedNewFallbackReason(c: Candidate): string {
  const artist = (c.track.ar ?? [])[0]?.name ?? '你常听的歌手';
  const album = c.track.al?.name ?? c.track.album?.name ?? '';
  const traits = [c.styles.join('/'), c.language].filter(Boolean).join('·');
  const head = `${artist} 的新作《${c.track.name}》${album ? `（出自专辑《${album}》）` : ''}`;
  const tail = traits
    ? `，${traits} 的走向和你近来偏爱的质感一脉相承，值得先听后评`
    : '，值得先听后评';
  return head + tail;
}
/**
 * 落地合格线（用户拍板：强制约束合格线在 30 首）。
 *
 * 每份歌单 ≥ LAND_MIN (30 首) 才装填入库，少于 30 首判定"数据不足"不装填。
 *
 * **导出**是给 `daily-recommend.ts` 读当日缓存时用的：那边判定"这份歌单是否够格
 * 展示"必须用同一个阈值。历史上这两处各写一个 30，流程按 A 阈值落地、前端按 B 阈值
 * 拒收，就出现了"明明生成了却一直显示数据不足"。共用常量从根上杜绝再次漂移。
 */
export const LAND_MIN = 30;

export interface FlowList {
  listNo: number;
  picks: Array<{
    trackId: string;
    name: string;
    artist: string;
    reason: string;
    /** 审核精炼后的短句（12-25 字）；rejected 或未精炼时为空，前端不展示推荐语 */
    reason_for_display?: string;
    source: string;
    track?: Track;
  }>;
  /** 跑完各批后剩下的来源名额（补位阶段要继续守，否则会全从最大的池子里拿） */
  remaining?: Bucket;
}

export interface FlowResult {
  greeting: string;
  welcomePhrase?: string;
  lists: FlowList[];
  /** 是否已装填入库（≥ 20 首才装填，用户拍板） */
  landed?: boolean;
  /** 池子不足（不足 20 首时不装填，前端显示"数据不足"） */
  shortfall?: boolean;
  /** 审核打回多少首 */
  rejected: number;
  /** 补了多少首 */
  refilled: number;
  /** 各列表最终首数 */
  counts: number[];
  /**
   * 复核不可用（模型超时/限流/密钥失效……）。
   *
   * 有值就表示**这次没有写 `ai.daily.active`**：旧歌单原样保留，
   * 客户端据 `kind` 给用户一句可上屏的说明。
   */
  reviewFailure?: { kind: AiFailureKind; message: string };
}

type Bucket = Record<'simi' | 'playlist' | 'seedOld' | 'chart', number>;

/** 审核用的"他的收藏"摘要（查重用；不塞全量，60 首代表够了） */
function collectionHintFor(userId: number): string {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT json_extract(t.payload_json, '$.name') AS name,
              json_extract(t.artists_json, '$[0].name') AS artist
         FROM favorites f JOIN tracks t ON t.id = f.track_id
        WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 40`
    )
    .all(userId) as unknown as Array<{ name: string; artist: string }>;
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?')
    .get(userId) as { n: number } | undefined;
  return (
    `（他一共收藏 ${Number(total?.n ?? 0)} 首，以下是最近 40 首）` +
    rows.map(r => `${r.name}-${r.artist}`).join('、')
  );
}

const briefFor = (userId: number): {
  /**
   * 核心审美基调（Anchor Artists）：收藏曲目数 > 10 的歌手。
   *
   * 与 `artists`（收藏排行前 18）分开传，因为**用途不同**：
   *   - `anchorArtists`：选曲侧用它做硬性区分 —— 这一组属于"低频偶遇"，
   *     不能当每日主力（它们收藏量最大，靠权重必然是它们，用户天天跳过）；
   *   - `artists`：整体熟悉度参考，用于判断"次熟悉"档。
   */
  /** 摘要段要按用户读 `ai.rejection_digest:<userId>`，所以 brief 里带上 userId */
  userId: number;
  anchorArtists: string;
  artists: string;
  recent: string;
  /** 最近几条原始打回理由（已剥 `[审核打回]` 标签），只填 prompt 的"最近原始理由"段 */
  rejections: string;
  userActions: string;
  favCount: number;
} => {
  const db = getDatabase();
  const favCount = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?').get(userId) as { n: number } | undefined)?.n ?? 0
  );
  const artists = (
    db
      .prepare(
        `SELECT json_extract(je.value, '$.name') AS artist_name, COUNT(DISTINCT f.track_id) AS n
           FROM favorites f JOIN tracks t ON t.id = f.track_id, json_each(t.artists_json) je
          WHERE f.user_id = ? AND json_extract(je.value, '$.name') != ''
          GROUP BY artist_name ORDER BY n DESC LIMIT 18`
      )
      .all(userId) as unknown as Array<{ artist_name: string; n: number }>
  )
    .map(r => `${r.artist_name}(${r.n})`)
    .join('、');
  const recent = (
    db
      .prepare(
        `SELECT json_extract(t.payload_json, '$.name') AS name,
                json_extract(t.artists_json, '$[0].name') AS artist
           FROM favorites f JOIN tracks t ON t.id = f.track_id
          WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 25`
      )
      .all(userId) as unknown as Array<{ name: string; artist: string }>
  )
    .map(r => `${r.name}-${r.artist}`)
    .join('、');
  // 最近被否掉的（含理由）：让模型每次挑歌前都知道"这些路数已被否、为什么"
  // 只取最近几条 —— 结论性规律交给 ai-rejection-digest 的摘要，这里只留"刚从哪掉下去"
  const rejections = (
    getDatabase()
      .prepare(
        `SELECT name, artist, reason FROM ai_passed
          WHERE user_id = ? AND reason != '' ORDER BY created_at DESC LIMIT ?`
      )
      .all(userId, RECENT_RAW_LIMIT) as unknown as Array<{ name: string; artist: string; reason: string }>
  )
    .map(r => `- ${r.name} - ${r.artist}：${r.reason.replace(/^\[审核打回\]\s*/, '').slice(0, 60)}`)
    .join('\n');
  // 用户前端操作（不喜欢/收藏）：全流权重最高的上下文
  const userActions = (
    getDatabase()
      .prepare(
        `SELECT type, name FROM user_dislikes
          WHERE user_id = ? ORDER BY created_at DESC LIMIT 15`
      )
      .all(userId) as unknown as Array<{ type: string; name: string }>
  )
    .map(d => `${d.name}（${d.type === 'artist' ? '整位歌手' : '单曲'}）`)
    .join('、');
  const buys = (
    getDatabase()
      .prepare(
        `SELECT json_extract(t.payload_json, '$.name') AS name,
                json_extract(t.artists_json, '$[0].name') AS artist
           FROM favorites f JOIN tracks t ON t.id = f.track_id
          WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 20`
      )
      .all(userId) as unknown as Array<{ name: string; artist: string }>
  )
    .map(b => `${b.name}-${b.artist}`)
    .join('、');
  const userActionsText = [
    userActions.length > 0 ? `最近点了"不喜欢"：${userActions}` : '',
    buys.length > 0 ? `最近新收藏：${buys}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  // 核心审美基调：收藏 > 10 首的歌手（口径见 services/artist-stats.ts）
  const anchorArtists = topArtists(userId)
    .map(a => `${a.name}(${a.count})`)
    .join('、');

  return { userId, anchorArtists, artists, recent, rejections, userActions: userActionsText, favCount };
};

/** 从池里按剩余名额跑一批（15 首），并把用掉的 id / 名额返回 */
async function runBatch(
  pool: Candidate[],
  opts: {
    userId: number;
    count: number;
    usedIds: Set<string>;
    remaining: Bucket;
    memory: string;
    /** 上一轮打回理由（补全时喂回去） */
    avoidNotes?: string;
    /** 本次生成里已判"不要"的曲目 id（打回 + pass），补位时一并排除 */
    blocked?: Set<string>;
  }
): Promise<{
  picks: Array<{ track: Candidate['track']; reason: string; source: Candidate['source'] }>;
  shortfall: boolean;
  gaps: Array<{ src: 'simi' | 'playlist' | 'seedOld' | 'chart'; need: number }>;
  usedArtists: string[];
  /** 模型对"剩下这些为什么都不选"的整体归类说明（空数组 = 没给/不需要给） */
  excluded: ExcludedGroup[];
  remaining: Bucket;
}> {
  const usedIds = new Set(opts.usedIds);
  for (const id of opts.blocked ?? []) usedIds.add(id);
  /**
   * 批级重试：单次模型调用偶发超时（实测打死过整条流程）。
   * 失败就**减半重试一次**，两次都不行就交回空批（后面补位会兜）。
   */
  let res: Awaited<ReturnType<typeof selectFromPool>>;
  try {
    res = await selectFromPool(pool, {
      userId: opts.userId,
      count: opts.count,
      usedIds,
      remaining: opts.remaining,
      memory: opts.memory,
      avoidNotes: opts.avoidNotes,
      brief: briefFor(opts.userId),
    });
  } catch (err) {
    const half = Math.max(5, Math.floor(opts.count / 2));
    log.warn(`本批（${opts.count} 首）失败：${(err as Error).message} —— 减半到 ${half} 首重试`);
    res = await selectFromPool(pool, {
      userId: opts.userId,
      count: half,
      usedIds,
      remaining: opts.remaining,
      memory: opts.memory,
      avoidNotes: opts.avoidNotes,
      brief: briefFor(opts.userId),
    }).catch(e => {
      log.warn(`重试仍失败，交回空批：${(e as Error).message}`);
      return {
        picks: [],
        shortfall: true,
        gaps: [],
        usedArtists: [],
        excluded: [],
      };
    });
  }
  // 更新剩余名额
  const consumed: Bucket = { simi: 0, playlist: 0, seedOld: 0, chart: 0 };
  for (const p of res.picks) {
    if (p.source !== 'seedNew') consumed[p.source as keyof Bucket] += 1;
  }
  const remaining: Bucket = {
    simi: Math.max(0, opts.remaining.simi - consumed.simi),
    playlist: Math.max(0, opts.remaining.playlist - consumed.playlist),
    seedOld: Math.max(0, opts.remaining.seedOld - consumed.seedOld),
    chart: Math.max(0, opts.remaining.chart - consumed.chart),
  };
  return { ...res, remaining };
}

/**
 * 把"整体归类说明"转成审核模块要的输入。
 *
 * 归类里只有 id，审核 AI 判不动（它不认识 id），必须补上曲名歌手。
 * 池子里查不到的 id 直接丢掉 —— 模型可能编造池外的 id。
 */
function toClaims(groups: ExcludedGroup[], byId: Map<string, Candidate>): ExclusionClaim[] {
  const claims: ExclusionClaim[] = [];
  for (const g of groups) {
    const tracks = g.ids
      .map(id => byId.get(id))
      .filter((c): c is Candidate => !!c)
      .map(c => ({
        id: c.track.id,
        name: c.track.name,
        artist: (c.track.ar ?? [])[0]?.name ?? '',
      }));
    if (tracks.length > 0) claims.push({ why: g.why, tracks });
  }
  return claims;
}

/** 跑整条流程 */
export async function runDailyFlow(
  userId: number,
  opts: { count?: number } = {}
): Promise<FlowResult> {
  const target = Math.min(DAILY_MAX, opts.count ?? DAILY_COUNT);

  // ⓪ 维护：7 天到点覆盖（推荐历史清理 + 推荐库删除）
  maintainLibrary(userId);

  const memory = readMemorySummary(userId);
  const userActions = briefFor(userId).userActions;

  /** 累计已通过审核的选曲（跨池子累积，这是唯一会进落地的清单） */
  const picks: FlowList['picks'] = [];
  /** 跨池去重：已选中的不许再捞 */
  const usedIds = new Set<string>();
  /** 本次生成里被判"不要"的（审核打回 + 模型否决），补位/重选时一并排除 */
  const blockedThisRun = new Set<string>();

  let greeting = '';
  let welcomePhrase = '';
  let rejectedTotal = 0;
  let refilledTotal = 0;
  let shortfallHit = false;
  let poolRound = 0;
  /** 本轮生成中复核不可用（一旦出现，整次生成不落地） */
  let reviewFailure: { kind: AiFailureKind; message: string } | null = null;

  /**
   * 池子循环（2026-09-20 用户拍板）。
   *
   * ```
   * 池子 → 模型选 → 不够 → 归类说明 → 审核 → 冷却 + 落地 + 换新池子 → 补
   * ```
   *
   * **退出条件全部是产物属性，不设轮次上限**：
   *   ① 已选满 target(40)                      → 成功收工
   *   ② 跑过至少一轮且已选 ≥ LAND_MIN(30)       → 成功收工（用户拍板"目标 40，30 以上就停"）
   *   ③ 建不出池子 / 本轮没有新增通过            → 真·数据不足
   *
   * 「换池子」不需要额外机制：上一轮落地的会进 `recommend_history`（7 天冻结）、
   * 被否决的会进 `ai_rejections`，两者都被 `buildExclusions` 排除，新池子自然换了一批歌。
   */
  while (picks.length < target) {
    if (poolRound >= 1 && picks.length >= LAND_MIN) break;
    poolRound += 1;

    // ① 建池
    const { candidates } = await buildCandidatePool(userId);
    if (candidates.length === 0) {
      log.warn(`第 ${poolRound} 轮候选池为空，停止补选（已选 ${picks.length} 首）`);
      break;
    }

    const poolAvailable: Bucket = { simi: 0, playlist: 0, seedOld: 0, chart: 0 };
    for (const c of candidates) {
      if (c.source in poolAvailable) poolAvailable[c.source as keyof Bucket] += 1;
    }
    const byId = new Map(candidates.map(c => [c.track.id, c]));

    const gap = target - picks.length;

    /**
     * 本尊新歌：必进但**每日硬上限 8 首并计入 40 名额**（P0-D）。
     * 原来"无条件全进不占名额"—— 实测 uid=1 seedNew 占 30%、极端 10 种子 × 8 专辑歌 = 80 首必进，
     * 直接挤爆 40 名额、来源多样性崩塌。超上限的不丢：留给下一轮/明天（usedIds 不含它们）。
     */
    const seedNewAll = candidates.filter(c => c.source === 'seedNew' && !usedIds.has(c.track.id));
    const seedNew = seedNewAll.slice(0, SEED_NEW_DAILY_CAP);
    /**
     * 超每日上限的本尊新歌：不递模型（模型只会为它们白写理由，回来也要被丢掉）。
     * 放进 usedIds 当"本轮不可见"，下一轮/明天自然还能捞到。
     */
    const seedNewOverflowIds = seedNewAll.slice(SEED_NEW_DAILY_CAP).map(c => c.track.id);
    /**
     * 模型选的。**现在会包含本尊新歌** —— 它的理由（reason_for_review）必须由模型写：
     * 以前把 seedNew 挡在池外，模型没机会为它们写听感，只能塞占位语，审核无从精炼。
     */
    let modelPicks: Array<{ track: Track; reason: string; source: Candidate['source'] }> = [];
    /** 模型选的**占名额**的那些（不含 seedNew —— 本尊新歌不占名额） */
    const modelNormalCount = () => modelPicks.filter(p => p.source !== 'seedNew').length;
    const wantFromModel = Math.max(0, gap - seedNew.length);

    if (wantFromModel > 0) {
      // ② 模型选
      const res = await runBatch(candidates, {
        userId,
        count: wantFromModel,
        // seedNew 不再塞进 usedIds：要让模型看见它们，才能为它们写 reason_for_review
        usedIds: new Set([...usedIds, ...seedNewOverflowIds]),
        remaining: quotasFor(wantFromModel, poolAvailable),
        memory,
        blocked: blockedThisRun,
      });
      modelPicks = res.picks;
      let excluded = res.excluded;

      /**
       * ③ 归类说明 → 送审核。
       *
       *   成立   → 写进 AI 黑名单（**全代码唯一写入点**），本批池子作废，下一轮换池
       *   不成立 → 带审核意见从**同一批池子**重选；选中数不再增长就停
       *
       * 这一步是"模型说池子没货了"这句话的唯一闸门 —— 没有它，模型能单方面
       * 把用户的候选池掏空（说一句"都不合适"就能拉黑一批歌）。
       */
      if (excluded.length > 0 && modelNormalCount() < wantFromModel) {
        let prevCount = modelNormalCount();
        while (excluded.length > 0 && modelNormalCount() < wantFromModel) {
          const claims = toClaims(excluded, byId);
          if (claims.length === 0) break;

          const verdict = await reviewExclusions(claims, { memory, userActions });

          if (verdict.approved) {
            const claimed = claims.flatMap(c => c.tracks);
            const n = recordAiRejection(
              userId,
              claimed.map(t => ({ id: t.id, name: t.name, artist: t.artist })),
              verdict.note || claims.map(c => c.why).join('；')
            );
            for (const t of claimed) blockedThisRun.add(t.id);
            log.info(
              `归类理由成立 → ${n} 首进入 AI 黑名单（冷却 15/30 天 → 永久）· 本批池子作废，下一轮换池`
            );
            break;
          }

          // 不成立：带着审核意见从同一批池子重选
          log.info(`归类理由不成立（${verdict.note || '未说明'}）→ 从同一批池子重选`);
          const retry = await runBatch(candidates, {
            userId,
            count: wantFromModel - modelNormalCount(),
            usedIds: new Set([
              ...usedIds,
              ...seedNewOverflowIds,
              ...modelPicks.map(p => p.track.id),
            ]),
            remaining: quotasFor(wantFromModel, poolAvailable),
            memory,
            avoidNotes: verdict.note,
            blocked: blockedThisRun,
          });
          if (retry.picks.length === 0) {
            log.warn('重选没有产出，停止重选（改由下一轮换池补）');
            break;
          }
          modelPicks = [...modelPicks, ...retry.picks];
          excluded = retry.excluded;
          if (modelNormalCount() <= prevCount) {
            log.warn('重选后选中数没有增长，停止重选（改由下一轮换池补）');
            break;
          }
          prevCount = modelNormalCount();
        }
      }
    }

    /**
     * 模型为本尊新歌写的长理由（reason_for_review），按 id 索引。
     * 本尊新歌仍是**代码强制必进**（模型漏写也不影响进单），但理由取模型写的真听感；
     * 模型确实没写的才退回基于歌名/专辑/歌手/标签的兜底句 —— 绝不写「本尊新歌（必进项）」
     * 那种占位语（占位语审核无从精炼 → reason_for_display 为空 → 前端没推荐语）。
     */
    const seedNewReasonById = new Map(
      modelPicks.filter(p => p.source === 'seedNew').map(p => [p.track.id, p.reason])
    );
    const roundPicks: Array<{ track: Track; reason: string; source: Candidate['source'] }> = [
      ...seedNew.map(c => ({
        track: c.track,
        reason: seedNewReasonById.get(c.track.id) || seedNewFallbackReason(c),
        source: c.source,
      })),
      // 模型选的本尊新歌已按上面的强制清单收口（去重），这里只补普通来源
      ...modelPicks.filter(p => p.source !== 'seedNew'),
    ];
    if (roundPicks.length === 0) {
      log.warn(`第 ${poolRound} 轮一首都没选出来，停止补选（已选 ${picks.length} 首）`);
      break;
    }

    // ④ 审核本轮新增。**只审新增** —— 已通过的不再复审，省 token 也省时间
    const passHistory = (
      getDatabase()
        .prepare(
          `SELECT name, artist, reason FROM ai_passed
            WHERE user_id = ? AND reason != '' ORDER BY created_at DESC LIMIT 20`
        )
        .all(userId) as unknown as Array<{ name: string; artist: string; reason: string }>
    ).map(r => `- ${r.name} - ${r.artist}：${r.reason.slice(0, 70)}`);

    const freshItems: ReviewItem[] = roundPicks.map(p => ({
      id: p.track.id,
      name: p.track.name,
      artist: (p.track.ar ?? [])[0]?.name ?? '',
      source: p.source,
      listNo: 1,
      reason: p.reason,
    }));
    let review: ReviewOutcome;
    try {
      review = await reviewPicks(freshItems, { lines: passHistory }, {
        collectionHint: collectionHintFor(userId),
        memory,
        userActions,
      });
    } catch (err) {
      // reviewPicks 内部已把失败收成三态；这里只兜"未预期异常"，且**绝不放行**
      const f = classifyAiFailure(err);
      review = { status: 'unavailable', reason: f.kind, message: f.message };
    }

    if (review.status === 'unavailable') {
      /**
       * 复核不可用 = 这批歌没拿到"通过"结论，不能当"全部通过"落地。
       * 用户拍板的动作：记下失败原因、停止本轮生成、**保留旧歌单**（见 ⑥.5）。
       */
      reviewFailure = { kind: review.reason, message: review.message };
      recordAiFailure(review.reason, review.message);
      log.warn(
        `复核不可用（${review.reason}）：${review.message} → 停止生成，本次不覆盖旧歌单`
      );
      break;
    }
    recordAiSuccess();

    if (review.rejects.size > 0) {
      /**
       * 打回结果**跨轮持久化**（用户明确要求）：只用于本轮补位是不够的 ——
       * 下次生成时模型得知道"这首被打回过、为什么"，否则每天都会重踩同一个坑。
       */
      const insRejected = getDatabase().prepare(
        `INSERT OR IGNORE INTO ai_passed (user_id, track_id, name, artist, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const [id, why] of review.rejects) {
        const item = freshItems.find(i => i.id === id);
        if (!item) continue;
        insRejected.run(userId, id, item.name, item.artist, `[审核打回] ${why}`, Date.now());
        blockedThisRun.add(id);
        log.info(`打回：《${item.name}》—— ${why}`);
      }
      rejectedTotal += review.rejects.size;
    }

    // ⑤ 收下本轮通过审核的
    const before = picks.length;
    for (const p of roundPicks) {
      if (review.rejects.has(p.track.id)) continue;
      if (usedIds.has(p.track.id)) continue;
      usedIds.add(p.track.id);
      picks.push({
        trackId: p.track.id,
        name: p.track.name,
        artist: (p.track.ar ?? [])[0]?.name ?? '',
        reason: p.reason,
        source: p.source,
        track: p.track,
      });
    }
    const added = picks.length - before;
    refilledTotal += added;
    if (modelNormalCount() < wantFromModel) shortfallHit = true;

    log.info(
      `第 ${poolRound} 轮完成：选出 ${roundPicks.length} 首 · 打回 ${review.rejects.size} 首 · ` +
        `累计通过 ${picks.length}/${target} 首（合格线 ${LAND_MIN}）`
    );

    // 产物属性退出：这一轮没有任何新增 → 再换池子也是空转
    if (added === 0) {
      log.warn(`第 ${poolRound} 轮没有新增通过审核的曲目，停止补选`);
      break;
    }
  }

  // ⑤.4 打回理由摘要（压缩上下文）：放在循环之后，本轮的打回记录已经落库（上面 ④ 写 ai_passed）。
  // 内部按阈值判断 —— 新增 < ${NEW_REJECTIONS_THRESHOLD} 条且距上次不足 7 天就什么都不做；
  // 它永不抛异常，失败只 warn 并保留旧摘要，不会影响今天的歌单。
  await maybeRefreshDigest(userId);

  /**
   * ⑤.5 复核失败 → **不写 `ai.daily.active`**（用户拍板：别用一批没审过的歌覆盖旧歌单）。
   *
   * 放在落地判定之前：失败态比"数据不足"更能说明问题，绝不能让下游把它当成
   * "曲库不足、明天再来"。也已经记录到 ai.health（管理端与每日接口都读它）。
   */
  if (reviewFailure) {
    log.warn(
      `本次生成复核不可用（${reviewFailure.kind}）：${reviewFailure.message} → ` +
        `保留旧歌单，已选 ${picks.length} 首不落地`
    );
    return {
      greeting: '',
      welcomePhrase: '',
      lists: [{ listNo: 1, picks }],
      rejected: rejectedTotal,
      refilled: refilledTotal,
      counts: [picks.length],
      landed: false,
      shortfall: false,
      reviewFailure,
    };
  }

  // ⑥ 落地判定：累计 ≥ LAND_MIN 才装填（用户拍板）
  if (picks.length < LAND_MIN) {
    log.warn(
      `数据不足：全部池子跑完只选出 ${picks.length} 首（合格线 ${LAND_MIN} 首，上限 ${DAILY_MAX} 首）` +
        `→ 不装填。池子轮次 ${poolRound}`
    );
    // 不装填就不写文案：省一次模型调用（反正这批产物不落库）
    return {
      greeting: '',
      welcomePhrase: '',
      lists: [{ listNo: 1, picks }],
      rejected: rejectedTotal,
      refilled: refilledTotal,
      counts: [picks.length],
      landed: false,
      shortfall: true,
    };
  }

  // ⑦ 开屏文案（**独立回合**，2026-09-21 用户拍板）
  //
  // 问候语/欢迎短语不再塞进选曲那次调用：选曲 prompt 通篇是名额与规则，
  // 模型在那种上下文里会把欢迎词写成策展口吻（线上实测「继续以周杰伦为主」
  // 「老规矩情歌为主」）。这里单开一次**只写文案**的调用，没有可混淆的上下文。
  // 失败一律返回空串 → 回落时段问候，绝不因为它挂掉而让整条选曲流程失败。
  const copy = await writeWelcome({ memory, brief: briefFor(userId) });
  greeting = copy.greeting;
  welcomePhrase = copy.welcomePhrase;

  // ⑧ 落库
  const date = todayStr();
  const ts = Date.now();
  const batchId = `flow_${ts.toString(36)}`;
  const finalPicks = picks.slice(0, DAILY_MAX);
  /**
   * ⑦.5 第二轮理由审核 + 精炼（用户 2026-10-29 新流程）：
   * 选歌 AI 写长理由（reason_for_review）→ 审核判断 approved/rejected + 精炼成 12-25 字短句
   * （reason_for_display）。approved 才落前端；rejected 丢掉推荐语（歌还在，只是没推荐语）。
   * 失败不阻塞落地（理由精炼是增值，不是准入闸门），只是没展示短句。
   */
  const displayBy = await reviewReasons(
    finalPicks.map(p => ({
      id: p.trackId,
      name: p.name,
      artist: p.artist,
      reasonForReview: p.reason,
    }))
  );
  for (const p of finalPicks) {
    const v = displayBy.get(p.trackId);
    p.reason_for_display = v && v.verdict === 'approved' ? v.reasonForDisplay : '';
  }
  // 快照：把**完整 Track** 跟着 payload 一起存（而不是只存 id）。
  //
  // 为什么：读取路径此前只拿到 id，要 `getTracks()` 回查，查不到就串行打 QQ 补 —— 
  // 既慢、又污染上游，且 tracks 被清理后歌单会退化成「只有 id」。存快照后读取零上游，
  // 且歌单自带元数据（元数据不再依赖 tracks 表的存活）。45 首约 80–120KB，settings 存 TEXT 够。
  const payload = JSON.stringify({
    date,
    greeting,
    welcomePhrase,
    generatedAt: ts,
    picks: finalPicks.map(p => ({
      trackId: p.trackId,
      name: p.name,
      artist: p.artist,
      reason: p.reason,
      reason_for_display: p.reason_for_display || '',
      source: p.source,
    })),
    // 快照顺序与 picks 一致；缺失曲目（模型编造/解析失败）对应位置为空，读取时跳过
    snapshot: finalPicks.map(p => p.track ?? null),
  });

  const fullTracks = finalPicks.map(p => p.track).filter((t): t is Track => !!t);
  if (fullTracks.length > 0) {
    upsertTracks(fullTracks);
    log.info(`已将 ${fullTracks.length} 首曲目写入 tracks 表缓存`);
  }

  const db = getDatabase();
  const insHistory = db.prepare(
    `INSERT INTO recommend_history (user_id, batch_id, source, track_id, name, artist, resolved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  );
  transaction(() => {
    for (const p of finalPicks) {
      insHistory.run(userId, batchId, p.source || 'ai', p.trackId, p.name, p.artist, ts);
    }
  });
  log.info(`已将 ${finalPicks.length} 首曲目写入推荐历史（进入 7 天冷却冷冻名单）`);

  // 闭环网友歌单池：将所选曲目所在的网友歌单标记为已消耗
  const pickIds = finalPicks.map(p => p.trackId).filter(Boolean);
  if (pickIds.length > 0) {
    try {
      const ph = pickIds.map(() => '?').join(',');
      const usedRows = db
        .prepare(`SELECT DISTINCT dissid FROM playlist_pool_items WHERE track_id IN (${ph})`)
        .all(...pickIds) as Array<{ dissid: string }>;
      const usedDissids = usedRows.map(r => r.dissid).filter(Boolean);
      if (usedDissids.length > 0) {
        consumePlaylists(usedDissids);
        log.info(`已将命中的 ${usedDissids.length} 个网友歌单标记为已消耗`);
      }
    } catch (e) {
      log.warn(`网友歌单消耗标记异常：${(e as Error).message}`);
    }
  }

  setSetting(`ai.daily.active:${userId}`, payload);

  // ⑨ 后台异步写记忆（带上最新推荐历史，非阻塞，让每日推荐立刻就绪）
  void rebuildMemory(userId, { refreshSummary: true }).catch(err => {
    log.warn(`后台记忆更新失败：${(err as Error).message}`);
  });

  log.info(
    `整条流程完成：${finalPicks.length} 首 · 池子轮次 ${poolRound} · 打回 ${rejectedTotal} · ` +
      `问候语「${greeting}」 · 欢迎短语「${welcomePhrase}」`
  );

  return {
    greeting,
    welcomePhrase,
    lists: [{ listNo: 1, picks: finalPicks }],
    rejected: rejectedTotal,
    refilled: refilledTotal,
    counts: [finalPicks.length],
    landed: true,
    shortfall: shortfallHit,
  };
}
