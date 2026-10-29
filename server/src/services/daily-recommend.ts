/**
 * 每日推荐服务。
 *
 * 核心设计（用户拍板）：
 * 1. **定时生成**：每天 00:30（业务本地时间）统一跑一次，不再懒加载 ——
 *    执行前判断「上一份歌单有没有被操作过」（播放过其中任意一首 / 对其中某首歌或歌手点过不喜欢）：
 *    有则重新生成，没有则把原歌单顺延到今天继续用，**不浪费 AI**；
 * 2. 每日一份：全天固定，自然缩水（不喜欢时剔除，不补位不硬凑，保证听感平稳）；
 * 3. 推荐理由彩蛋：列表极简无标签、不展示理由；推荐理由挂在曲目对象上，仅在正在播放详情页优雅露出；
 * 4. 专属欢迎短语：由 AI 生成，供首页开屏展示。
 *
 * 例外：**首次**（该用户还没有任何可用歌单）仍允许懒触发一次，
 * 否则新用户要空等到第二天 00:30 才有歌单。
 */

import { createLogger } from '../logger.ts';
import { deleteSetting, getSetting, setSetting } from '../db/repo/settings.ts';
import { getDatabase } from '../db/index.ts';
import { getTracks, upsertTracks } from '../db/repo/tracks.ts';
import { getSongDetail } from '../sources/qq/home.ts';
import { getDislikeSets } from '../db/repo/library.ts';
import { runDailyFlow, LAND_MIN } from './ai-flow.ts';
import {
  readAiHealth,
  recordAiFailure,
  classifyAiFailure,
  type AiFailureKind,
} from './ai-health.ts';
import { isJunk } from './ai-recall.ts';
import { clampDisplay } from '../utils/reason-text.ts';
import { isCoverOrInstrumental } from './content-filter.ts';
import { getActiveUserIds } from './library-topup.ts';
import { cleanAiText } from '../utils/text.ts';
import { todayStr } from '../utils/dates.ts';
import type { Track } from '../sources/qq/adapter.ts';

const log = createLogger('daily-recommend');

export const dailyActiveKey = (userId: number): string => `ai.daily.active:${userId}`;
export const dailyBackupKey = (userId: number): string => `ai.daily.backup:${userId}`;

/**
 * 获取指定用户的当日生效推荐配置。
 *
 * 兼容平滑迁移：
 * 历史版本中单用户 (userId 1) 存在写在未带前缀的全局键 'ai.daily.active' 中的情况。
 * 若当前请求为 userId 1，且发现 legacy 键存在，自动迁移至新键并清理 legacy 键。
 * 非 userId 1 的其他账号绝不回退至 legacy 键，彻底杜绝数据串号。
 */
export function getDailyActiveSetting(userId: number): string | null {
  const userKey = dailyActiveKey(userId);
  const val = getSetting(userKey);
  if (val) return val;

  if (userId === 1) {
    const legacy = getSetting('ai.daily.active');
    if (legacy) {
      setSetting(userKey, legacy);
      deleteSetting('ai.daily.active');

      const legacyBackup = getSetting('ai.daily.backup');
      if (legacyBackup) {
        setSetting(dailyBackupKey(1), legacyBackup);
        deleteSetting('ai.daily.backup');
      }
      return legacy;
    }
  }

  return null;
}

interface UserDailyStatus {
  isGenerating: boolean;
  lastStatus: 'shortfall' | 'error' | null;
  lastError: string | null;
  /** 最近一次失败的分类（给每日接口的 statusDetail.code 用） */
  lastFailureKind?: AiFailureKind;
}

/** 读出当前生效的歌单载荷（不触发生成）；损坏或没有返回 null */
function readPayload(userId: number): DailyPayload | null {
  const raw = getDailyActiveSetting(userId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DailyPayload;
  } catch {
    return null;
  }
}

/** 该用户是否已经有一份可用歌单（够装填线） */
export function hasUsableDaily(userId: number): boolean {
  const p = readPayload(userId);
  return !!p && Array.isArray(p.picks) && p.picks.length >= LAND_MIN;
}

/** 读首页要用的开屏短语（只读，不触发生成） */
export function readDailyWelcomePhrase(userId: number): string {
  const p = readPayload(userId);
  if (!p || !Array.isArray(p.picks) || p.picks.length < LAND_MIN) return '';
  return cleanAiText(p.welcomePhrase) || '';
}

