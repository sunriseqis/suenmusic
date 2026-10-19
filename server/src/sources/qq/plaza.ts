/**
 * QQ 音乐分类广场：官方分类树、按分类拉歌单、全部官方榜单。
 *
 * 搬运自桌面端 `src/api/qq/{category,plaza}.js`，三处改动：
 *
 * 1. **分类树直连**：浏览器端必须靠 webpack 的 `/qq-tag-api` 代理绕跨域，
 *    服务端带上 Referer 直接请求即可。
 * 2. **缓存加 TTL**：桌面端把分类树永久缓存在内存里，官方分类调整后要重启
 *    应用才看得到；服务端按 6 小时过期，无需重启。
 * 3. **不做静默降级**：桌面端分类名对不上时会退回 tagId 10000000（「全部」）
 *    并当成成功返回，用户看到的是"点进爵士却出来一堆流行歌"。现在分类解析
 *    不到就明确报错、分类树拉不到就返回 `degraded`，由客户端决定怎么提示。
 */

import { config } from '../../config.ts';
import { createLogger } from '../../logger.ts';
import { Cooldown } from '../../utils/backoff.ts';
import { BROWSER_UA, QQ_REFERER } from '../../utils/constants.ts';
import { requestJson } from '../../utils/http.ts';
import { QQ_RISK_CONTROL_CODE, qqCooldown } from './search.ts';
import { COMM_DEFAULT, requestQQMusic } from './client.ts';
import { adaptQQPlaylist, adaptQQToplist } from './adapter.ts';
import type { Playlist } from './adapter.ts';

const log = createLogger('qq:plaza');

/** 官方歌单分类配置接口。返回整棵分类树，含每个分类的 tagId。 */
const TAG_CONF_ENDPOINT =
  'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg';

/** 「全部」分类的 tagId。官方约定，不要改。 */
export const QQ_TAG_ALL = 10_000_000;

const CATEGORY_TREE_TTL_MS = 6 * 60 * 60 * 1000;

export interface QQCategory {
  name: string;
  id: number;
  /** 与该分类关联的细分标签，客户端可按需展示 */
  sorts: unknown[];
}

export interface QQCategoryGroup {
  /** 大分类名：语种 / 流派 / 主题 / 场景 … */
  bigCat: string;
  cats: QQCategory[];
}

export interface Degraded {
  code: number | null;
  message: string;
  retryAfterMs?: number;
}

export interface CategoryTreeResult {
  tree: QQCategoryGroup[];
  /** 是否来自缓存 */
  cached: boolean;
  degraded: Degraded | null;
}

interface CachedTree {
  tree: QQCategoryGroup[];
  at: number;
}

let cachedTree: CachedTree | null = null;

/** 分类树接口的独立冷却。它与 musicu 是不同域名，配额也分开。 */
const tagCooldown = new Cooldown('qq:tagconf', {
  baseMs: 30_000,
  maxMs: 10 * 60_000,
});

/**
 * 拉取 QQ 官方歌单分类树。
 *
 * 返回结构直接对应客户端 UI：
 *   [{ bigCat: '语种', cats: [{ name: '华语', id: 165, sorts: [...] }] }, ...]
 */
export async function getQQCategoryTree(): Promise<CategoryTreeResult> {
  const now = Date.now();

  if (cachedTree && now - cachedTree.at < CATEGORY_TREE_TTL_MS) {
    return { tree: cachedTree.tree, cached: true, degraded: null };
  }

  if (tagCooldown.active()) {
    return {
      tree: cachedTree?.tree ?? [],
      cached: !!cachedTree,
      degraded: {
        code: null,
        message: '分类接口暂时不可用，已进入冷却',
        retryAfterMs: tagCooldown.remainingMs(),
      },
    };
  }

  try {
    const res = await requestJson<any>(TAG_CONF_ENDPOINT, {
      headers: { Referer: QQ_REFERER, 'User-Agent': BROWSER_UA },
      query: {
        format: 'json',
        inCharset: 'utf8',
        outCharset: 'utf-8',
      },
      timeoutMs: config.upstreamTimeoutMs,
    });

    const groups = res?.data?.categories || [];
    const tree: QQCategoryGroup[] = groups
      .map((group: any) => ({
        bigCat: String(group?.categoryGroupName ?? ''),
        cats: (group?.items || [])
          .filter((item: any) => item?.categoryId !== undefined)
          .map((item: any) => ({
            name: String(item?.categoryName ?? ''),
            id: Number(item.categoryId),
            sorts: item?.allsorts || [],
          }))
          .filter((c: QQCategory) => !!c.name && Number.isFinite(c.id)),
      }))
      .filter((group: QQCategoryGroup) => group.cats.length > 0);

    if (!tree.length) {
      // 接口通了但结构不是预期的样子（改版/被反爬）。当降级处理，
      // 不要用空树覆盖掉原本可用的缓存。
      log.warn('分类树返回结构异常，未取到任何分类');
      tagCooldown.trip('分类树结构异常');
      return {
        tree: cachedTree?.tree ?? [],
        cached: !!cachedTree,
        degraded: { code: null, message: '分类接口返回异常，请稍后重试' },
      };
    }

    cachedTree = { tree, at: now };
    tagCooldown.reset();
    log.debug(`分类树已刷新：${tree.length} 个大类`);

    return { tree, cached: false, degraded: null };
  } catch (err) {
    const ms = tagCooldown.trip('分类树请求失败');
    log.warn(
      `分类树拉取失败，冷却 ${Math.round(ms / 1000)}s：${(err as Error)?.message ?? err}`
    );
    return {
      tree: cachedTree?.tree ?? [],
      cached: !!cachedTree,
      degraded: {
        code: null,
        message: '分类接口暂时不可用，请稍后重试',
        retryAfterMs: tagCooldown.remainingMs(),
      },
    };
  }
}

