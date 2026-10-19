<script setup lang="ts">
/**
 * 搜索。
 *
 * 两条刻意的设计决策：
 *
 * 1. **不做输入即搜**。QQ 侧连打几十次就会触发限流（业务码 2001），
 *    自动补全会把配额烧在没人看的中间词上。这里必须按回车或点按钮才发请求。
 *
 * 2. **`degraded` 必须显式提示**（PLAN.md 5.3）。上游被限流时服务端返回
 *    空结果 + degraded，客户端显示"无结果"会让人以为代码坏了 ——
 *    那是最容易被误判成 bug 的假象。
 *
 * 分片是「选一片」而不是「一次全返」：每个分片都是独立的上游请求，
 * 所以切标签页会重新请求，而不是从一次"全部"的结果里筛。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CoverCard from '@/components/CoverCard.vue';
import NeuIconButton from '@/components/neu/NeuIconButton.vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import NeuSkeleton from '@/components/neu/NeuSkeleton.vue';
import NeuTabs from '@/components/neu/NeuTabs.vue';
import type { TabItem } from '@/components/neu/NeuTabs.vue';
import TrackRow from '@/components/TrackRow.vue';
import { search } from '@/api/catalog.ts';
import { ApiError } from '@/api/client.ts';
import { usePlayerStore } from '@/stores/player.ts';
import { formatCount } from '@/utils/format.ts';
import type { SearchResult, SearchType } from '@/api/types.ts';

const route = useRoute();
const router = useRouter();
const player = usePlayerStore();

/** 分片顺序即上游请求成本：单曲最常用，放第一位当默认 */
const TABS: TabItem[] = [
  { value: 'song', label: '单曲' },
  { value: 'album', label: '专辑' },
  { value: 'artist', label: '歌手' },
  { value: 'playlist', label: '歌单' },
];

const query = ref(typeof route.query.q === 'string' ? route.query.q : '');
const type = ref<SearchType>(
  (typeof route.query.type === 'string' ? route.query.type : 'song') as SearchType
);

const result = ref<SearchResult | null>(null);
const loading = ref(false);
const errorText = ref('');
/** 上游限流的说明；与 errorText 分开，因为它是"空结果 + 提示"而不是失败 */
const degradedText = ref('');

/**
 * 当前页码。**默认只取第 1 页**，用户点"下一页"时才去上游取下一页 ——
 * 每次翻页都是一次真实的 QQ 搜索请求，而搜索最容易触发 2001 风控。
 */
const page = ref(1);

/** 当前分片是否"大概还有下一页" */
const currentMore = computed(() => {
  const h = result.value?.hasMore;
  if (!h) return false;
  switch (type.value) {
    case 'song':
      return h.song;
    case 'album':
      return h.album;
    case 'artist':
      return h.artist;
    case 'playlist':
      return h.playlist;
    default:
      return h.song || h.album || h.artist || h.playlist;
  }
});

/**
 * 计数文案。
 *
 * QQ 搜索响应里**根本没有总数**（每个分片只有 `list`），
 * 所以"本次拿到几条"绝不能当成"共几条"展示 —— 那会让人以为
 * "这位歌手就 30 个结果"。上游说还有下一页时，如实标成 `30+`。
 */
function countLabel(n: number, more: boolean): string {
  return more ? `${n}+` : String(n);
}

function goPage(dir: number) {
  const next = Math.max(1, page.value + dir);
  if (next === page.value) return;
  page.value = next;
  void syncUrlAndRun();
}

/** 已发过请求的标记：初始状态不显示"无结果"，只有搜过之后才显示 */
const searched = ref(false);

let abort: AbortController | null = null;