/**
 * 只在「还没有可用歌单」时补一次首次生成。
 *
 * 定时模型下这是**唯一保留的懒触发口**：不这么做，新用户要空等到第二天 00:30。
 * 首页与每日页都调它，重复调用由 `triggerDailyFlow` 内部的 isGenerating 去重。
 */
export function bootstrapDailyIfEmpty(userId: number): void {
  if (!hasUsableDaily(userId)) void triggerDailyFlow(userId);
}

const userStatuses = new Map<number, UserDailyStatus>();

/** 旧 payload 的自动重建时间戳（按用户）。6 小时内不重复触发，避免读取路径放大 AI 成本。 */
const staleRegenAt = new Map<number, number>();

/**
 * 读取期发现 payload 里有当前规则不合格的曲目 → 后台重建一次。
 *
 * 不再单独埋点统计：过滤的唯一闸门是**选池阶段**（AI 之前），读取期只是历史数据兜底；
 * 兜底一旦发生，正确动作是重建，而不是记一笔日志让人去翻。
 */
function scheduleStaleRegenerate(userId: number, dropped: number): void {
  const last = staleRegenAt.get(userId) ?? 0;
  if (Date.now() - last < 6 * 60 * 60 * 1000) return;
  staleRegenAt.set(userId, Date.now());
  log.warn(`歌单有 ${dropped} 首在现行规则下不合格（历史 payload）→ 触发一次后台重建`);
  void triggerDailyFlow(userId);
}

function getUserStatus(userId: number): UserDailyStatus {
  let s = userStatuses.get(userId);
  if (!s) {
    s = { isGenerating: false, lastStatus: null, lastError: null };
    userStatuses.set(userId, s);
  }
  return s;
}

/**
 * 每日推荐返回（**已定契约**，客户端照此展示）。
 *
 * - `ready`：有可用 payload（`picks.length >= LAND_MIN`）；
 * - `failed`：没有可用 payload，且最近一次生成失败 / 复核不可用 ——
 *   必须带 `statusMessage`（可直接上屏的中文）与 `statusDetail.code`；
 * - `generating`：**契约之外保留的过渡态**。契约只定义了 ready/failed 两种终态，
 *   但"首次使用、还没失败过、正在生成"既不是 ready 也不该说成 failed
 *   （否则新用户一打开就看到"生成失败，请确认模型状态"）。
 */
export interface DailyRecommendResponse {
  status: 'ready' | 'failed' | 'generating';
  /** 可直接上屏的中文提示（failed 时必给） */
  statusMessage?: string;
  statusDetail?: { code?: AiFailureKind | 'shortfall' | 'error' };
  date: string;
  tracks: Track[];
  welcomePhrase?: string;
  greeting?: string;
  /** @deprecated 旧客户端读这个字段，值等同 statusMessage；新客户端请用 statusMessage */
  message?: string;
  generated?: boolean;
}

/** 复核/生成失败的统一上屏文案（契约固定） */
const DAILY_FAILED_MESSAGE = '今天的歌单生成失败，请登录服务端确认模型状态';
/** 曲库不足不是模型故障，给的是可执行的建议（仍属 failed） */
const DAILY_SHORTFALL_MESSAGE = '曲库积累不足，先去收藏几首歌，明天再来为你定制专属歌单';
const DAILY_GENERATING_MESSAGE = '正在为你挑选今日专属歌单…';

function failedResponse(
  date: string,
  code: AiFailureKind | 'shortfall' | 'error'
): DailyRecommendResponse {
  const statusMessage = code === 'shortfall' ? DAILY_SHORTFALL_MESSAGE : DAILY_FAILED_MESSAGE;
  return {
    status: 'failed',
    statusMessage,
    statusDetail: { code },
    date,
    tracks: [],
    message: statusMessage,
  };
}

