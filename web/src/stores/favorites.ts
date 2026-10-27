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
import { isNativeAudio, SuenAudio } from '@/native/audio.ts';

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

/**
 * 安卓桌面卡片（小组件）的收藏图标同步。
 * 与鸿蒙的 updateFavorite 同一时机：本地集合最终态为准。
 * 卡片不做乐观切换（切换要过服务端），所以这里失败静默即可。
 */
async function reportWidgetFavorite(assetId: string, favorite: boolean): Promise<void> {
  if (!isNativeAudio) return;
  try {
    await SuenAudio.setWidgetFavorite({ trackId: assetId, favorite });
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

  /**
   * 「歌名 + 歌手」指纹集合。
   *
   * 为什么需要：多源之后同一首歌可能是 `qq_...`、`kg_...`、`ne_...` —— 用户收藏的是
   * qq_ 那条，搜索返回 kg_ 那条，仅按 id 比对就显示成「未收藏」（红心不亮、序号不变色）。
   * 收藏去重本身也是按「歌名+主歌手」判的（routes/favorites.ts），所以这里用同一口径。
   */
  const keys = ref<Set<string>>(new Set());

  function trackKey(track: { name?: string; ar?: Array<{ name?: string }> }): string {
    const name = String(track?.name ?? '').trim().toLowerCase();
    const artists = (track?.ar ?? [])
      .map(a => String(a?.name ?? '').trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join('/');
    return name && artists ? `${name}|${artists}` : '';
  }

  function contains(id: string): boolean {
    return ids.value.has(id);
  }

  /** 跨源友好的收藏判断：先按 id，再按「歌名+歌手」指纹 */
  function containsTrack(track: { id?: string; name?: string; ar?: Array<{ name?: string }> }): boolean {
    if (track?.id && ids.value.has(track.id)) return true;
    const k = trackKey(track);
    return k !== '' && keys.value.has(k);
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
        const accKeys = new Set<string>();
        let cursor: string | null = null;
        let totalCount = 0;

        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await fetchFavorites({ limit: PAGE_SIZE, cursor });
          totalCount = res.total;
          for (const item of res.items) {
            acc.add(item.track?.id ?? item.trackId);
            const k = trackKey(item.track ?? {});
            if (k) accKeys.add(k);
          }
          if (!res.nextCursor) break;
          cursor = res.nextCursor;
        }

        ids.value = acc;
        keys.value = accKeys;
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
    const k = trackKey(track);
    if (pending.has(id)) return containsTrack(track);
    pending.add(id);

    const wasFav = containsTrack(track);

    // 乐观更新：先改本地，失败回滚
    if (wasFav) {
      ids.value.delete(id);
      if (k) keys.value.delete(k);
      total.value = Math.max(0, total.value - 1);
    } else {
      ids.value.add(id);
      if (k) keys.value.add(k);
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
        if (k) keys.value.add(k);
        total.value += 1;
      } else {
        ids.value.delete(id);
        if (k) keys.value.delete(k);
        total.value = Math.max(0, total.value - 1);
      }
      throw e;
    } finally {
      pending.delete(id);
      // 成功与回滚都要报：以本地集合的最终状态为准，原生侧只认 assetId 匹配的
      const finalFav = containsTrack(track);
      reportHarmonyFavorite(id, finalFav);
      void reportWidgetFavorite(id, finalFav);
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
    const newTracks = trackList.filter(t => !containsTrack(t));
    if (newTracks.length === 0) return 0;

    // 乐观更新
    const newIds = newTracks.map(t => t.id);
    const newKeys = newTracks.map(t => trackKey(t)).filter(Boolean);
    for (const id of newIds) ids.value.add(id);
    for (const k of newKeys) keys.value.add(k);
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
      for (const k of newKeys) keys.value.delete(k);
      total.value = Math.max(0, total.value - newIds.length);
      throw e;
    } finally {
      for (const id of claimed) pending.delete(id);
    }
  }

  /** 退出登录时清空。收藏数据属于账号，不能留给下一个用户 */
  function reset(): void {
    ids.value = new Set();
    keys.value = new Set();
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
    containsTrack,
    ensureLoaded,
    reload,
    syncIds,
    toggle,
    batchAdd,
    reset,
  };
});