async function run() {
  const q = query.value.trim();
  if (!q) {
    result.value = null;
    searched.value = false;
    return;
  }

  // 上一次还挂着就直接取消，避免慢响应后到把新结果覆盖掉
  abort?.abort();
  abort = new AbortController();

  loading.value = true;
  errorText.value = '';
  degradedText.value = '';

  try {
    const res = await search({ q, type: type.value, page: page.value, signal: abort.signal });
    result.value = res;
    searched.value = true;

    // 空结果 + degraded 才是限流；有结果时不必打扰用户
    const sliceCount =
      res.songs.length + res.albums.length + res.artists.length + res.playlists.length;
    if (res.degraded && res.degraded.code && sliceCount === 0) {
      degradedText.value = buildDegradedText(res.degraded.retryAfterMs);
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return;
    // 带上原始原因：直连模式下搜索走 QQ，报"搜索失败"而不给原因会让
    // "上游风控 / 网络抖动 / 代码 bug"三种情况无法区分
    const reason = e instanceof Error ? e.message : String(e);
    // QQ 风控（2001）是"等一会就好"，不是搜索坏了 —— 文案要区分开，
    // 否则用户会以为 app 出故障
    if (reason.includes('2001')) {
      errorText.value = 'QQ 音乐检索被限流，约几秒到一分钟恢复，请稍后重试';
      result.value = null;
      searched.value = true;
      loading.value = false;
      return;
    }
    errorText.value =
      e instanceof ApiError
        ? e.isNetworkError
          ? '连不上服务端，请到设置页检查基地址'
          : e.message
        : `搜索失败：${reason}`;
    result.value = null;
    searched.value = true;
  } finally {
    loading.value = false;
  }
}

function buildDegradedText(retryAfterMs?: number): string {
  if (retryAfterMs && retryAfterMs > 0) {
    const sec = Math.ceil(retryAfterMs / 1000);
    return `QQ 音乐检索被限流，约 ${sec} 秒后自动恢复。稍等一下再试即可，不是搜索坏了。`;
  }
  return 'QQ 音乐检索被限流，通常约 1 分钟后自动恢复。稍等一下再试即可，不是搜索坏了。';
}

/** 切分片时重新请求 —— 服务端每个分片是一次独立的上游调用。换条件要回到第 1 页 */
watch(type, () => {
  page.value = 1;
  if (query.value.trim()) void syncUrlAndRun();
});

function onSearch() {
  page.value = 1;
  void syncUrlAndRun();
}

async function syncUrlAndRun() {
  // 把查询同步到地址栏，这样刷新/后退能回到同一屏结果
  await router.replace({
    name: 'search',
    query: {
      ...(query.value.trim() ? { q: query.value.trim() } : {}),
      ...(type.value !== 'song' ? { type: type.value } : {}),
    },
  });
  await run();
}

onMounted(() => {
  if (query.value.trim()) void run();
});

const isEmpty = () => {
  const r = result.value;
  if (!r) return true;
  return (
    r.songs.length === 0 &&
    r.albums.length === 0 &&
    r.artists.length === 0 &&
    r.playlists.length === 0
  );
};

function playAll() {
  const list = result.value?.songs ?? [];
  if (list.length > 0) void player.playQueue(list, 0);
}

function openAlbum(id: string) {
  void router.push({ name: 'collection', params: { kind: 'album', id } });
}
function openArtist(id: string, name: string) {
  void router.push({ name: 'collection', params: { kind: 'artist', id }, query: { name } });
}
function openPlaylist(tid: string | number | undefined) {
  if (tid === undefined || tid === null) return;
  void router.push({ name: 'collection', params: { kind: 'playlist', id: String(tid) } });
}
</script>

<template>
  <div class="search neu-container">
    <header class="head">
      <h1 class="h1">搜索</h1>
      <div class="bar">
        <div class="input-wrap">
          <NeuInput
            v-model="query"
            type="search"
            icon="search"
            placeholder="歌名、歌手、专辑、歌单"
            aria-label="搜索关键词"
            @enter="onSearch"
          />
        </div>
        <NeuIconButton
          icon="search"
          label="搜索"
          primary
          square
          :loading="loading"
          data-role="search-submit"
          @click="onSearch"
        />
      </div>

      <NeuTabs v-model="type" :items="TABS" class="tabs" />
    </header>

    <!-- 加载 -->
    <div v-if="loading" class="block">
      <NeuSkeleton :lines="6" height="22px" />
    </div>

    <!-- 网络/接口错误 -->
    <div v-else-if="errorText" class="state neu-raised-md">
      <p class="state-title">搜索失败</p>
      <p class="state-msg neu-t2">{{ errorText }}</p>
      <button type="button" class="retry" @click="onSearch">
        <NeuIcon name="refresh" :size="15" />
        重试
      </button>
    </div>

    <!-- 上游限流：显式说明，绝不显示成"无结果" -->
    <div v-else-if="degradedText" class="state neu-raised-md warn">
      <p class="state-title">上游限流中</p>
      <p class="state-msg neu-t2">{{ degradedText }}</p>
      <button type="button" class="retry" @click="onSearch">
        <NeuIcon name="refresh" :size="15" />
        再试一次
      </button>
    </div>

    <!-- 真的没有结果 -->
    <div v-else-if="searched && isEmpty()" class="state neu-raised-md">
      <p class="state-title">没有找到相关内容</p>
      <p class="state-msg neu-t2">
        换个关键词试试，或者切换到其他分片（专辑 / 歌手 / 歌单）。
      </p>
    </div>

    <!-- 还没搜过 -->
    <div v-else-if="!searched" class="state plain">
      <p class="state-msg neu-t2">
        输入关键词后按回车。搜索会消耗上游配额，所以不做输入即搜。
      </p>
    </div>

    <!-- 结果 -->
    <template v-else-if="result">
      <!-- 单曲 -->
      <section v-if="result.songs.length > 0" class="block">
        <div class="block-head">
          <h2 class="block-title">单曲 <span class="neu-num count">{{ countLabel(result.songs.length, result.hasMore.song) }}</span></h2>
          <button type="button" class="play-all" @click="playAll">
            <NeuIcon name="play" :size="13" />
            播放全部
          </button>
        </div>
        <div class="list">
          <TrackRow
            v-for="(t, i) in result.songs"
            :key="t.id"
            :track="t"
            :index="i + 1"
            :list="result.songs"
          />
        </div>
      </section>

      <!-- 专辑 -->
      <section v-if="result.albums.length > 0" class="block">
        <div class="block-head">
          <h2 class="block-title">专辑 <span class="neu-num count">{{ countLabel(result.albums.length, result.hasMore.album) }}</span></h2>
        </div>
        <div class="neu-grid">
          <button
            v-for="a in result.albums"
            :key="a.id"
            type="button"
            class="grid-btn"
            @click="openAlbum(a.id)"
          >
            <CoverCard
              :title="a.name"
              :cover="a.picUrl"
              :subtitle="(a.artist && 'name' in a.artist ? a.artist.name : '') || ''"
            />
          </button>
        </div>
      </section>

      <!-- 歌手 -->
      <section v-if="result.artists.length > 0" class="block">
        <div class="block-head">
          <h2 class="block-title">歌手 <span class="neu-num count">{{ countLabel(result.artists.length, result.hasMore.artist) }}</span></h2>
        </div>
        <div class="neu-grid artists">
          <button
            v-for="a in result.artists"
            :key="a.id"
            type="button"
            class="grid-btn"
            @click="openArtist(a.id, a.name)"
          >
            <CoverCard
              :title="a.name"
              :cover="a.picUrl"
              shape="circle"
              :subtitle="a.musicSize ? `${a.musicSize} 首作品` : ''"
            />
          </button>
        </div>
      </section>

      <!-- 歌单 -->
      <section v-if="result.playlists.length > 0" class="block">
        <div class="block-head">
          <h2 class="block-title">
            歌单 <span class="neu-num count">{{ countLabel(result.playlists.length, result.hasMore.playlist) }}</span>
          </h2>
        </div>
        <div class="neu-grid">
          <button
            v-for="p in result.playlists"
            :key="String(p.id)"
            type="button"
            class="grid-btn"
            @click="openPlaylist(p.tid ?? p.id)"
          >
            <CoverCard
              :title="p.name"
              :cover="p.picUrl || p.coverImgUrl"
              :subtitle="`${formatCount(p.playCount)} 次播放`"
            />
          </button>
        </div>
      </section>

      <!-- 分页：默认只取第 1 页，点「下一页」才去上游取下一页 -->
      <div v-if="page > 1 || currentMore" class="pager" data-pager="search">
        <NeuIconButton
          icon="chevron-left"
          label="上一页"
          size="md"
          :disabled="page <= 1 || loading"
          @click="goPage(-1)"
        />
        <span class="pager-hint neu-t2">第 {{ page }} 页</span>
        <NeuIconButton
          icon="chevron-right"
          label="下一页"
          size="md"
          :disabled="!currentMore || loading"
          @click="goPage(1)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ---------- 分页 ---------- */
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.pager-hint {
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  min-width: 64px;
  text-align: center;
}

.search {
  padding-top: var(--sp-5);
  padding-bottom: var(--sp-7);
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

.head {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.h1 {
  font-size: var(--fs-2xl);
  color: var(--t1);
}

.bar {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
}
.input-wrap {
  flex: 1 1 auto;
  min-width: 0;
}

.tabs {
  align-self: flex-start;
}

.block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}
.block-title {
  font-size: 11px;
  letter-spacing: 0.18em;
  font-weight: var(--fw-medium);
  color: var(--t2);
}
.count {
  color: var(--t2);
  font-size: var(--fs-xs);
  font-weight: var(--fw-normal);
  margin-left: var(--sp-1);
}

.list {
  /* 列表直接落在页面底上，与搜索/收藏同一套 */
  padding: 0;
}

.play-all {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
  color: var(--accent-text);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  box-shadow: inset 0 1px 0 var(--hi);
  cursor: pointer;
}
.play-all:active {
  transform: translateY(1px);
  box-shadow: inset 0 2px 7px var(--lo);
}

.grid-btn {
  display: block;
  width: 100%;
  text-align: left;
  border-radius: var(--r-lg);
}
.grid-btn:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: 4px;
}

/* 歌手网格用圆形头像，列可以密一点 */
.artists {
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-7) var(--sp-5);
  border-radius: var(--r-md);
  text-align: center;
}
.state.plain {
  box-shadow: none;
  padding: var(--sp-6) var(--sp-5);
}
.warn {
  /* 限流用强调色描边提示，与真正的失败（红字）区分开 */
  box-shadow: inset 0 0 0 1px var(--accent-text);
}
.state-title {
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
.state-msg {
  font-size: var(--fs-sm);
  max-width: 46ch;
  line-height: 1.7;
}
.retry {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  padding: 10px var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
  color: var(--t1);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  box-shadow: inset 0 1px 0 var(--hi);
  cursor: pointer;
}
.retry:active {
  transform: translateY(1px);
  box-shadow: inset 0 2px 7px var(--lo);
}

@media (max-width: 767px) {
  .search {
    padding-bottom: 0;
  }
  .h1 {
    font-size: var(--fs-xl);
  }
  /* 图标按钮时代不再纵向堆叠：输入框 flex 撑满 + 方形图标按钮贴右 */
  .bar :deep(.field) {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* 类型 tab 总宽与搜索框行对齐，四个 tab 均分 */
  .tabs {
    width: 100%;
  }
  .tabs :deep(.tab) {
    flex: 1 1 0;
  }
}

@media (min-width: 1024px) {
  .search {
    padding-top: var(--sp-6);
    padding-bottom: var(--sp-5);
  }
  .h1 {
    font-size: 26px;
  }
}
</style>
