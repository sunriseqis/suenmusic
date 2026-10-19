/**
 * 曲目受控标签：AI 批量打标 + 本地规则启发式秒级冷启动（数据地基，2026-09-15 用户拍板的口径）。
 *
 * ## 三条硬规矩
 *
 * 1. **风格必须从受控词表里选**，不允许自由造词 —— 否则会出现大量"语义相同、
 *    写法不同"的标签（"摇滚"/"rock"/"摇滚乐"），召回全废。模型给了词表外的词，
 *    我们**丢弃并计数**（拒收率是衡量模型是否听话的指标）。
 * 2. **语种不是风格**：单列字段。给"中文流行/日文流行"这种混维度标签一律不许。
 * 3. 召回不引向量库：缺的是标签，不是相似度计算。标签落库后召回就是 SQL 过滤。
 *
 * 输出是短 JSON（每首一行），正好避开"长 JSON 空手"的模型短板。
 */
import { getDatabase } from '../db/index.ts';
import { aiChat, AiUnavailableError, readAiConfig } from './ai-client.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('ai-tags');

/**
 * 受控词表（用户 2026-09-15 精简后定稿，**扁平、只有两个维度**）。
 *
 * 用户明确砍掉的：
 *   - 「气质/手法」整类（器乐 / 氛围 / 新世纪 / 实验）—— 不需要
 *   - 戏曲 —— 删掉
 *   - 各种细分流派（朋克/金属/后摇/舞曲/灵魂/放克/布鲁斯/乡村/雷鬼/世界音乐/
 *     拉丁/儿歌/宗教/游戏音乐）—— 精简，靠相近的大类吸收
 * 用户明确保留的：
 *   - **OST**（影视/游戏原声）作为一个分类
 *   - **古风**
 *
 * 只增不减由用户过目 —— 这是分类空间，不是自由标签。
 */
export const STYLE_VOCAB = [
  '摇滚',
  '民谣',
  '独立',
  '电子',
  '说唱',
  'R&B',
  '爵士',
  '古典',
  '古风',
  'OST',
  '情歌',
  '动感',
] as const;
/*
 * ⚠️ 词表里**故意没有「流行」**（用户拍板：实际上所有歌都是 pop，它等于零信息量，
 * 做召回过滤时谁都命中，还不如留空）。注意：语种仍单独一个维度，"中文流行/
 * 日文流行"这类混维度词依旧在禁止之列。
 */

/** 语种受控词表（与风格严格分开） */
export const LANGUAGE_VOCAB = ['华语', '粤语', '日语', '韩语', '欧美', '其他'] as const;

/** 每批多少首（思考模型下建议 15 首，减少推理与生成耗时，避免截断） */
const BATCH_SIZE = 15;
/** 单批最多重试几次（模型偶尔空手/漏项） */
const BATCH_RETRY = 1;

export interface TagRow {
  trackId: string;
  styles: string[];
  language: string;
}

/** 统计：用来判断模型是否"听话" */
export interface TagStats {
  tagged: number;
  rejectedStyles: string[];
  rejectedLanguages: string[];
  batches: number;
}

/** 已知日语歌手库 */
const KNOWN_JAP_ARTISTS = new Set([
  '井草聖二', 'ヨルシカ', 'Aqua Timez', 'SPYAIR', 'ONE OK ROCK', 'RADWIMPS',
  'Aimer', 'YOASOBI', '米津玄师', '宇多田光', '久石让', '坂本龙一', '中岛美雪',
  '仓木麻衣', '滨崎步', 'LiSA', 'YUI', '西野加奈', '花泽香菜', 'milet', 'King Gnu',
  'Official髭男dism', 'Eve', 'Vaundy', 'Aimyon', 'あいみょん', 'Mrs. GREEN APPLE',
  'back number', 'BUMP OF CHICKEN', 'WANIMA', 'MAN WITH A MISSION', 'Supercell',
  'GARNiDELiA', 'Kenshi Yonezu', 'Hikaru Utada', 'Joe Hisaishi', 'Ryuichi Sakamoto',
  'Yorushika', 'Seiji Igusa', 'TK from 凛として时雨', 'ASIAN KUNG-FU GENERATION'
]);

