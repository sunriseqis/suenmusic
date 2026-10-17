/**
 * B 站音源多维置信度评估打分器（客户端版）。
 *
 * **逐字搬自** 服务端 `sources/bilibili/matcher.ts`（其本身又搬自桌面端 PoC，
 * 实测准确率 95%）。评分逻辑一个字节都没改 —— 这是项目里唯一被真实数据验证过的
 * 算法，任何"顺手优化"都会让实测结论失效。
 *
 * 为什么客户端也要有一份：无服务端时解析只能自己做，而"搜到第一个结果就用"
 * 会把翻唱/伴奏/鬼畜当成原曲（用户能立刻听出来）。宁可多搬 197 行，
 * 也不要重新发明一个没验证过的打分。
 */

export interface MatchTrack {
  /** 曲名 */
  name: string;
  /** 歌手名列表 */
  artists: string[];
  /** 时长（毫秒） */
  durationMs: number;
}

export interface MatchCandidate {
  bvid: string;
  title: string;
  author: string;
  /** 时长（秒） */
  durationSec: number;
  play?: number;
  /** 封面图（B 站搜索返回的 pic，协议相对地址 // 开头）。锚定弹窗展示用 */
  pic?: string;
}

export interface ScoreResult {
  finalScore: number;
  durationDiff: number;
  durationSec: number;
}

const NEGATIVE_KEYWORDS = [
  '翻唱',
  'cover',
  '改编',
  '伴奏',
  '纯伴奏',
  '伴奏带',
  '吉他弹唱',
  '钢琴版',
  '鼓谱',
  '琴谱',
  '吉他谱',
  '曲谱',
  'reaction',
  '鬼畜',
  '降调',
  '变速',
  'suno',
  'ai翻唱',
  'dj版',
  '慢摇',
  '加长版',
  '教学',
  '解说',
  '试听',
  '片段',
  '歌词版剪辑',
  '原唱挑战',
  '卡拉ok',
  '朗读',
];

const LIVE_KEYWORDS = ['演唱会', 'live', '现场', '音乐节', '跨年'];

const POSITIVE_KEYWORDS = [
  '官方',
  'mv',
  'official',
  '纯享',
  '原版',
  '完整版',
  '无损',
  '音频',
  '高音质',
  'hires',
  '4k修复',
];

/**
 * 将 mm:ss 或 hh:mm:ss 格式字符串转换为秒数。
 */
export function parseDuration(input: string | number | null | undefined): number {
  if (typeof input === 'number') return input;
  if (!input) return 0;

  const parts = String(input)
    .split(':')
    .map(p => parseInt(p, 10))
    .filter(n => !Number.isNaN(n));

  // 非空断言只是为了满足 noUncheckedIndexedAccess —— 长度已在上面判过
  if (parts.length === 2) {
    return parts[0]! * 60 + parts[1]!;
  }
  if (parts.length === 3) {
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }
  return 0;
}

/**
 * 评估单个候选视频的置信度得分 (满分 100)。
 */
export function scoreCandidate(
  track: MatchTrack,
  cand: MatchCandidate
): ScoreResult {
  let score = 0.0;
  const targetName = (track.name || '').toLowerCase().trim();
  const singers = (track.artists || []).map(a => (a || '').toLowerCase().trim());
  const candTitle = (cand.title || '').toLowerCase().trim();
  const candAuthor = (cand.author || '').toLowerCase().trim();

  const targetDurationSec = Math.round((track.durationMs || 0) / 1000);
  const candDurationSec = cand.durationSec || 0;

  // 1. 时长绝对误差评分 (满分 40 分，强硬指标)
  const durationDiff = Math.abs(targetDurationSec - candDurationSec);
  let durationScore = 0.0;
  if (durationDiff <= 2) {
    durationScore = 40.0;
  } else if (durationDiff <= 5) {
    durationScore = 30.0;
  } else if (durationDiff <= 10) {
    durationScore = 15.0;
  } else if (durationDiff <= 20) {
    durationScore = 0.0;
  } else {
    durationScore = -40.0; // 严重超时或过短直接大幅惩罚
  }
  score += durationScore;

  // 2. 负面词过滤 (熔断机制，每命中一项大额扣除 35 分)
  let penalty = 0.0;
  for (const neg of NEGATIVE_KEYWORDS) {
    if (
      (candTitle.includes(neg) || candAuthor.includes(neg)) &&
      !targetName.includes(neg)
    ) {
      penalty += 35.0;
    }
  }

  // 现场版 / 演唱会惩罚 (若原曲自身不是 live)
  const isTargetLive = LIVE_KEYWORDS.some(l => targetName.includes(l));
  if (!isTargetLive) {
    for (const l of LIVE_KEYWORDS) {
      if (candTitle.includes(l)) {
        penalty += 20.0;
        break;
      }
    }
  }
  score -= penalty;

  // 3. 标题与歌手相关度评分 (满分 40 分)
  let textScore = 0.0;
  // 歌名匹配
  if (candTitle.includes(targetName)) {
    textScore += 25.0;
  } else {
    // 移除括号副标题后重试
    const cleanTarget = targetName.replace(/\(.*?\)|（.*?）/g, '').trim();
    if (cleanTarget && candTitle.includes(cleanTarget)) {
      textScore += 20.0;
    }
  }

  // 歌手匹配
  for (const s of singers) {
    if (s && (candTitle.includes(s) || candAuthor.includes(s))) {
      textScore += 15.0;
      break;
    }
  }
  score += textScore;

  // 4. 正面词与官方加权 (满分 20 分)
  let posScore = 0.0;
  for (const pos of POSITIVE_KEYWORDS) {
    if (candTitle.includes(pos)) {
      posScore += 5.0;
      if (posScore >= 15.0) break;
    }
  }
  const officialTags = ['音乐', 'official', 'mv', '唱片', '工作室'];
  if (officialTags.some(tag => candAuthor.includes(tag))) {
    posScore += 5.0;
  }
  score += posScore;

  const finalScore = Math.round(Math.max(0.0, Math.min(100.0, score)) * 10) / 10;
  return { finalScore, durationDiff, durationSec: candDurationSec };
}
