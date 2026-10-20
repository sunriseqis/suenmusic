/**
 * 收藏 store。
 *
 * 职责只有一个：维护"哪些曲目已收藏"的**全局一致视图**，让红心状态在
 * 曲目行 / 播放条 / 收藏页之间不需要各自请求就能对齐。
 *
 * 设计要点：
 * - id 集合一次拉全（分页循环），之后 `contains` 全走内存，不逐行发请求
 * - `toggle` 是**乐观更新**：先改本地集合再发请求，失败回滚 ——
 *   红心是即时反馈型交互，等往返一次再变色会让人觉得"点了没反应"
 * - 收藏数据属于账号：退出登录必须 `reset()`，否则下一个人会看见
 *   上一个人的红心（与 player.reset 同理）
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  addFavorite,
  batchAddFavorites,
  checkFavorites,
  fetchFavorites,
  removeFavorite,
} from '@/api/library.ts';
import type { Track } from '@/api/types.ts';

/** 单页条数。服务端对该参数有上限校验，100 是安全值 */
const PAGE_SIZE = 100;

/** 拉全集的页数上限。家庭级使用到不了这个量，纯粹防御上游异常导致的死循环 */
const MAX_PAGES = 50;

/**
 * 把某首曲目的收藏状态报给鸿蒙原生（AVSession / 桌面卡片显示红心）。
 *
 * 原生侧拿 assetId 对比当前曲目，不是当前曲目就直接忽略 —— 所以这里
 * 不用关心"切的这首是不是正在播的"。Web 环境没有 SuenHarmony 时静默。
 */
function reportHarmonyFavorite(assetId: string, favorite: boolean): void {
  if (typeof window === 'undefined' || !window.SuenHarmony?.updateFavorite) return;
  try {
    window.SuenHarmony.updateFavorite(JSON.stringify({ assetId, favorite }));
  } catch {
    /* ignore */
  }
}

