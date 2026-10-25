/**
 * 翻奏 / 钢琴 / 纯音乐条目判定（曲目元数据口径）。
 *
 * ## 为什么需要它
 *
 * 实测：每日 40 首里有 6 首（15%）是翻奏钢琴版 —— 曲名与原曲一模一样，
 * 歌手/专辑却是翻奏者（`小城大事 | 杨千嬅 | 温馨小品钢琴集`、
 * `涟漪 | Lawrence | 谱普钢琴集`、`心雨 | 赵海洋 | 夜色钢琴曲`）。
 * 用户看到歌名正常，点进去听却是纯音乐。它们在曲库里是**独立条目**，
 * 所以「曲名去重」拦不住，AI 选曲还会把「钢琴 + 流行」当成同质好料反复挑。
 *
 * 黑名单是给用户级排除用的，不是兜底脏数据的手段 —— 这类条目应该由
 * **统一判定**在入池/选曲时直接排除，曲目本身仍留在 `tracks` 表（可被搜索、
 * 可被播放），只是不再进推荐链路。
 *
 * ## 判定规则（为什么不会误杀原曲）
 *
 * 1. **专辑名或歌手名命中** → true。
 *    「钢琴演奏专辑」「夜色钢琴曲」「姜创钢琴」这类翻奏者/翻奏合辑是按
 *    「谁在弹」命名的，原曲的专辑几乎不会写成钢琴曲集。
 *    唯一的坑是**同名专辑**：伍思凯原唱的《爱的钢琴手》，专辑名就是曲名，
 *    这里的「钢琴」来自原曲标题本身，不构成翻奏证据 —— 所以同名专辑不计入证据。
 * 2. **仅曲名命中**（专辑/歌手都干净）→ 必须再有第二份证据才 true：
 *    - 曲名里含强标记（纯音乐/伴奏/演奏版/instrumental/karaoke/卡拉ok），或
 *    - 歌手名像翻奏者（含 钢琴/piano/演奏/cover）。
 *    于是 `八音盒 (Life Is Still Going On)`（NCT DREAM 原曲）、
 *    `司南《吹灭小山河 (网友改编)》` 这类「只是歌名里带了关键词」的正常曲目不误杀。
 * 3. 拉丁关键词按**词边界**匹配（`\bcover\b`）：`Recovered` 这类词不会被当 cover。
 *
 * 本模块刻意保持**零依赖**：`scripts/purge-covers.mjs` 要能脱离服务端运行时直接引用它，
 * 所以这里不 import 数据库/配置/日志。
 */

/** 判定只需要元数据，不要求完整 Track —— 裸 JSON 载荷也能喂进来 */
export interface CoverProbe {
  name?: string | null;
  ar?: ReadonlyArray<{ name?: string | null } | null | undefined> | null;
  artists?: ReadonlyArray<{ name?: string | null } | null | undefined> | null;
  al?: { name?: string | null } | null;
  album?: { name?: string | null } | null;
}

/**
 * 中文关键词（子串匹配，中文没有词边界）。
 *
 * 与 `sources/bilibili/matcher.ts` 的 NEGATIVE_KEYWORDS 同口径，
 * 但这里面向**曲目元数据**，所以保留「钢琴/演奏/纯音乐」这类在 B 站标题里
 * 会因为翻唱标题而误伤、在专辑/歌手字段里却几乎只属于翻奏条目的词。
 */
const CN_KEYWORDS = [
  '钢琴',
  '鋼琴',
  '纯音乐',
  '純音樂',
  '演奏',
  '伴奏',
  '改编',
  '改編',
  '八音盒',
  '音乐盒',
  '音樂盒',
  '吉他演奏',
  '轻音乐',
  '輕音樂',
  '电音改编',
  '抖音版',
  '翻奏',
  '卡拉ok',
];

/** 拉丁关键词：按词边界匹配（见文件头规则 3） */
const LATIN_KEYWORDS = ['piano', 'instrumental', 'cover', 'karaoke'];

/**
 * 显式名单：**专辑名/歌手名里不带关键词**、但整张就是钢琴/器乐演奏的条目。
 *
 * 为什么必须要有：关键词只覆盖到「钢琴/演奏/纯音乐」这类命名，实测仍有漏网 ——
 *   `往后余生 | 张穆庭 | 延禧`、`K歌之王 | 陈辉阳 | 声音变魔术`、
 *   `月光边境 | 林海`、`戀 冬 | V.K克 | 镜夜`。
 * 这些专辑名干净得像原专辑，只能靠名单。名单按「实测命中」增量维护，
 * 每条都注明为什么（翻奏者 / 器乐专辑），便于以后审计与删除误伤。
 */