/** 已知韩语歌手库 */
const KNOWN_KOR_ARTISTS = new Set([
  'Rain', 'ZICO', 'J.Y. Park', 'MBLAQ', 'TREASURE', 'BIGBANG', 'EXO', 'BTS',
  'IU', 'BLACKPINK', '宋雨琦', 'TWICE', 'NewJeans', 'SEVENTEEN', 'Stray Kids',
  'NCT', 'LE SSERAFIM', 'aespa', 'Red Velvet', '少女时代', 'SUPER JUNIOR',
  'SHINee', '东方神起', '2PM', 'CNBLUE', 'FTISLAND', 'DAY6', 'AKMU', '乐童音乐家',
  '脸红的思春期', 'BOL4', '太妍', 'TAEYEON', '李知恩', '权志龙', 'G-DRAGON',
  '太阳', 'TAEYANG', '华莎', 'MAMAMOO', '朴振英', '郑智薰', '尹美莱', 'Loco',
  'Crush', 'Dean', 'Heize', 'Epik High'
]);

/** 已知粤语主要歌手/乐队库 */
const KNOWN_CANTONESE_ARTISTS = new Set([
  'BEYOND', 'Beyond', '周柏豪', '郑中基', '刘浩龙', 'Mr.', 'Supper Moment', 'Dear Jane',
  '许冠杰', '谭咏麟', '张国荣', '李克勤', '古巨基', '容祖儿', '杨千嬅', '陈小春',
  '谢霆锋', '卫兰', 'AGA', 'Gin Lee', '侧田', '麦浚龙', 'RubberBand', 'My Little Airport',
  '关楚耀', '梁汉文', '许志安', '卢巧音', '薛凯琪', '钟汉良', '郑秀文', '黎明', '郭富城',
  '林子祥', '叶倩文', '罗文', '甄妮', '尹光', '软硬天师', '达明一派', '太极乐队', '温拿乐队'
]);

/** 常见粤语经典曲名特征（用于混合双语歌手判别） */
const CANTONESE_TITLE_RE =
  /(?:粤语|粤语版|\[粤\]|\(粤\)|富士山下|海阔天空|喜欢你|光辉岁月|真的爱你|情人|冷雨夜|大地|浮夸|K歌之王|单车|好久不见|葡萄成熟时|最佳损友|落花流水|苦瓜|陀飞轮|一丝不挂|无条件|晴天 阴天 雨天|思觉失调|春娇与志明|烂泥|讲不出再见|遥远的她|月半小夜曲|红日|千千阙歌|喜帖街|倾城|酷爱|钟无艳|处处吻|相思风雨中|只想一生跟你走|李香兰|每天爱你多一些|饿狼传说|暗里着迷|爱不完|如果有一天|男儿当自强|笑看风云|随缘|一生何求|偏偏喜欢你|念亲恩|今宵多珍重|涟漪|风继续吹|当年情|倩女幽魂|沉默是金|追|共同度过|左右手|怪你过分美丽|容易受伤的女人|执迷不悔|给自己的情书|约定|爱与痛的边缘|沧海一声笑|上海滩|世间始终你好|铁血丹心|漫步人生路)/i;

/** 已知欧美歌手库 */
const KNOWN_WESTERN_ARTISTS = new Set([
  'Emma Sameth', 'Sebastian Yatra', 'Justin Bieber', 'Shoffy', 'Dan + Shay',
  'Peder Elias', 'Shawn Mendes', 'Taylor Swift', 'Ed Sheeran', 'Charlie Puth',
  'Bruno Mars', 'Maroon 5', 'Coldplay', 'Imagine Dragons', 'OneRepublic',
  'The Weeknd', 'Billie Eilish', 'Post Malone', 'Dua Lipa', 'Sam Smith',
  'Adele', 'Sia', 'Lady Gaga', 'Ariana Grande', 'Avicii', 'Alan Walker',
  'Marshmello', 'The Chainsmokers', 'Lauv', 'Troye Sivan', 'LANY', 'Jeremy Zucker',
  'Keshi', 'Alec Benjamin', 'Honne', 'Sasha Alex Sloan', 'Westlife', 'Backstreet Boys',
  'Michael Jackson', 'Queen', 'The Beatles', 'Oasis', 'Radiohead', 'Green Day', 'Linkin Park'
]);

