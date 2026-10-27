/**
 * 路由键解析。
 *
 * 项目约定（与桌面端保持一致，不要改）：
 *
 * | 前缀         | 含义   | 值        |
 * | ------------ | ------ | --------- |
 * | `qq_`        | 单曲   | songMid   |
 * | `qq_al_`     | 专辑   | albumMid  |
 * | `qq_ar_`     | 歌手   | singerMid |
 * | `qq_pl_`     | 歌单   | disstid   |
 * | `qq_top_`    | 榜单   | topId     |
 *
 * **必须用 mid 而不是 QQ 返回的数字 id**：数字 id 是网易云的形状，
 * 前端历史上正是把数字 id 拼进路由才打到网易云接口。mid 是 QQ 的稳定标识。
 *
 * 解析时先匹配长前缀（`qq_al_` 等），否则 `qq_al_xxx` 会被 `qq_` 抢先吃掉。
 */

export type EntityKind = 'track' | 'album' | 'artist' | 'playlist' | 'toplist';

/** 路由键来源。多源聚合后同一首歌可能来自不同上游，取流链要据此分流 */
export type IdSource = 'qq' | 'kg' | 'ne';

export interface ParsedId {
  kind: EntityKind;
  /** 来源源（qq / kg 酷狗 / ne 网易云）。默认 qq —— 历史数据全是 qq_ 前缀 */
  source: IdSource;
  /** 去掉前缀后的原始标识：歌/专辑/歌手的 mid，歌单与榜单的数字 id */
  value: string;
  /** 原样传回的路由键 */
  raw: string;
}

/**
 * 顺序敏感：长前缀必须排在短前缀之前（否则 `kg_al_x` 会被 `kg_` 抢先吃掉）。
 * 多源聚合后新增 `kg_`（酷狗）与 `ne_`（网易云）两套前缀；`qq_` 保持原状兼容历史数据。
 */
const PREFIXES: Array<[string, EntityKind, IdSource]> = [
  ['qq_al_', 'album', 'qq'],
  ['qq_ar_', 'artist', 'qq'],
  ['qq_pl_', 'playlist', 'qq'],
  ['qq_top_', 'toplist', 'qq'],
  ['qq_', 'track', 'qq'],
  ['kg_al_', 'album', 'kg'],
  ['kg_ar_', 'artist', 'kg'],
  ['kg_', 'track', 'kg'],
  ['ne_al_', 'album', 'ne'],
  ['ne_ar_', 'artist', 'ne'],
  ['ne_pl_', 'playlist', 'ne'],
  ['ne_', 'track', 'ne'],
];

export function parseId(raw: string | undefined): ParsedId | null {
  if (!raw || typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  for (const [prefix, kind, source] of PREFIXES) {
    if (value.startsWith(prefix)) {
      const rest = value.slice(prefix.length);
      if (!rest) return null;
      return { kind, source, value: rest, raw: value };
    }
  }

  return null;
}

/**
 * 宽松解析：允许调用方只给裸 mid。
 *
 * 专辑与歌手的 mid 是 14 位左右的字母数字串，单独看无法区分类型，
 * 所以只用在"这个端点已经知道类型"的场景（如 `/api/albums/:mid`）。
 */
export function parseIdWithFallback(
  raw: string | undefined,
  fallbackKind: EntityKind
): ParsedId | null {
  const parsed = parseId(raw);
  if (parsed) return parsed;
  if (!raw || !raw.trim()) return null;

  const value = raw.trim();
  // 纯数字：只可能是歌单或榜单
  if (/^\d+$/.test(value)) {
    return {
      kind: fallbackKind === 'playlist' || fallbackKind === 'toplist' ? fallbackKind : 'playlist',
      source: 'qq',
      value,
      raw: value,
    };
  }

  // 裸 mid 默认按 QQ（历史行为：`/api/albums/:mid` 这类端点只用 bare mid）
  return { kind: fallbackKind, source: 'qq', value, raw: value };
}

export function trackId(mid: string): string {
  return `qq_${mid}`;
}

export function albumId(mid: string): string {
  return `qq_al_${mid}`;
}

export function artistId(mid: string): string {
  return `qq_ar_${mid}`;
}
