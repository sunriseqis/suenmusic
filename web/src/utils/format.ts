import { coverSrc } from '@/offline/covers.ts';
/**
 * 展示层格式化工具。
 */

/**
 * 毫秒 → `m:ss` 或 `h:mm:ss`。
 *
 * 时长一律**向下取整到秒**：进度条从 0:00 跳到 0:01 比显示 0:00.7 再跳
 * 更符合直觉，也是所有播放器的通行做法。
 *
 * 负数与非有限值一律显示 `0:00` —— 流式响应下 duration 可能是 Infinity。
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '0:00';

  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hour = Math.floor(totalSec / 3600);

  const pad = (n: number) => String(n).padStart(2, '0');
  return hour > 0 ? `${hour}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
}

/** 播放量：1234 → `1234`，12345 → `1.2万`，过亿 → `1.2亿` */
export function formatCount(n: number | null | undefined): string {
  if (!n || !Number.isFinite(n) || n <= 0) return '0';
  if (n < 10_000) return String(Math.floor(n));
  if (n < 100_000_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
}

/** 毫秒时间戳 → `2026-09-11 10:30` */
export function formatDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 天前 */
export function formatRelative(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(ts).slice(0, 10);
}

/** 把曲目的歌手数组拼成一行 */
export function artistNames(
  artists: Array<{ name?: string } | undefined> | undefined | null,
  fallback = '未知歌手'
): string {
  if (!artists || artists.length === 0) return fallback;
  const names = artists.map(a => a?.name).filter((n): n is string => !!n);
  return names.length > 0 ? names.join(' / ') : fallback;
}

/**
 * 从 QQ 图床地址推断合适的尺寸档。
 *
 * 图床按路径前缀分档（见 server 侧适配器注释）：
 *   T001 歌手 / T002 专辑 → 150/300/500/800
 *   T003 榜单与歌单 → **最高只到 500，800 必 404**
 *   T015 MV 封面 → 固定 640x360，不能改写
 *
 * 直接对任意地址套 800 会拿到 404 的破图，所以必须先判断前缀。
 */
export function coverUrl(url: string | undefined | null, size: 150 | 300 | 500 | 800 = 300): string {
  if (!url) return '';

  // 自带签名 query 的图床再拼参数会失效，原样返回
  if (url.includes('?')) return coverSrc(url);
  // MV 封面尺寸固定，不要动
  if (url.includes('T015')) return coverSrc(url);

  // T003（榜单/歌单）不支持 800
  const effective = url.includes('T003') && size === 800 ? 500 : size;
  // 尺寸处理完再过本地缓存：离线时返回原生落盘的本地文件 URL
  return coverSrc(url.replace(/R\d+x\d+M000/, `R${effective}x${effective}M000`));
}

/**
 * 清洗 AI 生成文案中的 Markdown 标记与标题符号。
 * 彻底过滤 #、##、*、**、`、> 等符号，保证界面标题与文案干净纯粹。
 */
export function cleanAiText(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw);

  // 0. 去除模型/网关安全检查与元数据残留（如 "User Safety: safe", "[Safety: safe]" 等）
  s = s.replace(
    /(?:\[|【)?\b(?:user\s+|content\s+|system\s+)?safety(?:\s+(?:assessment|rating|check|status|result))?\s*[:：]\s*(?:safe|pass|ok|clean|neutral|none|true|false)\b[\s,，;；、\-—]*\]?】?/gi,
    ' '
  );

  // 1. 去除代码块与反引号代码：```...``` 或 `...`
  s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1');

  // 2. 去除各级 Markdown 标题符号：#、##、### 等
  s = s.replace(/(?:^|\n)\s*#+\s*/g, ' ');
  s = s.replace(/#+/g, '');

  // 3. 去除粗体、斜体、删除线：**text**、*text*、__text__、~~text~~
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/_([^_]+)_/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');

  // 4. 去除引用符号 > 和列表标记 - 或 * 或 1.
  s = s.replace(/(?:^|\n)\s*>\s*/g, ' ');
  s = s.replace(/(?:^|\n)\s*[-*+]\s+/g, ' ');

  // 5. 去除多余引号，规范连续空白
  s = s.replace(/["“”'‘’]/g, '').replace(/\s+/g, ' ').trim();

  // 6. 去除开头可能残留的孤立无意义标点（如因剔除安全前缀后留下的逗号、冒号、空格等）
  s = s.replace(/^[，,：:;；、\-—\s]+/, '').trim();

  return s;
}

/**
 * 解析 AI 标语/导语：以首个逗号切分为主标题（<=8字符）和副标题小字。
 * - 自动滤除前导 Markdown 标题符号（#、## 等）与风控元数据（User Safety: safe 等）
 * - 存在逗号且第一段在 2~10 字符之间时：第一段为主标题，后续作为副标题小字；
 * - 无逗号且整句 <= 8 字符时：整句直接作为主标题；
 * - 长文本无逗号或不符合拆分条件时：以默认页面名为主标题，整句作为副标题小字。
 */
export function parseAiHeader(
  rawText: string | null | undefined,
  defaultTitle: string
): { title: string; sub: string } {
  const text = cleanAiText(rawText);
  if (!text) {
    return { title: defaultTitle, sub: '' };
  }
  const commaIdx = text.search(/[，,\n]/);
  if (commaIdx > 0) {
    const head = text.slice(0, commaIdx).trim();
    const tail = text.slice(commaIdx + 1).trim().replace(/^[，,\s]+/, '');
    // 严格防御任何漏网的英文安全/风控标签作为主标题展示
    if (/safety|system|assistant/i.test(head)) {
      return { title: defaultTitle, sub: tail };
    }
    if (head.length >= 2 && head.length <= 10 && tail.length > 0) {
      return { title: head, sub: tail };
    }
  }
  if (text.length <= 8 && !/safety/i.test(text)) {
    return { title: text, sub: '' };
  }
  return { title: defaultTitle, sub: text };
}