const isAsciiText = (s: string): boolean => /^[\x00-\x7F\u2018\u2019\u00B7\u2026]+$/.test(s);

/**
 * 本地规则启发式打标：毫秒级完成曲目的语种与受控风格分类预判。
 */
export function heuristicTag(track: {
  name: string;
  artist: string;
  album?: string;
}): { styles: string[]; language: string } {
  const name = track.name || '';
  const artist = track.artist || '';
  const album = track.album || '';
  const text = `${name} ${artist} ${album}`;

  // 1. 语种判断
  let language = '华语';
  if (/[\u3040-\u30ff]/.test(text) || KNOWN_JAP_ARTISTS.has(artist)) {
    language = '日语';
  } else if (/[\uac00-\ud7af]/.test(text) || KNOWN_KOR_ARTISTS.has(artist)) {
    language = '韩语';
  } else if (
    CANTONESE_TITLE_RE.test(name) ||
    KNOWN_CANTONESE_ARTISTS.has(artist) ||
    /(?:粤语|粤语版|\[粤\]|\(粤\))/i.test(text)
  ) {
    language = '粤语';
  } else if (
    KNOWN_WESTERN_ARTISTS.has(artist) ||
    (isAsciiText(name) && isAsciiText(artist) && !/[\u4e00-\u9fa5]/.test(text))
  ) {
    language = '欧美';
  } else if (/[\u4e00-\u9fa5]/.test(text)) {
    language = '华语';
  } else {
    language = '其他';
  }

  // 2. 风格判断（受控 12 类，最多 3 个）
  const styles: string[] = [];
  if (/(OST|原声|影视原声|电影原声|电视剧原声|网剧原声|动画原声|动漫原声|游戏原声|主题曲|片头曲|片尾曲|插曲|片尾主题曲|概念曲)/i.test(text)) {
    styles.push('OST');
  }
  if (/(古风|仙侠|江湖|琵琶|古筝|二胡|笛子|笛声|国风|青花|赤伶|牵丝戏|九万字|下山|辞九门回忆|红昭愿|芒种|锦瑟|关山酒|虞兮叹)/.test(text) || /王朝1982|等什么君|双笙|银临|河图|音频怪物/.test(artist)) {
    styles.push('古风');
  }
  if (/(说唱|Rap|Hip-Hop|嘻哈|Freestyle|Cypher|Trap|Beats)/i.test(text) || /Ghost|王琳凯|GAI|Jony|法老|马思唯|C-BLOCK|欧阳靖|顽童/.test(artist)) {
    styles.push('说唱');
  }
  if (/(摇滚|Rock|Punk|Metal|朋克|重金属|乐队)/i.test(text) || /五月天|草东没有派对|痛仰|新裤子|逃跑计划|万能青年旅店|告五人|盘尼西林|旅行团|旅行新蜜蜂|刺猬|反光镜|崔健|汪峰|许巍|郑钧|黑豹|唐朝|伍佰|BEYOND|Beyond|Mr\.|SPYAIR|Aqua Timez|ONE OK ROCK|八三夭|信乐团|回春丹|落日飞车/.test(artist)) {
    styles.push('摇滚');
  }
  if (/ヨルシカ|草东|郭顶|落日飞车|Deca Joins|康士坦|安溥|张悬|魏如萱/.test(artist) || /(独立|Indie)/i.test(text)) {
    styles.push('独立');
  }
  if (/赵雷|宋冬野|马頔|陈粒|房东的猫|朴树|许巍|李健|好妹妹|民谣/.test(artist) || /(民谣|吉他弹唱|木吉他)/.test(text)) {
    styles.push('民谣');
  }
  if (/(电子|EDM|House|Techno|Synth|Remix|Electro|电音)/i.test(text) || /Avicii|Alan Walker|Marshmello|The Chainsmokers|Zedd/.test(artist)) {
    styles.push('电子');
  }
  if (/(R&B|Soul|蓝调|灵魂乐|慢摇)/i.test(text) || /陶喆|方大同|周杰伦|汪苏泷|李荣浩|袁娅维|丁世光|胡彦斌|余佳运|郑润泽|h3R3|Keshi/.test(artist)) {
    styles.push('R&B');
  }
  if (/(动感|舞曲|Dance|Beat|跳动|嗨|快节奏|健身|热血|电台)/i.test(text) || /Rain|PSY|潘玮柏|罗志祥|萧亚轩|蔡依林/.test(artist)) {
    styles.push('动感');
  }
  if (/井草聖二|久石让|坂本龙一|押尾光太郎|岸部真明|郎朗|李云迪/.test(artist) || /(古典|指弹|吉他独奏|钢琴独奏|大提琴|小提琴|交响|协奏曲)/.test(text)) {
    styles.push('古典');
  }

  // 兜底抒情情歌：若尚未识别出风格，或歌名明显带有感情/情歌意象
  if (
    styles.length === 0 ||
    /(情歌|爱|恋|心|喜欢|想念|思念|眼泪|分手|伤痕|承诺|温柔|晴天|离人|愿与愁|我以为|笨蛋|失恋|深爱|牵手|遗憾|放手|忘记|回忆|知我|思觉失调|再度重相逢|当我遇上你|凄美地|心墙|雨爱|失眠|瞬|此刻|春娇与志明|唯一|特别的人|像风一样|富士山下|爱我还是他)/.test(name)
  ) {
    if (!styles.includes('情歌') && styles.length < 3) {
      styles.push('情歌');
    }
  }

  return { styles: styles.slice(0, 3), language };
}