/** 按分类名查 tagId。查不到返回 null —— 由调用方决定报错还是提示。 */
export function findCategoryId(
  tree: QQCategoryGroup[],
  name: string
): number | null {
  for (const group of tree) {
    for (const cat of group.cats) {
      if (cat.name === name) return cat.id;
    }
  }
  return null;
}

export interface PlazaResult {
  tagId: number;
  page: number;
  pageSize: number;
  playlists: Playlist[];
  total: number;
  hasMore: boolean;
  degraded: Degraded | null;
}

/**
 * 分页拉取某个分类下的官方歌单。
 *
 * @param tagId 官方 tagId，必须由 `getQQCategoryTree()` 得到
 * @param page  页码，从 1 开始
 */
export async function getQQPlaylistsByCategory(
  tagId: number = QQ_TAG_ALL,
  page = 1,
  pageSize = 30
): Promise<PlazaResult> {
  const base: PlazaResult = {
    tagId,
    page,
    pageSize,
    playlists: [],
    total: 0,
    hasMore: false,
    degraded: null,
  };

  if (qqCooldown.active()) {
    const snap = qqCooldown.snapshot();
    return {
      ...base,
      degraded: {
        code: QQ_RISK_CONTROL_CODE,
        message: `QQ 音乐被限流，请在 ${Math.ceil(snap.remainingMs / 1000)} 秒后重试`,
        retryAfterMs: snap.remainingMs,
      },
    };
  }

  try {
    const res = await requestQQMusic<any>(
      {
        playlist: {
          module: 'playlist.PlayListPlazaServer',
          method: 'get_playlist_by_tag',
          param: {
            id: tagId,
            curPage: page,
            size: pageSize,
            order: 5, // 最热
          },
        },
      },
      COMM_DEFAULT
    );

    const code = Number(res?.playlist?.code ?? 0);
    if (code !== 0) {
      if (code === QQ_RISK_CONTROL_CODE) qqCooldown.trip('歌单广场限流 2001');
      return {
        ...base,
        degraded: {
          code,
          message: 'QQ 音乐歌单广场暂时不可用，请稍后重试',
          retryAfterMs: qqCooldown.remainingMs(),
        },
      };
    }

    qqCooldown.reset();

    const data = res?.playlist?.data || {};
    const rawPlaylists: any[] = data.v_playlist || [];
    const total = Number(data.total || 0);

    return {
      ...base,
      playlists: rawPlaylists
        .map(adaptQQPlaylist)
        .filter((x: Playlist | null): x is Playlist => x !== null),
      total,
      hasMore: page * pageSize < total,
    };
  } catch (err) {
    log.warn(`分类歌单失败 tagId=${tagId} page=${page}: ${(err as Error)?.message ?? err}`);
    return {
      ...base,
      degraded: { code: null, message: 'QQ 音乐歌单广场请求失败，请稍后重试' },
    };
  }
}

export interface AllToplistsResult {
  list: Array<ReturnType<typeof adaptQQToplist>>;
  degraded: Degraded | null;
}

/** 全部官方榜单（巅峰榜 / 地区榜 / 特色榜 / 全球榜，共 30 个） */
export async function getQQAllToplists(): Promise<AllToplistsResult> {
  if (qqCooldown.active()) {
    const snap = qqCooldown.snapshot();
    return {
      list: [],
      degraded: {
        code: QQ_RISK_CONTROL_CODE,
        message: `QQ 音乐被限流，请在 ${Math.ceil(snap.remainingMs / 1000)} 秒后重试`,
        retryAfterMs: snap.remainingMs,
      },
    };
  }

  try {
    const res = await requestQQMusic<any>(
      {
        toplist: {
          module: 'musicToplist.ToplistInfoServer',
          method: 'GetAll',
          param: {},
        },
      },
      COMM_DEFAULT
    );

    const code = Number(res?.toplist?.code ?? 0);
    if (code !== 0) {
      if (code === QQ_RISK_CONTROL_CODE) qqCooldown.trip('榜单列表限流 2001');
      return {
        list: [],
        degraded: {
          code,
          message: 'QQ 音乐榜单暂时不可用，请稍后重试',
          retryAfterMs: qqCooldown.remainingMs(),
        },
      };
    }

    qqCooldown.reset();

    const list: Array<ReturnType<typeof adaptQQToplist>> = [];
    for (const group of res?.toplist?.data?.group || []) {
      for (const item of group?.toplist || []) {
        list.push(adaptQQToplist(item));
      }
    }

    return { list, degraded: null };
  } catch (err) {
    log.warn(`榜单列表失败: ${(err as Error)?.message ?? err}`);
    return {
      list: [],
      degraded: { code: null, message: 'QQ 音乐榜单请求失败，请稍后重试' },
    };
  }
}