/** 触发后台异步生成流程（如果该用户已在生成中则忽略） */
export async function triggerDailyFlow(userId: number): Promise<void> {
  const status = getUserStatus(userId);
  if (status.isGenerating) return;
  status.isGenerating = true;
  status.lastStatus = null;
  status.lastError = null;

  (async () => {
    try {
      log.info(`开始后台异步生成每日专属推荐 (userId: ${userId})...`);
      const res = await runDailyFlow(userId);
      if (res.reviewFailure) {
        // 复核不可用：旧歌单原样保留。失败台账已在 ai-flow 里记过，这里不重复计数
        status.lastStatus = 'error';
        status.lastFailureKind = res.reviewFailure.kind;
        status.lastError = res.reviewFailure.message;
        log.warn(
          `每日推荐复核不可用，保留旧歌单 (userId: ${userId}, ${res.reviewFailure.kind})`
        );
      } else if (res.shortfall && !res.landed) {
        status.lastStatus = 'shortfall';
        status.lastFailureKind = undefined;
        status.lastError = null;
        log.warn(`每日推荐生成结果为曲库不足 (shortfall, userId: ${userId})`);
      } else {
        status.lastStatus = null;
        status.lastFailureKind = undefined;
        status.lastError = null;
        log.info(`每日推荐生成完成 (userId: ${userId})，歌单 A 共 ${res.counts[0] ?? 0} 首，已装填入库`);
      }
    } catch (err) {
      const failure = classifyAiFailure(err);
      status.lastStatus = 'error';
      status.lastFailureKind = failure.kind;
      status.lastError = failure.message;
      recordAiFailure(failure.kind, failure.message);
      log.error(`每日推荐后台生成失败 (userId: ${userId}, ${failure.kind}): ${failure.message}`);
    } finally {
      status.isGenerating = false;
    }
  })();
}

/**
 * 获取当前用户的每日推荐。
 *
 * 只读：**不再懒加载生成**。歌单由每天 00:30 的定时维护产出（`runDailyMaintenance`），
 * 这里按「已有可用歌单就装配返回、没有才补一次首次生成」处理。
 * 于是「重试」「换一批」这类手动重建口子全部关闭。
 */