/** 取还没打过标的曲目（优先收藏里的 —— 用户拍板先标收藏） */
export function pickUntagged(limit: number): Array<{ id: string; name: string; artist: string; album: string }> {
  return getDatabase()
    .prepare(
      `SELECT t.id AS id,
              json_extract(t.payload_json, '$.name') AS name,
              json_extract(t.artists_json, '$[0].name') AS artist,
              COALESCE(json_extract(t.payload_json, '$.al.name'), '') AS album
         FROM tracks t
         LEFT JOIN track_tags g ON g.track_id = t.id
        WHERE g.track_id IS NULL
          AND json_extract(t.payload_json, '$.name') IS NOT NULL
        ORDER BY EXISTS(SELECT 1 FROM favorites f WHERE f.track_id = t.id) DESC, t.updated_at DESC
        LIMIT ?`
    )
    .all(limit) as unknown as Array<{ id: string; name: string; artist: string; album: string }>;
}

/**
 * 批量基于本地启发式规则快速打标（零延迟、零网络开销、100% 覆盖）
 */
export function tagTracksHeuristic(limit = 1000): number {
  const rows = pickUntagged(limit);
  if (rows.length === 0) return 0;

  const validRows: TagRow[] = [];
  for (const r of rows) {
    const res = heuristicTag(r);
    validRows.push({
      trackId: r.id,
      styles: res.styles,
      language: res.language,
    });
  }

  saveTags(validRows, 'heuristic');
  log.info(`启发式规则打标完成：成功为 ${validRows.length} 首未打标曲目写入受控标签`);
  return validRows.length;
}

