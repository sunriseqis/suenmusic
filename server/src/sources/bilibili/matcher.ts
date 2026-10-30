/**
 * B 站音源多维置信度评估打分器。
 *
 * 搬运自桌面端 src/utils/bilibili/matcher.js（PoC 实证模型，实测准确率 95%）。
 * 该文件是纯函数、零依赖，评分逻辑【一个字节都不改】—— 它是项目里唯一被
 * 真实数据验证过的算法，任何"顺手优化"都会让实测结论失效。
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
  // 纯音乐 / 无人声版本：与 services/content-filter.ts 的曲目侧判定同口径，
  // 免得这边把一首"钢琴纯音乐"视频当原曲匹配回来（标题里常有 instrumental / 纯音乐）。
  '纯音乐',
  '純音樂',
  'instrumental',
  '无人声',
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

/**
 * 「非录音室版本」标记（现场 / 直拍 / 舞台 / 直播 …）。
 *
 * ⚠️ 与上面的 LIVE_KEYWORDS 是**两套东西**，不要合并：
 *   · LIVE_KEYWORDS 参与 `scoreCandidate` 打分（每命中一项扣 20 分，软惩罚）——
 *     那段算法是被实测验证过的，一个字节都不改；
 *   · 这一套只给 `filterStudioCandidates` 的**硬过滤**用。
 *
 * 为什么软惩罚不够（2026-10-30 用户报障）：标题完全对得上、时长也刚好卡住的直拍/饭拍，
 * 40（时长）+ 25（歌名）+ 15（歌手）− 20（live 惩罚）= 60 分，照样压过阈值 ——
 * 用户点开听到的是一段手机竖屏现场收音。「扣分」永远只能降低排名，不能否决。
 *
 * 中文按子串匹配（中文没有词边界），拉丁必须按**词边界**匹配：
 * Alive / Deliver / Lively / Concerted 这些正常标题不能被 live / concert 误杀。
 */
const CN_NON_STUDIO_KEYWORDS = [
  '演唱会',
  '现场',
  '音乐节',
  '跨年',
  '直拍',
  '饭拍',
  '舞台',
  '直播',
  '打歌',
  '巡演',
  '返场',
  '歌友会',
  '签售会',
  '彩排',
  '总决赛',
  '晚会',
];

const LATIN_NON_STUDIO_RES = ['live', 'fancam', 'concert', 'livehouse'].map(
  k => new RegExp(`\\b${k}\\b`, 'i')
);

/**
 * 标题是否带「非录音室版本」标记（现场 / 直拍 / 舞台 / 直播 …）。
 *
 * 纯函数、零依赖 —— 解析链、锚定弹窗、运维脚本都能直接引用。
 */
export function isNonStudioTitle(title: string | null | undefined): boolean {
  const s = String(title ?? '');
  if (!s) return false;
  if (CN_NON_STUDIO_KEYWORDS.some(k => s.includes(k))) return true;
  return LATIN_NON_STUDIO_RES.some(re => re.test(s));
}

/**
 * 从候选池里筛掉非录音室版本，返回「能当录音室音源用」的那批。
 *
 * 规则：
 *   1. **原曲自身就是现场版**（曲名带 live / 现场 / 演唱会…）→ 原样返回。
 *      不过滤等于自我否决：用户要的就是现场版时，把所有 live 候选筛掉只会永远解析失败。
 *   2. 否则按标题逐条剔除 —— 只看标题不看作者：UP 主名里带 Live 的搬运号很常见，
 *      而直拍/饭拍的标记（直拍 / 舞台 / 饭拍…）几乎总写在标题里。
 *
 * 全被筛掉是**合法结果**（这首网上只有非录音室版本）：调用方据此按「无候选」处理，
 * 客户端会弹锚定弹窗、用户可自己挑 —— 所以这里不做兜底回填。
 */
export function filterStudioCandidates<T extends { title: string }>(
  trackName: string,
  candidates: readonly T[]
): T[] {
  if (isNonStudioTitle(trackName)) return candidates.slice();
  return candidates.filter(c => !isNonStudioTitle(c.title));
}

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

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
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