const KNOWN_INSTRUMENTAL_ALBUMS: ReadonlyArray<{ match: string; why: string }> = [
  { match: '延禧', why: '张穆庭钢琴演奏（延禧攻略改编）' },
  { match: '声音变魔术', why: '陈辉阳钢琴作品集' },
  { match: '镜夜', why: 'V.K克 器乐专辑' },
  { match: '月光边境', why: '林海 器乐专辑（同名曲也是器乐）' },
  { match: '青石巷', why: '器乐/氛围' },
  { match: '音符', why: '张一益 器乐专辑' },
];

/** 演奏者 / 器乐作者名单（歌手名干净但整目录都是器乐的） */
const KNOWN_INSTRUMENTAL_ARTISTS: ReadonlyArray<{ match: string; why: string }> = [
  { match: '张穆庭', why: '钢琴演奏者' },
  { match: '林海', why: '器乐/新世纪' },
  { match: 'V.K克', why: '器乐' },
  { match: '文武贝', why: '流行钢琴演奏' },
  { match: '赵海洋', why: '夜色钢琴曲' },
  { match: '王崴', why: '玫瑰钢琴' },
  { match: '姜创钢琴', why: '钢琴改编' },
  { match: '全璟璟', why: '蓝钢琴' },
  { match: '姚远', why: '钢琴遇上流行乐' },
  { match: '魏琮霏', why: '器乐' },
  { match: '张一益', why: '器乐' },
];

const CN_RE = new RegExp(CN_KEYWORDS.join('|'), 'i');
const LATIN_RES = LATIN_KEYWORDS.map(k => new RegExp(`\\b${k}\\b`, 'i'));

/** 字符串里是否出现任一翻奏/纯音乐关键词 */
export function hasCoverKeyword(text: string | null | undefined): boolean {
  const s = String(text ?? '');
  if (!s) return false;
  if (CN_RE.test(s)) return true;
  return LATIN_RES.some(re => re.test(s));
}

/**
 * 曲名里的**强标记**：出现它就已经说明这条是伴奏/纯音乐/演奏版，不需要别的证据。
 */
const STRONG_TITLE_RE = /(纯音乐|純音樂|伴奏|演奏版|instrumental|karaoke|卡拉ok)/i;

/**
 * 「歌手名像翻奏者」：只认钢琴/piano/演奏/cover 这几个词。
 * 正常情况下这类歌手在规则 1 就已被拦下，这里保留是为了关键词集合将来分叉时不静默失效。
 */
const PERFORMER_RE = /(钢琴|鋼琴|piano|演奏|cover)/i;

/** 归一化：去掉空白与标点，用于「同名专辑」比较 */
const norm = (s: string | null | undefined): string =>
  String(s ?? '').toLowerCase().replace(/[\s《》"'"'·,，.。!！?？:：;；\-—–_/()（）\[\]【】]/g, '');

function artistNames(track: CoverProbe): string {
  const list = track.ar ?? track.artists ?? [];
  return list
    .map(a => String(a?.name ?? ''))
    .filter(Boolean)
    .join(' / ');
}

function albumName(track: CoverProbe): string {
  return String(track.al?.name ?? track.album?.name ?? '');
}

/**
 * 这条曲目是不是翻奏 / 钢琴 / 纯音乐版本（应当被推荐链路排除）。
 *
 * @returns true = 翻奏或纯音乐；false = 正常条目（原曲、或只是歌名里带了关键词）
 */
export function isCoverOrInstrumental(track: CoverProbe | null | undefined): boolean {
  if (!track) return false;
  const name = String(track.name ?? '');
  const artist = artistNames(track);
  const album = albumName(track);

  // ---- 规则 1：专辑名 / 歌手名命中 ----
  // 同名专辑不算证据（《爱的钢琴手》是伍思凯原曲，专辑名只是复用了曲名）
  const albumIsEponymous = !!album && norm(album) === norm(name);
  if (hasCoverKeyword(album) && !albumIsEponymous) return true;
  if (hasCoverKeyword(artist)) return true;

  // ---- 规则 1.5：显式名单（关键词抓不到的器乐/翻奏专辑） ----
  if (album && KNOWN_INSTRUMENTAL_ALBUMS.some(e => album.includes(e.match))) return true;
  if (artist && KNOWN_INSTRUMENTAL_ARTISTS.some(e => artist.includes(e.match))) return true;

  // ---- 规则 2：仅曲名命中，需要第二份证据 ----
  if (hasCoverKeyword(name)) {
    if (STRONG_TITLE_RE.test(name)) return true;
    if (PERFORMER_RE.test(artist)) return true;
    return false;
  }

  return false;
}
