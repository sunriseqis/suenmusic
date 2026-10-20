/**
 * 不喜欢（黑名单）store。
 *
 * 服务端为单一真相源，乐观更新 + 失败回滚。
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

  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return;
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      try {
        const res = await fetchDislikes();
        items.value = res.dislikes;
        loaded.value = true;
      } catch {
        /* 静默失败 */
      } finally {
        loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function add(type: DislikeType, id: string, name = ''): Promise<void> {
    const prev = [...items.value];
    items.value = [
      { type, targetId: id, name, createdAt: Date.now() },
      ...items.value.filter(d => !(d.type === type && d.targetId === id)),
    ];
    try {
      await addDislikeRemote(type, id, name);
    } catch (e) {
      items.value = prev;
      throw e;
    }
  }

  async function remove(type: DislikeType, id: string): Promise<void> {
    const prev = [...items.value];
    items.value = items.value.filter(d => !(d.type === type && d.targetId === id));
    try {
      await removeDislikeRemote(type, id);
    } catch (e) {
      items.value = prev;
      throw e;
    }
  }

  /** 强制从服务端重新拉取（如导入备份后） */
  async function reload(): Promise<void> {
    loaded.value = false;
    loadingPromise = null;
    return ensureLoaded();
  }

  /** 退出登录：清空内存视图 */
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
    ensureLoaded,
    reload,
    add,
    remove,
    reset,
  };
});