export async function getDailyRecommend(userId: number): Promise<DailyRecommendResponse> {
  const today = todayStr();

  const activeRaw = getDailyActiveSetting(userId);
  if (activeRaw) {
    try {
      // 直接复用 DailyPayload：本地各写一份内联类型正是「字段加了但读取看不见」的老毛病来源
      const parsed = JSON.parse(activeRaw) as DailyPayload;

      // 只要有一份**可用**歌单就服务它 —— 不再要求「日期等于今天」：
      // 定时维护会把没被操作过的歌单顺延到今天，而万一定时被错过（服务器没开机），
      // 也不该在读取路径上偷偷重新生成（那正是要关掉的懒加载）。
      if (Array.isArray(parsed.picks) && parsed.picks.length >= LAND_MIN) {
        const ids = parsed.picks.map(p => p.trackId);
        // 优先用 payload 里的**完整快照**：读取零上游、也不依赖 tracks 表还活着。
        // 老 payload（没有 snapshot）才回退到 getTracks + library_tracks + QQ 补。
        let tracks: Track[] = Array.isArray(parsed.snapshot)
          ? parsed.snapshot.filter((t): t is Track => !!t && !!t.id)
          : [];
        if (tracks.length === 0) tracks = getTracks(ids);

        // 如果 tracks 缓存表有缺失，自动补齐
        if (tracks.length < ids.length) {
          const foundIds = new Set(tracks.map(t => t.id));
          const missing = ids.filter(id => !foundIds.has(id));

          // 1. 从 library_tracks 查
          const db = getDatabase();
          const libRows = db
            .prepare(
              `SELECT id, payload_json FROM library_tracks WHERE id IN (${missing.map(() => '?').join(',')})`
            )
            .all(...missing) as unknown as Array<{ id: string; payload_json: string }>;
          const fromLib: Track[] = [];
          for (const row of libRows) {
            try {
              const t = JSON.parse(row.payload_json);
              if (t && t.id) fromLib.push(t);
            } catch {
              /* ignore */
            }
          }
          if (fromLib.length > 0) upsertTracks(fromLib);

          // 2. 剩余仍缺失的从 QQ 补
          const libFoundIds = new Set(fromLib.map(t => t.id));
          const stillMissing = missing.filter(id => !libFoundIds.has(id));
          for (const mid of stillMissing) {
            try {
              const songMid = mid.replace(/^qq_/, '');
              const t = await getSongDetail(songMid);
              if (t) upsertTracks([t]);
            } catch {
              /* ignore */
            }
          }

          tracks = getTracks(ids);
        }

        // 黑名单与非歌曲垃圾过滤（自然缩水，不喜欢/非歌曲不重排不硬凑，杜绝短音频与吟唱）
        // 翻奏 / 钢琴 / 纯音乐同样在这里兜一层：历史歌单（以及本轮改动之前生成的
        // payload）里可能已经存着这类曲目，读取路径直接不返回它们，不必等下一轮生成。
        const dislikes = getDislikeSets(userId);
        const filteredTracks = tracks.filter(
          t =>
            !dislikes.trackIds.has(t.id) &&
            !(t.ar ?? []).some(a => dislikes.artistMids.has(a.mid ?? '')) &&
            !isJunk(t) &&
            !isCoverOrInstrumental(t)
        );

        // 挂载推荐理由（自动清洗 Markdown 符号）。
        // **前端只展示审核精炼后的短句（reason_for_display）**：approved 才有值，rejected 为空 →
        // 前端拿到 undefined 就不展示推荐语（歌还在，只是没推荐语），长理由 reason_for_review 不给前端。
        // 读取期剔除 = 这份 payload 是旧规则生成的（现在选池阶段就能拦下，AI 根本看不到它们）。
        // 不做埋点，直接判过期并在后台重建一次；否则旧 payload 会一直「少几首」且永远没人修。
        if (filteredTracks.length < tracks.length) {
          scheduleStaleRegenerate(userId, tracks.length - filteredTracks.length);
        }

        // 读取路径**重放 clampDisplay**（P0-A 兜底）：任何历史路径漏 clamp 的 reason_for_display
        // 在这里统一收到 12-25 字口径；不合格（空/太短）直接不展示推荐语（歌还在）。
        //
        // ⚠️ 兼容存量歌单（2026-10-29 实测发现）：`reason_for_display` 是审核精炼流程新增的字段，
        // 该流程上线**之前**生成的歌单只有旧字段 `reason`（选歌 AI 的长理由，未过审核）。
        // 若只读新字段，存量用户下次生成前会**整份歌单没有推荐语**。
        // 所以这里按「新字段优先、旧字段兜底」读，两者都过同一道 clampDisplay。
        // 注意：旧 `reason` 未经审核筛选，属于「审核没工作」而非「审核否决」，
        // 因此兜底展示它符合「只救审核没工作」的口径（与 finalizeReasonVerdicts 一致）。
        const reasonMap = new Map(
          parsed.picks.map(p => [
            p.trackId,
            clampDisplay(cleanAiText(p.reason_for_display || p.reason || '')),
          ])
        );
        const tracksWithReason = filteredTracks.map(t => ({
          ...t,
          recommendReason: reasonMap.get(t.id) || undefined,
        }));

        return {
          status: 'ready',
          date: parsed.date,
          welcomePhrase: cleanAiText(parsed.welcomePhrase) || '',
          greeting: cleanAiText(parsed.greeting) || '',
          tracks: tracksWithReason,
          generated: false,
        };
      }
    } catch {
      // 缓存损坏则进入重新生成逻辑
    }
  }

  const userStatus = getUserStatus(userId);

  // 当日未就绪：检查当前用户生成状态
  if (userStatus.isGenerating) {
    return {
      status: 'generating',
      date: today,
      tracks: [],
      message: DAILY_GENERATING_MESSAGE,
    };
  }

  if (userStatus.lastStatus === 'shortfall') {
    return failedResponse(today, 'shortfall');
  }

  /**
   * 没有可用 payload 且最近一次生成失败 / 复核不可用 → `failed`。
   *
   * 「最近一次失败」有两个来源：
   *   ① 本进程内的生成状态（启动后跑过的那几次）；
   *   ② 持久化的 `ai.health`（重启后仍能告诉用户"歌单为什么没生成"）。
   * 两者都没有才算"从没尝试过"，才走下面的懒触发。
   */
  const health = readAiHealth();
  const healthKind = health.consecutiveFailures > 0 ? health.lastFailure?.kind : undefined;
  const failureKind = userStatus.lastFailureKind ?? healthKind;
  if (userStatus.lastStatus === 'error' || failureKind) {
    return failedResponse(today, failureKind ?? 'error');
  }

  // 走到这里 = 既没有可用歌单，也没有失败记录（首次使用，或缓存损坏）。
  // 这是**唯一**保留的懒触发：否则新用户要空等到第二天 00:30。
  void triggerDailyFlow(userId);

  return {
    status: 'generating',
    date: today,
    tracks: [],
    message: DAILY_GENERATING_MESSAGE,
  };
}

interface DailyPayload {
  date: string;
  generatedAt?: number;
  greeting?: string;
  welcomePhrase?: string;
  picks: Array<{
    trackId: string;
    name?: string;
    artist?: string;
    /** 选歌 AI 的长听感（reason_for_review，给审核看）—— 不直接给前端 */
    reason?: string;
    /** 审核精炼后的短句（reason_for_display，12-25 字，approved 才有）—— 前端展示 */
    reason_for_display?: string;
    source?: string;
  }>;
  /** 生成时的完整曲目快照（与 picks 同序）。老数据没有 → 读取回退到库/上游 */
  snapshot?: Array<Track | null>;
}

