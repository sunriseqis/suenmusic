/**
 * 不喜欢（黑名单）store —— 本地优先。
 *
 * 单曲/歌手黑名单是"减少打扰"的偏好，断了网也必须生效：用户在车上点了
 * "不再推荐这位歌手"，回家连上网之前不该又冒出来。所以和收藏一样，
 * 本地是真相源，服务端只是备份。
 *
 * 对外暴露的条目形状沿用 `api/recommend.ts` 的 `DislikeItem`，
 * 这样设置页的列表渲染不用改。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  addDislike as addDislikeRemote,
  fetchDislikes,
  removeDislike as removeDislikeRemote,
  type DislikeItem,
  type DislikeType,
} from '@/api/recommend.ts';
import { serverReady } from '@/offline/syncMode.ts';
import {
  listDislikes,
  removeDislike as removeLocalDislike,
  saveDislike,
} from '@/offline/localdb.ts';

export const useDislikesStore = defineStore('dislikes', () => {
  const items = ref<DislikeItem[]>([]);
  const loaded = ref(false);

  let loadingPromise: Promise<void> | null = null;

  const trackItems = computed(() => items.value.filter(d => d.type === 'track'));
  const artistItems = computed(() => items.value.filter(d => d.type === 'artist'));

  /** 某首歌或某位歌手是否在黑名单里 */
  function has(type: DislikeType, id: string): boolean {
    return items.value.some(d => d.type === type && d.targetId === id);
  }

  async function hydrate(): Promise<void> {
    const rows = await listDislikes();
    items.value = rows.map(r => ({
      type: r.type,
      targetId: r.id,
      name: r.name,
      createdAt: r.addedAt,
    }));
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

  async function add(type: DislikeType, id: string, name = ''): Promise<void> {
    await saveDislike(type, id, name);
    items.value = [
      { type, targetId: id, name, createdAt: Date.now() },
      ...items.value.filter(d => !(d.type === type && d.targetId === id)),
    ];
    if (serverReady()) {
      void addDislikeRemote(type, id, name).catch(() => {});
    }
  }

  async function remove(type: DislikeType, id: string): Promise<void> {
    await removeLocalDislike(type, id);
    items.value = items.value.filter(d => !(d.type === type && d.targetId === id));
    if (serverReady()) {
      void removeDislikeRemote(type, id).catch(() => {});
    }
  }

  /** 与服务端对账：并集合并，本地独有的推上去。删除靠显式动作当场推 */
  async function syncFromServer(): Promise<void> {
    if (!serverReady()) return;
    try {
      const res = await fetchDislikes();
      const localKeys = new Set(items.value.map(d => `${d.type}:${d.targetId}`));
      const remoteKeys = new Set(res.dislikes.map(d => `${d.type}:${d.targetId}`));

      const missingLocally = res.dislikes.filter(
        d => !localKeys.has(`${d.type}:${d.targetId}`)
      );
      for (const d of missingLocally) {
        await saveDislike(d.type, d.targetId, d.name, d.createdAt);
      }

      for (const d of items.value) {
        if (!remoteKeys.has(`${d.type}:${d.targetId}`)) {
          void addDislikeRemote(d.type, d.targetId, d.name).catch(() => {});
        }
      }

      if (missingLocally.length > 0) await hydrate();
    } catch {
      /* 对账失败保持本地现状 */
    }
  }

  /** 退出登录：只放下内存视图，本地黑名单保留（属于这台设备） */
  function reset(): void {
    items.value = [];
    loaded.value = false;
    loadingPromise = null;
  }

  return {
    items,
    loaded,
    trackItems,
    artistItems,
    has,
    hydrate,
    ensureLoaded,
    add,
    remove,
    syncFromServer,
    reset,
  };
});