export const useFavoritesStore = defineStore('favorites', () => {
  /** 已收藏曲目 id 集合。Vue 3 的响应式系统原生支持 Set 的增删追踪 */
  const ids = ref<Set<string>>(new Set());

  /** 服务端记录的收藏总数。与 ids.size 应当一致，不一致说明集合还没拉全 */
  const total = ref(0);

  /** 集合是否已经完整拉过一次（含拉到空）。登录后首次用到才拉 */
  const loaded = ref(false);

  /** 拉取中的标记，防止并发触发多轮全量拉取 */
  let loadingPromise: Promise<void> | null = null;

  /**
   * 切换在途的曲目 id。
   *
   * 同一首的 `toggle` 不允许并发：乐观更新是"先改本地再发请求"，
   * 两个请求同时在飞时，后回来的失败回滚会把前一个的成功结果抹掉
   * （红心自己跳回去）。滑动收藏连点两下就能触发，所以必须有这层锁。
   * 非响应式 —— 它只用于门禁，不参与渲染。
   */
  const pending = new Set<string>();

  const count = computed(() => ids.value.size);

  function contains(id: string): boolean {
    return ids.value.has(id);
  }

  /**
   * 确保 id 集合已就绪。
   *
   * 已加载过就直接返回；否则从第一页开始把游标走完。
   * 批量校验接口（`/api/favorites/check`）作为兜底：若拉全量时上游失败，
   * 至少把调用方关心的那几个 id 的真实状态补进来。
   */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
      try {
        const acc = new Set<string>();
        let cursor: string | null = null;
        let totalCount = 0;

        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await fetchFavorites({ limit: PAGE_SIZE, cursor });
          totalCount = res.total;
          for (const item of res.items) acc.add(item.track?.id ?? item.trackId);
          if (!res.nextCursor) break;
          cursor = res.nextCursor;
        }

        ids.value = acc;
        total.value = totalCount;
        loaded.value = true;
      } finally {
        loadingPromise = null;
      }
    })();

    return loadingPromise;
  }

  /**
   * 兜底校验：向服务端确认这几个 id 的真实收藏状态并合入本地集合。
   * 供"集合还没拉全就要渲染红心"的调用方使用。
   */
  async function syncIds(list: string[]): Promise<void> {
    const targets = list.filter(id => id && !loaded.value);
    if (targets.length === 0) return;
    try {
      const res = await checkFavorites(targets);
      for (const [id, fav] of Object.entries(res.favorites)) {
        if (fav) ids.value.add(id);
        else ids.value.delete(id);
      }
    } catch {
      /* 校验失败保持本地现状 —— 红心是显示层，不值得为它报错 */
    }
  }

  /**
   * 切换收藏状态。
   *
   * @param track 完整曲目。带上它服务端会把快照写进缓存表，
   *   收藏页才能直接显示歌名与封面（否则列表只有 id）
   * @returns 切换后的收藏状态（true = 已收藏）
   *
   * 同一曲目已有切换在途时**直接返回当前状态**：既不发第二个请求，
   * 也不做第二次乐观更新 —— 连点的期望结果本来就是"最终只有一次变化"。
   */
  async function toggle(track: Track): Promise<boolean> {
    const id = track.id;
    if (pending.has(id)) return ids.value.has(id);
    pending.add(id);

    const wasFav = ids.value.has(id);

    // 乐观更新：先改本地，失败回滚
    if (wasFav) {
      ids.value.delete(id);
      total.value = Math.max(0, total.value - 1);
    } else {
      ids.value.add(id);
      total.value += 1;
    }

    try {
      if (wasFav) {
        await removeFavorite(id);
      } else {
        await addFavorite(id, track);
      }
      return !wasFav;
    } catch (e) {
      // 回滚到操作前的状态
      if (wasFav) {
        ids.value.add(id);
        total.value += 1;
      } else {
        ids.value.delete(id);
        total.value = Math.max(0, total.value - 1);
      }
      throw e;
    } finally {
      pending.delete(id);
      // 成功与回滚都要报：以本地集合的最终状态为准，原生侧只认 assetId 匹配的
      reportHarmonyFavorite(id, ids.value.has(id));
    }
  }

  /**
   * 批量收藏。
   *
   * 用于"收藏全部"场景：一次性把列表中所有曲目加入收藏。
   * 乐观更新：先把所有 id 加入本地集合，请求失败回滚。
   * @returns 新增收藏数
   */
  async function batchAdd(trackList: Track[]): Promise<number> {
    if (trackList.length === 0) return 0;

    // 只收藏尚未收藏的
    const newTracks = trackList.filter(t => !ids.value.has(t.id));
    if (newTracks.length === 0) return 0;

    // 乐观更新
    const newIds = newTracks.map(t => t.id);
    for (const id of newIds) ids.value.add(id);
    total.value += newIds.length;

    // 整批占住这些 id：批量在飞时对同一首滑动（"收藏全部"后立刻划掉一首）
    // 会被 toggle 的在途锁挡掉，避免两个请求互相覆盖、本地集合与服务端分叉
    const claimed = newIds.filter(id => !pending.has(id));
    for (const id of claimed) pending.add(id);

    try {
      const res = await batchAddFavorites(newTracks);
      // 以服务端返回的实际新增数为准
      total.value = res.total;
      return res.added;
    } catch (e) {
      // 回滚
      for (const id of newIds) ids.value.delete(id);
      total.value = Math.max(0, total.value - newIds.length);
      throw e;
    } finally {
      for (const id of claimed) pending.delete(id);
    }
  }

  /** 退出登录时清空。收藏数据属于账号，不能留给下一个用户 */
  function reset(): void {
    ids.value = new Set();
    total.value = 0;
    loaded.value = false;
    loadingPromise = null;
  }

  async function reload(): Promise<void> {
    reset();
    await ensureLoaded();
  }

  return {
    ids,
    total,
    loaded,
    count,
    contains,
    ensureLoaded,
    reload,
    syncIds,
    toggle,
    batchAdd,
    reset,
  };
});