/**
 * 这份歌单**自生成以来**有没有被操作过。
 *
 * 判据（用户拍板）：播放过列表里任意一首，或对列表里的某首歌 / 某位歌手点过不喜欢。
 * 起点用 `payload.generatedAt` —— 顺延时不改它，于是「顺延期间发生的操作」同样算数。
 * 老数据没有 `generatedAt` 时退化为 `since = 0`（任何历史操作都算），代价是首次会多生成一回，可接受。
 */
function wasTouchedSince(userId: number, payload: DailyPayload): boolean {
  const ids = payload.picks.map(p => p.trackId).filter(Boolean);
  if (ids.length === 0) return false;
  const since = Number(payload.generatedAt) || 0;
  const db = getDatabase();
  const holes = ids.map(() => '?').join(',');

  const played = db
    .prepare(
      `SELECT 1 FROM play_history WHERE user_id = ? AND played_at > ? AND track_id IN (${holes}) LIMIT 1`
    )
    .get(userId, since, ...ids);
  if (played) return true;

  const dislikedTrack = db
    .prepare(
      `SELECT 1 FROM user_dislikes
       WHERE user_id = ? AND created_at > ? AND type = 'track' AND target_id IN (${holes}) LIMIT 1`
    )
    .get(userId, since, ...ids);
  if (dislikedTrack) return true;

  // 歌手维度：从曲目缓存取歌手 mid（个别曲目缓存缺失只是少几个 mid，不影响判断方向）
  const artistMids = [
    ...new Set(
      getTracks(ids)
        .flatMap(t => (t.ar ?? []).map(a => a.mid))
        .filter((m): m is string => !!m)
    ),
  ];
  if (artistMids.length > 0) {
    const artistHoles = artistMids.map(() => '?').join(',');
    const dislikedArtist = db
      .prepare(
        `SELECT 1 FROM user_dislikes
         WHERE user_id = ? AND created_at > ? AND type = 'artist' AND target_id IN (${artistHoles}) LIMIT 1`
      )
      .get(userId, since, ...artistMids);
    if (dislikedArtist) return true;
  }

  return false;
}

/**
 * 每日推荐定时维护 —— 业务本地时间每天 00:30 跑一次（启动后也会补跑一次，见 index.ts）。
 *
 * 对每个用户：
 *   - 还没有歌单 → 交给读取路径的首次懒触发，这里不动；
 *   - 歌单已经是今天的 → 无事可做；
 *   - 否则看「上一份歌单有没有被操作过」：
 *       · 有（听过其中任意一首 / 对其中某首歌或某位歌手点过不喜欢）→ 重新生成；
 *       · 没有 → 把原歌单**顺延**到今天继续用，不花 AI、不换歌。
 */
export async function runDailyMaintenance(): Promise<void> {
  const today = todayStr();
  const userIds = getActiveUserIds();
  let regenerated = 0;
  let carried = 0;

  for (const userId of userIds) {
    const activeRaw = getDailyActiveSetting(userId);
    if (!activeRaw) continue;

    let parsed: DailyPayload;
    try {
      parsed = JSON.parse(activeRaw) as DailyPayload;
    } catch {
      log.warn(`用户 ${userId} 的歌单缓存损坏，跳过（等读取路径首次重建）`);
      continue;
    }
    if (!Array.isArray(parsed.picks) || parsed.picks.length === 0) continue;
    if (parsed.date === today) continue;

    if (wasTouchedSince(userId, parsed)) {
      regenerated += 1;
      log.info(`用户 ${userId}：上一份歌单被操作过 → 重新生成`);
      void triggerDailyFlow(userId);
    } else {
      carried += 1;
      // 顺延：picks 与 generatedAt 都保留，只把 date 改成今天，
      // 这样读取路径不会把它当过期，而下一天的「被操作过」判定仍以原始生成时间为起点。
      setSetting(dailyActiveKey(userId), JSON.stringify({ ...parsed, date: today }));
      log.info(`用户 ${userId}：上一份歌单无人操作 → 顺延沿用`);
    }
  }

  log.info(`每日维护完成：共 ${userIds.length} 位用户，重新生成 ${regenerated}，顺延 ${carried}`);
}
