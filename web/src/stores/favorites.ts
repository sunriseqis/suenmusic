/**
 * 收藏 store（**本地优先**）。
 *
 * 直连架构下收藏是本机的主数据：
 *
 *   读 → 只读 IndexedDB（毫秒级，断网照样有）
 *   写 → 先落本地，**再**尽力推一份到服务端（配了服务器且已登录时）
 *
 * 这与旧实现的区别是根本性的：旧版是"乐观更新 + 失败回滚"，因为服务端是
 * 唯一真相源；现在本地就是真相源，网络失败**不回滚**（回滚等于把用户
 * 刚点的红心撤销，只因为网不好）。服务端那份是备份，迟一点到不影响。
 *
 * `reset()` 也不再清数据 —— 退出登录只是断开同步，不该把设备上的收藏删掉。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  addFavorite,
  batchAddFavorites,
  fetchFavorites,
  removeFavorite,
} from '@/api/library.ts';
import { serverReady } from '@/offline/syncMode.ts';
import {
  listFavorites,
  removeFavorite as removeLocalFavorite,
  saveFavorite,
  type LocalFavorite,
} from '@/offline/localdb.ts';
import type { Track } from '@/api/types.ts';

/** 单页条数。服务端对该参数有上限校验，100 是安全值 */
const PAGE_SIZE = 100;

/** 拉全集的页数上限。家庭级使用到不了这个量，纯粹防御上游异常导致的死循环 */
const MAX_PAGES = 50;

export const useFavoritesStore = defineStore('favorites', () => {
  /** 已收藏曲目 id 集合。Vue 3 的响应式系统原生支持 Set 的增删追踪 */
  const ids = ref<Set<string>>(new Set());

  /** 本地收藏总数 */
  const total = ref(0);

  /** 是否已从本地读过一次 */
  const loaded = ref(false);

  /** 曲目快照，按加入时间倒序。收藏页直接用它渲染，不用再查一遍 */
  const rows = ref<LocalFavorite[]>([]);

  /** 读取中的标记，防止并发触发多轮读取 */
  let loadingPromise: Promise<void> | null = null;

  /** 同一首的 toggle 不允许并发（连点两下会算出相反的结果） */
  const pending = new Set<string>();

  const count = computed(() => ids.value.size);

  function contains(id: string): boolean {
    return ids.value.has(id);
  }

  /** 从本地重读。启动、切回前台、以及写完之后都可以调 */
  async function hydrate(): Promise<void> {
    const list = await listFavorites();
    rows.value = list;
    ids.value = new Set(list.map(r => r.id));
    total.value = list.length;
    loaded.value = true;
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return;
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      try {
        await hydrate();
      } finally {
        loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  /**
   * 与服务端对一次账（只在配了服务器且已登录时调用）。
   *
   * 合并策略是**并集**：服务端有、本地没有的补进来；本地有、服务端没有的推上去。
   * 删除不在这里处理 —— 删除是显式动作，靠 `toggle` 当场推。
   * 这样两台设备交替离线使用也不会互相抹掉对方的收藏。
   */
  async function syncFromServer(): Promise<void> {
    if (!serverReady()) return;
    try {
      const acc: LocalFavorite[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await fetchFavorites({ limit: PAGE_SIZE, cursor });
        for (const item of res.items) {
          if (item.trackId) {
            acc.push({ id: item.trackId, track: item.track ?? undefined, addedAt: item.createdAt });
          }
        }
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }

      const localIds = new Set(rows.value.map(r => r.id));
      const remoteIds = new Set(acc.map(r => r.id));

      const missingLocally = acc.filter(r => !localIds.has(r.id) && r.track);
      for (const row of missingLocally) {
        await saveFavorite(row.track as Track, row.addedAt);
      }

      const missingRemotely = rows.value.filter(r => !remoteIds.has(r.id) && r.track);
      for (const row of missingRemotely) {
        // 推上去的是"本地有、服务端没有"，失败无所谓（下次还会再对）
        void addFavorite(row.id, row.track).catch(() => {});
      }

      if (missingLocally.length > 0) await hydrate();
    } catch {
      /* 对账失败保持本地现状 —— 本地数据本来就是完整的 */
    }
  }

  /**
   * 切换收藏状态。
   *
   * 本地立即生效，不等网络。返回切换后的状态（true = 已收藏）。
   * 同一曲目已有切换在途时直接返回当前状态：连点的期望结果本来就是只变一次。
   */
  async function toggle(track: Track): Promise<boolean> {
    const id = track.id;
    if (pending.has(id)) return ids.value.has(id);
    pending.add(id);

    const wasFav = ids.value.has(id);

    // 先改本地（真相源）
    if (wasFav) {
      ids.value.delete(id);
      total.value = Math.max(0, total.value - 1);
      rows.value = rows.value.filter(r => r.id !== id);
    } else {
      ids.value.add(id);
      total.value += 1;
      rows.value = [{ id, track, addedAt: Date.now() }, ...rows.value];
    }

    try {
      if (wasFav) {
        await removeLocalFavorite(id);
      } else {
        await saveFavorite(track);
      }
    } finally {
      pending.delete(id);
    }

    // 再尽力推服务端（失败不影响本地结果）
    if (serverReady()) {
      if (wasFav) {
        void removeFavorite(id).catch(() => {});
      } else {
        void addFavorite(id, track).catch(() => {});
      }
    }

    return !wasFav;
  }

  /**
   * 批量收藏（"收藏全部"）。
   * @returns 新增收藏数
   */
  async function batchAdd(trackList: Track[]): Promise<number> {
    if (trackList.length === 0) return 0;

    const newTracks = trackList.filter(t => !ids.value.has(t.id));
    if (newTracks.length === 0) return 0;

    const now = Date.now();
    for (const t of newTracks) {
      await saveFavorite(t, now);
    }
    await hydrate();

    if (serverReady()) {
      void batchAddFavorites(newTracks).catch(() => {});
    }

    return newTracks.length;
  }

  /**
   * 退出登录时的收尾。
   *
   * **不清本地数据**：收藏属于这台设备，不属于某个服务端账号。
   * 只把内存视图放下，下次用到时重新从本地读。
   */
  function reset(): void {
    ids.value = new Set();
    rows.value = [];
    total.value = 0;
    loaded.value = false;
    loadingPromise = null;
  }

  return {
    ids,
    rows,
    total,
    loaded,
    count,
    contains,
    hydrate,
    ensureLoaded,
    syncFromServer,
    toggle,
    batchAdd,
    reset,
  };
});
