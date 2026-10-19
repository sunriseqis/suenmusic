<script setup lang="ts">
/**
 * 收藏页。
 *
 * 列表数据直接走 `/api/favorites`（带曲目快照与游标分页），不走
 * favorites store —— store 只维护"哪些 id 已收藏"的红心状态，这里
 * 需要的是**完整曲目**。两份数据同源同序，互不冲突：
 *
 * - 红心取消收藏由 TrackRow 的红心按钮完成（同一 store，状态全局一致）；
 *   本页只负责**跟随**：store 的 id 集合一变，列表立即剪掉对应行。
 * - 排序以服务端返回为准（收藏时间倒序，最新的在最前）。
 * - 快照缺失的条目（track 为 null）渲染不出来，直接跳过 ——
 *   total 仍以服务端数字为准，不因为渲染问题谎报数量。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import NeuSkeleton from '@/components/neu/NeuSkeleton.vue';
import TrackRow from '@/components/TrackRow.vue';
import { fetchFavorites } from '@/api/library.ts';
import { artistNames, parseAiHeader } from '@/utils/format.ts';
import { blurActiveInput, registerBackHandler } from '@/native/back.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { serverReady } from '@/offline/syncMode.ts';
import type { Track } from '@/api/types.ts';

const favorites = useFavoritesStore();

const loading = ref(true);
const errorText = ref('');
const aiSummary = ref('');
/** true = 正在展示离线快照（连不上服务端，但本地有上次同步的数据） */

/** 已装载的收藏曲目（按服务端顺序，最新的在前）。全量装载，无游标残留 */
const items = ref<Track[]>([]);

/** store 拉全后以它为准做行级联动；没拉全（失败/进行中）就原样展示 */
const visible = computed(() =>
  favorites.loaded ? items.value.filter(t => favorites.contains(t.id)) : items.value
);

/** 搜索关键词：在已装载的收藏里本地过滤，不发请求 */
const keyword = ref('');

/**
 * 返回手势：先退出**筛选态**，而不是退出应用。
 *
 * 收藏内搜索是页面内的临时状态（它没有自己的路由，地址栏里看不出来），
 * 所以返回键的第一下天然应该把它清掉 —— 否则用户只能手动删关键词
 * （真机反馈原话）。清空的同时收键盘，一次返回把"搜索这件事"整个结束掉。
 *
 * 没有关键词时才往下让：让壳去关全屏播放页、让原生做历史后退。
 */
const offBack = registerBackHandler(() => {
  if (keyword.value) {
    keyword.value = '';
    blurActiveInput();
    return true;
  }
  return blurActiveInput();
});
onBeforeUnmount(offBack);

/** 关键词过滤后的列表（歌名 / 歌手 / 专辑名，忽略大小写） */
const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  const base = visible.value;
  if (!k) return base;
  return base.filter(t =>
    [t.name, artistNames(t.ar), t.al?.name].some(v => String(v ?? '').toLowerCase().includes(k))
  );
});

/** 标题里的总数：优先 store 的实时数字（红心增减立即反映） */
const totalLabel = computed(() => {
  if (favorites.loaded) return favorites.total;
  return items.value.length;
});

const headerInfo = computed(() => {
  if (!visible.value.length || !aiSummary.value) {
    return { title: '收藏曲目', sub: '' };
  }
  return parseAiHeader(aiSummary.value, '收藏曲目');
});
const headerTitle = computed(() => headerInfo.value.title);
const headerSub = computed(() => headerInfo.value.sub);

const isEmpty = computed(() => !loading.value && !errorText.value && visible.value.length === 0);
/** 有关键词、有收藏，但一条都没匹配上 */
const noMatch = computed(
  () => !loading.value && !errorText.value && visible.value.length > 0 && filtered.value.length === 0
);

/**
 * 装载收藏。
 *
 * 直连架构下**只读本地库** —— 收藏是本机的主数据，不再向服务端要列表。
 * 配了服务器的话在后台对一次账（并集合并，不会抹掉任何一边），完成后再刷列表。
 * AI 评语只有服务端能生成，没有服务端就空着，不影响列表。
 */