function buildMessages(
  rows: Array<{ id: string; name: string; artist: string; album: string }>
): Array<{ role: 'system' | 'user'; content: string }> {
  const system = `你是音乐分类员。给你一批曲目，为每一首输出受控维度的标签。

## 风格（styles）
只能从下面这份受控清单里选（最多 3 个），用清单里的原词，严禁自造或写其他流派词：
${STYLE_VOCAB.join(' / ')}

注意：
- 清单里**没有「流行」**（流行无信息量，不要硬填）。
- **情歌** = 爱情/抒情主题慢歌；
- **动感** = 节奏强劲的快歌/舞曲/电子摇滚。
若实在无法归类，styles 给空数组 []，不要生搬硬套。

## 语种（language）
只能填一个且必须在受控清单中：${LANGUAGE_VOCAB.join(' / ')}
（绝对不要出现“中文流行/国语流行”等混合词）。

## 输出格式（严格纯 JSON 对象，严禁 Markdown 标记）
{"items":[{"id":"<原样回填 id>","styles":["情歌","R&B"],"language":"华语"}]}`;

  const user = rows.map(r => `id=${r.id} | ${r.name} | ${r.artist} | ${r.album}`).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 抠 JSON（容忍代码块/前后废话） */
function parseItems(text: string): Array<Record<string, unknown>> {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as { items?: unknown };
    return Array.isArray(obj.items) ? (obj.items as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/** 严格校验：词表外的风格/语种一律丢弃并计数（这就是"受控"的落地） */
function validate(
  raw: Array<Record<string, unknown>>,
  validIds: Set<string>,
  stats: TagStats
): TagRow[] {
  const out: TagRow[] = [];
  const styles = new Set<string>(STYLE_VOCAB);
  const langs = new Set<string>(LANGUAGE_VOCAB);

  for (const item of raw) {
    const id = String(item.id ?? '').trim();
    if (!validIds.has(id)) continue;
    const pickedStyles: string[] = [];
    for (const s of Array.isArray(item.styles) ? (item.styles as unknown[]) : []) {
      const name = String(s ?? '').trim();
      if (!name) continue;
      if (!styles.has(name)) {
        stats.rejectedStyles.push(name);
        continue;
      }
      if (!pickedStyles.includes(name)) pickedStyles.push(name);
    }
    let language = String(item.language ?? '').trim();
    if (!langs.has(language)) {
      if (language) stats.rejectedLanguages.push(language);
      language = '';
    }
    out.push({ trackId: id, styles: pickedStyles.slice(0, 3), language });
  }
  return out;
}

function saveTags(rows: TagRow[], model: string): void {
  if (rows.length === 0) return;
  const db = getDatabase();
  const ins = db.prepare(
    `INSERT INTO track_tags (track_id, styles, language, acceptance, source, model, tagged_at)
     VALUES (?, ?, ?, 0, 'ai', ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET
       styles = excluded.styles, language = excluded.language,
       source = 'ai', model = excluded.model, tagged_at = excluded.tagged_at`
  );
  const ts = Date.now();
  db.exec('BEGIN');
  try {
    for (const r of rows) ins.run(r.trackId, JSON.stringify(r.styles), r.language, model, ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 为单个曲目打标（优先启发式即时打标） */
export function tagSingleTrack(trackId: string): void {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT t.id AS id,
              json_extract(t.payload_json, '$.name') AS name,
              json_extract(t.artists_json, '$[0].name') AS artist,
              COALESCE(json_extract(t.payload_json, '$.al.name'), '') AS album
         FROM tracks t
         LEFT JOIN track_tags g ON g.track_id = t.id
        WHERE t.id = ? AND g.track_id IS NULL`
    )
    .get(trackId) as { id: string; name: string; artist: string; album: string } | undefined;

  if (row) {
    const res = heuristicTag(row);
    saveTags([{ trackId: row.id, styles: res.styles, language: res.language }], 'heuristic');
  }
}

/**
 * 批量打标：一次跑 limit 首（每批 BATCH_SIZE 首调一次模型）。
 *
 * 增强鲁棒性：
 * 1. maxTokens 给足 12000，防止思考模型截断；
 * 2. 模型调用失败时自动无缝降级使用启发式打标，确保每一首都能及时入库。
 */
export async function tagTracks(limit: number): Promise<TagStats> {
  const cfg = readAiConfig();
  if (!cfg) {
    log.info('AI 模型未配置，执行启发式快速打标');
    const hTagged = tagTracksHeuristic(limit);
    return { tagged: hTagged, rejectedStyles: [], rejectedLanguages: [], batches: 0 };
  }

  const rows = pickUntagged(limit);
  if (rows.length === 0) {
    log.info('没有待打标的曲目');
    return { tagged: 0, rejectedStyles: [], rejectedLanguages: [], batches: 0 };
  }
  log.info(`待打标 ${rows.length} 首，每批 ${BATCH_SIZE} 首`);

  const stats: TagStats = { tagged: 0, rejectedStyles: [], rejectedLanguages: [], batches: 0 };

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const validIds = new Set(batch.map(r => r.id));
    let tagged = 0;

    for (let attempt = 0; attempt <= BATCH_RETRY; attempt++) {
      try {
        // 600s：与画像同端点同量级（SiliconFlow），90s 必然频繁超时
        const text = await aiChat(buildMessages(batch), { jsonMode: true, maxTokens: 12000, timeoutMs: 600_000 });
        const items = parseItems(text);
        const valid = validate(items, validIds, stats);
        if (valid.length === 0) {
          log.warn(`第 ${Math.floor(i / BATCH_SIZE) + 1} 批：模型输出里没有可用条目（尝试 ${attempt + 1}）`);
          continue;
        }
        saveTags(valid, cfg.model);
        tagged = valid.length;
        break;
      } catch (err) {
        log.warn(`第 ${Math.floor(i / BATCH_SIZE) + 1} 批失败（尝试 ${attempt + 1}）：${(err as Error).message}`);
      }
    }

    // 容灾兜底：若 AI 未能成功打标该批，由启发式规则保底
    if (tagged < batch.length) {
      const db = getDatabase();
      const untaggedInBatch = batch.filter(b => {
        const row = db.prepare('SELECT track_id FROM track_tags WHERE track_id = ?').get(b.id);
        return !row;
      });
      if (untaggedInBatch.length > 0) {
        const fallbackRows: TagRow[] = untaggedInBatch.map(r => {
          const h = heuristicTag(r);
          return { trackId: r.id, styles: h.styles, language: h.language };
        });
        saveTags(fallbackRows, 'heuristic_fallback');
        tagged += fallbackRows.length;
        log.info(`第 ${Math.floor(i / BATCH_SIZE) + 1} 批：启发式兜底补充 ${fallbackRows.length} 首`);
      }
    }

    stats.tagged += tagged;
    stats.batches += 1;
    log.info(`第 ${Math.floor(i / BATCH_SIZE) + 1} 批：${tagged}/${batch.length} 首已打标（累计 ${stats.tagged}）`);
  }

  const uniqRejected = [...new Set(stats.rejectedStyles)].slice(0, 10);
  log.info(
    `打标完成：${stats.tagged} 首 · ${stats.batches} 批` +
      (uniqRejected.length > 0 ? ` · **被丢弃的词表外标签**：${uniqRejected.join('、')}` : ' · 无越界标签 ✓')
  );
  return stats;
}

/**
 * 自动打标总调度：先秒级跑完启发式规则打标，若曲库仍有未标再触发 AI 补精细标签。
 */
export async function autoTagUntagged(limit = 500): Promise<{ heuristicTagged: number; aiTagged: number }> {
  const heuristicTagged = tagTracksHeuristic(limit);
  let aiTagged = 0;
  const cfg = readAiConfig();
  if (cfg && heuristicTagged < limit) {
    try {
      const stats = await tagTracks(Math.min(30, limit));
      aiTagged = stats.tagged;
    } catch (e) {
      log.warn(`后台 AI 标签打标异常：${(e as Error).message}`);
    }
  }
  return { heuristicTagged, aiTagged };
}
