/**
 * LRC 歌词解析与当前行计算（包 A）。
 *
 * 全部是纯函数，零依赖 —— 单测见 `scripts/lyric-test.ts`。
 *
 * 处理的现实：
 *   - 时间戳 `[mm:ss]` / `[mm:ss.xx]` / `[mm:ss.xxx]`，一行可带**多个**时间戳
 *     （ `[00:12.00][01:30.00] 同一句` 出现在副歌重复时）
 *   - 元数据行 `[ti:xxx] [ar:xxx] [offset:500]`：offset 是全局毫秒偏移
 *     （正值 = 歌词整体提前），必须应用；其余进 `meta` 供兜底展示
 *   - 翻译歌词（tlyric）时间戳与原文**通常一致但不保证**，按容差对齐
 *   - 网易云不返回翻译时 tlyric 为空串
 */

export interface LyricLine {
  /** 行起始毫秒 */
  time: number;
  text: string;
  /** 对齐到的翻译（无翻译的行没有这个字段） */
  trans?: string;
}

export interface ParsedLyrics {
  lines: LyricLine[];
  /** 元数据与无时间戳的散行（作词/作曲等），详情页兜底展示用 */
  meta: string[];
}

/** `[mm:ss.xx]` / `[mm:ss.xxx]`；容许分/秒位数可变 */
const TIME_TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
/** 元数据标签 `[ti:...]` 之类 —— 冒号后是非数字。offset 单独处理（要应用偏移） */
const META_TAG = /^\[(ti|ar|al|by|au|length|re|ve|tool|kana|offset):([^\]]*)\]\s*/i;

/** 把单个时间标签组解析成毫秒；非法返回 null */
function tagToMs(min: string, sec: string, frac: string | undefined): number | null {
  const m = Number(min);
  const s = Number(sec);
  if (!Number.isFinite(m) || !Number.isFinite(s) || s >= 60) return null;
  // 惯例：2 位小数 = 厘秒（×10），3 位 = 毫秒
  let f = 0;
  if (frac) {
    const n = Number(frac);
    if (!Number.isFinite(n)) return null;
    f = frac.length === 3 ? n : n * 10;
  }
  return m * 60_000 + s * 1000 + f;
}

/**
 * 清洗并格式化歌词文本：
 * 1. 过滤单纯的占位符（如 QQ 音乐无翻译时给的 "//" 占位符）
 * 2. 去除行首、行尾多余的 "//"
 * 3. 将行内的 "//"（换行符）规范化为 "\n"
 */
export function cleanLyricText(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // 纯占位符：只有 //、/ 或空白
  if (!trimmed || /^[\s/]+$/.test(trimmed)) return '';
  // 去除行首与行尾多余的 //
  let cleaned = trimmed.replace(/^[\s/]*\/\/+[\s/]*/, '').replace(/[\s/]*\/\/+[\s/]*$/, '');
  // 将行内的 // 换行符替换为 \n（兼顾 // 前后的空白）
  cleaned = cleaned.replace(/\s*\/\/+\s*/g, '\n').trim();
  return cleaned;
}

/** 内部解析：歌词行（含未排序）+ 元数据散行。applyOffset 见 parseLrc 注释 */
function parseLines(lrc: string): { lines: LyricLine[]; meta: string[] } {
  const lines: LyricLine[] = [];
  const meta: string[] = [];
  let offset = 0;

  for (const rawLine of String(lrc ?? '').split(/\r?\n/)) {
    let rest = rawLine.trim();
    if (!rest) continue;

    // 行首可能有连续的元数据标签（如 [ti:..][ar:..]歌词正文），先剥掉
    let metaMatch: RegExpMatchArray | null;
    while ((metaMatch = rest.match(META_TAG))) {
      if (metaMatch[1]!.toLowerCase() === 'offset') {
        const v = Number(metaMatch[2]);
        if (Number.isFinite(v)) offset = v;
      } else if (metaMatch[2]!.trim()) {
        meta.push(metaMatch[0].trim());
      }
      rest = rest.slice(metaMatch[0].length).trim();
      if (!rest) break;
    }
    if (!rest) continue;

    // 收集行首的（可能多个）时间标签。⚠️ 不能用 TIME_TAG.lastIndex 切文本：
    // 全局正则 exec 到头返回 null 时 lastIndex 会被自动归零（实测踩过），
    // 必须显式记录"已消费到的位置"。时间标签必须从行首**连续**排列。
    let tagEnd = 0;
    const times: number[] = [];
    TIME_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TIME_TAG.exec(rest)) && m.index === tagEnd) {
      const ms = tagToMs(m[1]!, m[2]!, m[3]);
      if (ms === null) break;
      times.push(ms);
      tagEnd = m.index + m[0].length;
    }
    if (times.length === 0) {
      // 没有时间戳的散行：不当歌词行，格式化后进 meta（纯占位符除外）
      const cleanedMeta = cleanLyricText(rest);
      if (cleanedMeta) meta.push(cleanedMeta);
      continue;
    }

    const rawText = rest.slice(tagEnd).trim();
    const text = cleanLyricText(rawText);
    if (!text) continue; // 纯占位符（如 [00:01.00]//）不入歌词行
    for (const t of times) {
      lines.push({ time: t, text });
    }
  }

  // 应用全局 offset（正值 = 歌词提前）。最后统一减，避免逐行误差
  const shifted = lines.map(l => ({ ...l, time: Math.max(0, l.time - offset) }));
  shifted.sort((a, b) => a.time - b.time);

  return { lines: shifted, meta };
}

/** 解析一段 LRC 文本。返回按时间升序的歌词行（同时间的行保持出现顺序） */
export function parseLrc(lrc: string): LyricLine[] {
  return parseLines(lrc).lines;
}

/**
 * 解析原文 + 翻译，做**容差对齐**。
 *
 * 翻译时间戳与原文一致是常态，但不同来源会出现 ±1ms 级抖动；
 * 每条翻译只消费一次，容差取一行歌词的最短合理间隔（≤ 50ms）。
 */
export function parseLyrics(lrc: string, tlyric = ''): ParsedLyrics {
  const { lines, meta } = parseLines(lrc);

  const trans = tlyric.trim() ? parseLrc(tlyric) : [];
  if (trans.length) {
    const used = new Set<number>();
    const TRANS_TOLERANCE_MS = 50;
    for (const line of lines) {
      let bestIdx = -1;
      let bestDiff = Number.POSITIVE_INFINITY;
      for (let i = 0; i < trans.length; i++) {
        if (used.has(i)) continue;
        const diff = Math.abs(trans[i]!.time - line.time);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && bestDiff <= TRANS_TOLERANCE_MS) {
        const transText = cleanLyricText(trans[bestIdx]!.text);
        if (transText) {
          used.add(bestIdx);
          line.trans = transText;
        }
      }
    }
  }

  return { lines, meta };
}

/**
 * 当前应高亮的行下标。
 *
 * 取**最后一个 time ≤ positionMs** 的行；还没唱到第一行返回 -1
 * （UI 据此把歌词整体居中/置灰首行）。
 */
export function activeLineIndex(lines: LyricLine[], positionMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.time <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