async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    await favorites.ensureLoaded();
    applyRows();

    if (serverReady()) {
      void (async () => {
        await favorites.syncFromServer();
        applyRows();
        try {
          const res = await fetchFavorites({ limit: 1 });
          aiSummary.value = res.summary || '';
        } catch {
          /* 评语是装饰，拿不到不影响收藏 */
        }
      })();
    }
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '收藏加载失败';
  } finally {
    loading.value = false;
  }
}

/** 把 store 的行投影成曲目列表（没有快照的行跳过 —— 只有 id 渲染不出东西） */
function applyRows(): void {
  items.value = favorites.rows.map(r => r.track).filter((t): t is Track => !!t);
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="favorites neu-container" data-view="favorites">
    <header class="head">
      <div class="head-info">
        <h1 class="title neu-t1" :title="headerTitle">
          {{ headerTitle }}<span
            v-if="headerTitle === '收藏曲目' && totalLabel > 0"
            class="cnt neu-t2 neu-num"
            data-role="fav-total"
          >{{ totalLabel }}</span>
        </h1>
        <span
          v-if="headerTitle !== '收藏曲目' && totalLabel > 0"
          data-role="fav-total"
          style="display: none"
        >{{ totalLabel }}</span>
        <p v-if="headerSub" class="sub neu-t2">{{ headerSub }}</p>
      </div>
    </header>

    <!-- 收藏内搜索：本地过滤，即时生效 -->
    <div v-if="!loading && !errorText && visible.length" class="search-row" data-role="fav-search">
      <NeuInput
        v-model="keyword"
        type="search"
        icon="search"
        placeholder="搜索歌名 / 歌手 / 专辑"
      />
    </div>

    <div v-if="loading" class="skeleton neu-raised-md">
      <NeuSkeleton :lines="6" height="52px" />
    </div>

    <div v-else-if="errorText" class="empty neu-raised-md">
      <p>{{ errorText }}</p>
      <NeuButton @click="load()">重试</NeuButton>
    </div>

    <div v-else-if="isEmpty" class="empty neu-raised-md" data-role="fav-empty">
      <p>
        还没有收藏。<br />
        在歌曲列表或播放条上点<strong>红心</strong>，它们就会出现在这里。
      </p>
    </div>

    <div v-else-if="noMatch" class="empty neu-raised-md" data-role="fav-no-match">
      <p>没有匹配「{{ keyword.trim() }}」的歌曲。</p>
      <NeuButton @click="keyword = ''">清除搜索</NeuButton>
    </div>

    <template v-else>
      <div class="list">
        <TrackRow
          v-for="(t, i) in filtered"
          :key="t.id"
          :track="t"
          :index="i + 1"
          :list="filtered"
          swipe-remove-on-unfavorite
          :mark-fav="false"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.favorites {
  padding-top: var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
}
.head-info {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
  width: 100%;
}
.title {
  margin: 0;
  font-size: var(--fs-2xl);
  line-height: var(--lh-tight);
  word-break: break-word;
  overflow-wrap: break-word;
}
.cnt {
  margin-left: var(--sp-2);
  font-size: var(--fs-base);
  font-weight: var(--fw-normal);
  color: var(--t2);
}
.search-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.search-row > :first-child {
  flex: 1 1 auto;
  min-width: 0;
}
.search-count {
  flex: none;
  font-size: var(--fs-xs);
}

/* 离线快照提示条 */
.offline-note {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--panel-2);
  font-size: var(--fs-xs);
  color: var(--t2);
}

.sub {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--t2);
  max-width: 780px;
  word-break: break-word;
  overflow-wrap: break-word;
  white-space: normal;
}

.skeleton {
  padding: var(--sp-3);
}
.list {
  /* 列表直接落在页面底上：不要内边距与圆角，靠行的发丝线分格 */
  padding: 0;
}
.empty {
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
  color: var(--t2);
  line-height: 2;
  border-radius: var(--r-xl);
}

/* 移动端：底部避让交给壳的 .tail */
@media (max-width: 767px) {
  .favorites {
    padding-bottom: 0;
  }
  .title {
    font-size: var(--fs-xl);
  }
  .sub {
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
}

@media (min-width: 1024px) {
  .favorites {
    padding-top: var(--sp-6);
  }
  .title {
    font-size: 26px;
  }
}
</style>
