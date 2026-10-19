<script setup lang="ts">
/**
 * 首页。
 *
 * 数据来自聚合端点 `/api/home`（一次往返拿全新碟首发 / 新歌首发 / 巅峰榜）。
 * 服务端给这个响应加了 `private, max-age=300`，所以短时间内重复进入不会打上游。
 *
 * **这里刻意没有"推荐歌单"**：那份数据是按标签固定的，长期不变，
 * 首页上不提供任何信息增量，徒增一次上游请求。
 *
 * **也没有「精彩推荐」**：上游 `GetFocus` 回的运营大图与 Q 音首页真正那栏对不上，
 * 而 Q 音真正的首页数据走加密接口（`u6.y.qq.com/cgi-bin/musics.fcg`）拿不到 ——
 * *拿不到就不摆*，不拿一批不相干的大图冒名顶替。
 * 顶部改由「新碟首发」担纲，做成横向可滑的海报位（见下方 `.posters`）。
 *
 * 上游限流时服务端会返回**部分为空 + 对应区块的 degraded**。
 * 首页这里对空区块的处理是「整块隐藏」而不是「显示空状态」——
 * 首页有多个区块，某一两个空掉时留白比三个"暂无内容"更自然。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import CoverCard from '@/components/CoverCard.vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuIconButton from '@/components/neu/NeuIconButton.vue';
import NeuSkeleton from '@/components/neu/NeuSkeleton.vue';
import TrackRow from '@/components/TrackRow.vue';
import { fetchHome } from '@/api/catalog.ts';
import { directHome } from '@/api/direct/home.ts';
import { serverReady } from '@/offline/syncMode.ts';
import { ApiError } from '@/api/client.ts';
import { isNativeAudio } from '@/native/audio.ts';
import { usePlayerStore } from '@/stores/player.ts';
import { useSessionStore } from '@/stores/session.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { artistNames } from '@/utils/format.ts';
import type { HomeData } from '@/api/types.ts';

const router = useRouter();
const session = useSessionStore();
const player = usePlayerStore();
const favorites = useFavoritesStore();

const data = ref<HomeData | null>(null);

const loading = ref(true);
const errorText = ref('');
/** 根节点：下拉刷新要顺着它往上找滚动容器（外壳里的 .neu-scroll） */
const rootEl = ref<HTMLElement | null>(null);

const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
});

/**
 * AI 生成的专属欢迎语（一句完整的话，第一人称）。
 *
 * 有它时首页大标题**整行只显示它** —— 这句话自己就是完整的（带标点），
 * 后面再拼「，用户名」会读成病句。用户名只在回落时段问候时才需要。
 */
const aiWelcome = computed(() => (data.value?.welcomePhrase || '').trim());

/** 首页大标题：有 AI 欢迎语就用它，否则「时段问候，用户名」 */
const headText = computed(() => {
  if (aiWelcome.value) return aiWelcome.value;
  // 没登录时 displayName 是空串 —— 直接拼会得到"夜深了，"，那个逗号很扎眼
  return session.displayName ? `${greeting.value}，${session.displayName}` : greeting.value;
});

/** 当前是不是"没配服务端"的直连模式 —— 首页空状态的文案要区分开 */
const localMode = computed(() => !serverReady());

const hasAnything = computed(() => {
  const d = data.value;
  if (!d) return false;
  return d.newAlbums.length > 0 || d.newSongs.length > 0 || d.toplists.length > 0;
});

async function load() {
  // 直连模式：走 QQ 的同一组 module（新碟 / 新歌 / 榜单），不发 /api/home
  if (localMode.value) {
    loading.value = true;
    try {
      data.value = await directHome();
      void setupPosters();
    } catch (e) {
      errorText.value = e instanceof Error ? e.message : '获取首页失败';
    } finally {
      loading.value = false;
      void favorites.ensureLoaded();
    }
    return;
  }
  loading.value = true;
  errorText.value = '';
  try {
    data.value = await fetchHome();
    // 海报位的翻页页数依赖真实渲染宽度，等 DOM 落地后再量
    void setupPosters();
  } catch (e) {
    errorText.value =
      e instanceof ApiError
        ? e.isNetworkError
          ? '连不上服务端，请到设置页检查基地址'
          : e.message
        : '加载首页失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/* ==========================================================================
 * 下拉刷新（仅原生端：安卓 / iOS）
 *
 * 为什么只在原生端：PC 上有鼠标，页头那个刷新按钮更直接；而手机端顶部那个
 * 图标按钮既小又难点，下拉是原生手感。**注意**：首页内容的更新粒度是「天」
 * （新碟/新歌/榜单），AI 欢迎语更是一天只变一次（每天 00:30 的维护才动），
 * 所以下拉的意义主要是「失败重试 / 断网恢复后补一次」。
 *
 * 实现要点：滚动容器不在这里，而是外壳 MobileShell 里的 `.main.neu-scroll`，
 * 所以往上找最近的 `.neu-scroll` 挂监听；到顶后再下拉才 preventDefault，
 * 否则会把正常滚动吃掉。
 * ========================================================================== */
/** 松手即刷新的位移阈值（已含阻尼后的显示值） */
const PULL_TRIGGER = 56;
/** 最大下拉位移，避免越拉越长 */
const PULL_MAX = 88;
/** 下拉阻尼：手指走 2px，内容才下移 1px */
const PULL_DAMPING = 0.5;

const pullDistance = ref(0);
/** 手势是否真的挂上了：按钮的显隐跟它走，避免万一找不到滚动容器就没有刷新入口 */
const canPullRefresh = ref(false);
let scroller: HTMLElement | null = null;
let pullStartY = 0;
let pullActive = false;

/** 刷新中（已有数据时的加载 = 下拉刷新，而不是首屏骨架） */
const refreshing = computed(() => loading.value && !!data.value);
const pullHintHeight = computed(() => (refreshing.value ? 44 : pullDistance.value));
const pullHintText = computed(() =>
  refreshing.value ? '正在刷新…' : pullDistance.value >= PULL_TRIGGER ? '松开刷新' : '下拉刷新'
);

/** 下拉 / 刷新中把整页往下推；PC 端与静止态返回 undefined，保持原样 */
const pullPaddingStyle = computed(() =>
  isNativeAudio && pullHintHeight.value > 0
    ? { paddingTop: `calc(var(--sp-5) + ${pullHintHeight.value}px)` }
    : undefined
);

function onPullStart(e: TouchEvent): void {
  if (!scroller || scroller.scrollTop > 0 || refreshing.value) {
    pullActive = false;
    return;
  }
  pullStartY = e.touches[0]?.clientY ?? 0;
  pullActive = true;
}

function onPullMove(e: TouchEvent): void {
  if (!pullActive || !scroller) return;
  const delta = (e.touches[0]?.clientY ?? 0) - pullStartY;
  if (delta <= 0) {
    pullDistance.value = 0;
    return;
  }
  // 中途滚上去了（或本来就不在顶部）就交还给正常滚动
  if (scroller.scrollTop > 0) {
    pullActive = false;
    pullDistance.value = 0;
    return;
  }
  e.preventDefault();
  pullDistance.value = Math.min(PULL_MAX, delta * PULL_DAMPING);
}

function onPullEnd(): void {
  if (!pullActive) return;
  pullActive = false;
  const reached = pullDistance.value >= PULL_TRIGGER;
  pullDistance.value = 0;
  if (reached) void load();
}

onMounted(() => {
  if (!isNativeAudio) return;
  scroller = rootEl.value?.closest('.neu-scroll') as HTMLElement | null;
  if (!scroller) return;
  canPullRefresh.value = true;
  scroller.addEventListener('touchstart', onPullStart, { passive: true });
  scroller.addEventListener('touchmove', onPullMove, { passive: false });
  scroller.addEventListener('touchend', onPullEnd, { passive: true });
  scroller.addEventListener('touchcancel', onPullEnd, { passive: true });
});

onBeforeUnmount(() => {
  if (!scroller) return;
  scroller.removeEventListener('touchstart', onPullStart);
  scroller.removeEventListener('touchmove', onPullMove);
  scroller.removeEventListener('touchend', onPullEnd);
  scroller.removeEventListener('touchcancel', onPullEnd);
});

function openToplist(id: string) {
  void router.push({ name: 'collection', params: { kind: 'toplist', id } });
}

function openAlbum(id: string) {
  void router.push({ name: 'collection', params: { kind: 'album', id } });
}

/** 一次性把新歌设为播放队列并从头播 */
function playAllNewSongs(startIndex = 0) {
  const list = data.value?.newSongs ?? [];
  if (list.length === 0) return;
  void player.playQueue(list, startIndex);
}

/**
 * 发行日角标：`2026-09-11` → `09-11`。
 *
 * 上游 release_time 的完整格式不是契约的一部分（实测多为 `YYYY-MM-DD`，
 * 也可能带时间），所以这里只在**确实解析得出月日**时才给角标，
 * 解析不出来就干脆不挂 —— 宁可少一个角标，也不要显示 `NaN-NaN`。
 */
function releaseBadge(raw: string): string {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw || '');
  if (!m) return '';
  const month = m[2];
  const day = m[3];
  if (!month || !day) return '';
  return `${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 新碟海报位：翻页
// ---------------------------------------------------------------------------
//
// 一排 12 张横滑，原生滚动条既难看又和软拟物不搭（用户明确要求去掉），
// 所以把滚动条藏掉，改成**显式的翻页按钮**：桌面排在海报区两侧（不压在封面上），
// 窄屏落到下方。
//
// ## 为什么是"停靠点数组"而不是"用除法算页码"
//
// 第一版就是拿 `floor(scrollLeft / clientWidth) + 1` 当页码，实测翻到最后一页后
// **再也回不到第一页**：从末尾往前推一屏落在 488px，而 488 < 1180 会被算成
// "第 1 页"，于是「上一批」按钮因为"已在第一页"被禁用 ——
// 页面显示 1/3，实际停在中间，prev 又按不动，除非刷新。
//
// 根因是**页码与滚动位置不是同一个量**：除法算的是"落在第几个区间"，
// 而"能不能往前翻"取决于"还有没有更靠前的停靠点"。
// 所以改成显式维护一组**停靠点**（stops），页码只看"离哪个停靠点最近"，
// 而能不能翻只看**真实滚动位置**是否已在两端。两者不再互相推导。
//
// 宽度与停靠点会随窗口尺寸变，所以 resize 与图片加载完成后都要重算 ——
// 只算一次会在窗口缩放后卡在错误的页数上。

const postersEl = ref<HTMLElement | null>(null);
/** 当前页（展示用，从 1 开始） */
const posterPage = ref(1);
const posterPages = ref(1);
/** 至少两页才需要翻页控件 */
const canPagePosters = computed(() => posterPages.value > 1);
/**
 * 是否已在最左 / 最右。
 * **只看真实滚动位置**，不看页码 —— 这正是上一版出错的地方。
 */
const posterAtStart = ref(true);
const posterAtEnd = ref(true);

interface PosterMetrics {
  /** 可停靠的滚动位置，升序；最后一个恒为可滚到底的位置 */
  stops: number[];
  /** 离当前位置最近的停靠点下标 */
  nearest: number;
  maxScroll: number;
}

/** 第一张卡片在滚动内容坐标系里的位置（也是第一个吸附点） */
function firstCardOffset(el: HTMLElement): number {
  const card = el.querySelector<HTMLElement>('.poster');
  if (!card) return 0;
  return card.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
}

function posterMetrics(el: HTMLElement): PosterMetrics {
  const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
  const origin = firstCardOffset(el);
  const step = Math.max(1, el.clientWidth);

  if (maxScroll <= 0) return { stops: [origin], nearest: 0, maxScroll: 0 };

  const stops: number[] = [];
  const fullSteps = Math.floor((maxScroll - origin) / step);
  for (let i = 0; i <= fullSteps; i++) stops.push(Math.min(maxScroll, origin + i * step));
  // 末尾通常不足一屏，补一个"滚到底"的停靠点，否则最后一页永远停不到
  if (stops[stops.length - 1]! < maxScroll) stops.push(maxScroll);

  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  stops.forEach((s, i) => {
    const d = Math.abs(el.scrollLeft - s);
    if (d < best) {
      best = d;
      nearest = i;
    }
  });

  return { stops, nearest, maxScroll };
}

function syncPosters() {
  const el = postersEl.value;
  if (!el) return;
  const m = posterMetrics(el);
  posterPages.value = m.stops.length;
  posterPage.value = m.nearest + 1;
  // 两端判定只认真实位置，容差 2px 是为了躲开小数像素与吸附抖动
  posterAtStart.value = el.scrollLeft <= (m.stops[0] ?? 0) + 2;
  posterAtEnd.value = el.scrollLeft >= m.maxScroll - 2;
}

function pagePosters(dir: number) {
  const el = postersEl.value;
  if (!el) return;
  const m = posterMetrics(el);
  if (m.stops.length <= 1) return;
  const target = Math.min(m.stops.length - 1, Math.max(0, m.nearest + dir));
  el.scrollTo({ left: m.stops[target]!, behavior: 'smooth' });
}

function goToPosterPage(page: number) {
  const el = postersEl.value;
  if (!el) return;
  const m = posterMetrics(el);
  const index = Math.min(m.stops.length - 1, Math.max(0, page - 1));
  el.scrollTo({ left: m.stops[index]!, behavior: 'smooth' });
}

let resizeObserver: ResizeObserver | null = null;

/**
 * 海报位渲染出来之后再测量。
 * **不能只在 onMounted 里量** —— 区块挂在 `v-else-if="data"` 下，
 * 挂载那一刻数据还没回来、`postersEl` 是 null，量出来永远是 1 页。
 */
async function setupPosters() {
  await nextTick();
  syncPosters();
  const el = postersEl.value;
  if (el && typeof ResizeObserver !== 'undefined') {
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(syncPosters);
    resizeObserver.observe(el);
  }
}

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <div ref="rootEl" class="home neu-container" :style="pullPaddingStyle">
    <!-- 下拉刷新提示（仅原生端）：绝对定位、不参与 flex 流（否则 flex gap 会在收起时留空档）；
         「把内容推下去」靠 .home 的动态 padding-top -->
    <div
      v-if="isNativeAudio"
      class="pull-hint"
      :class="{ ready: pullDistance >= PULL_TRIGGER }"
      :style="{ height: pullHintHeight + 'px' }"
      aria-hidden="true"
    >
      <span class="pull-text neu-t2">{{ pullHintText }}</span>
    </div>

    <!-- 页头 -->
    <header class="head">
      <div class="hello">
        <h1 class="hi" :class="{ 'hi-free': !!aiWelcome }" :title="headText">{{ headText }}</h1>
      </div>
      <!-- PC 端保留按钮；原生端改用下拉手势（只有手势真的挂上了才隐藏按钮） -->
      <NeuIconButton
        v-if="!canPullRefresh"
        icon="refresh"
        label="刷新首页"
        :loading="loading"
        @click="load"
      />
    </header>

    <!-- 加载骨架：顺序与真实区块一致（海报位 → 曲目列表 → 卡片网格） -->
    <template v-if="loading && !data">
      <div class="block">
        <NeuSkeleton height="22px" width="96px" />
        <div class="sk-posters">
          <div v-for="i in 4" :key="i" class="sk-card">
            <NeuSkeleton height="0" radius="xl" class="sk-art" />
          </div>
        </div>
      </div>
      <div class="block">
        <NeuSkeleton :lines="6" height="20px" />
      </div>
      <div class="neu-grid">
        <div v-for="i in 4" :key="i" class="sk-card">
          <NeuSkeleton height="0" radius="lg" class="sk-art" />
          <NeuSkeleton height="14px" width="80%" />
        </div>
      </div>
    </template>

    <!-- 错误 -->
    <div v-else-if="errorText" class="state neu-raised-md">
      <p class="state-title">没能加载首页</p>
      <p class="state-msg neu-t2">{{ errorText }}</p>
      <button type="button" class="retry" @click="load">
        <NeuIcon name="refresh" :size="15" />
        重试
      </button>
    </div>

    <!-- 全部为空（上游整片不可用） -->
    <div v-else-if="!hasAnything" class="state neu-raised-md">
      <p class="state-title">暂时没有内容</p>
      <p class="state-msg neu-t2">
        上游可能正在限流，稍等片刻再刷新；也可以直接去搜索。
      </p>
      <button type="button" class="retry" @click="load">
        <NeuIcon name="refresh" :size="15" />
        重试
      </button>
    </div>

    <template v-else-if="data">
      <!-- 新碟首发 —— 顶部海报位 -->
      <!-- 横滑一排，但**不显示原生滚动条**（用户明确要求）：滚动条既不美观，
           也和软拟物"表面同源"的观感冲突。改为显式翻页控件 ——
           桌面浮在两侧、窄屏落到下方居中，另加一排指示点。 -->
      <section v-if="data.newAlbums.length > 0" class="block" data-block="new-albums">
        <div class="block-head">
          <h2 class="block-title">新碟首发</h2>
          <span v-if="canPagePosters" class="page-hint neu-t2" data-role="page-hint">
            {{ posterPage }} / {{ posterPages }}
          </span>
        </div>

        <!-- 翻页按钮是海报区的**兄弟节点**而不是覆盖在上面的浮层：
             做成浮层时按钮压在封面上，点偏一点就点开了专辑（用户实测反馈）。 -->
        <div class="rail">
          <NeuIconButton
            v-if="canPagePosters"
            icon="chevron-left"
            label="上一批新碟"
            size="lg"
            :disabled="posterAtStart"
            class="rail-nav prev"
            data-nav="prev"
            @click="pagePosters(-1)"
          />

          <!-- scroll-snap + 隐藏滚动条；触摸设备直接横滑 -->
          <div ref="postersEl" class="posters" @scroll.passive="syncPosters">
            <button
              v-for="a in data.newAlbums"
              :key="a.id"
              type="button"
              class="poster neu-raised-lg"
              :aria-label="`打开专辑：${a.name}`"
              @click="openAlbum(a.id)"
            >
              <img class="poster-art" :src="a.picUrl" :alt="a.name" loading="lazy" />
              <span class="poster-sheen" aria-hidden="true" />
              <span v-if="releaseBadge(a.publishTime)" class="poster-date">
                {{ releaseBadge(a.publishTime) }}
              </span>
              <span class="poster-meta">
                <span class="poster-name">{{ a.name }}</span>
                <span class="poster-sub">{{ artistNames(a.artists) }}</span>
              </span>
            </button>
          </div>

          <NeuIconButton
            v-if="canPagePosters"
            icon="chevron-right"
            label="下一批新碟"
            size="lg"
            :disabled="posterAtEnd"
            class="rail-nav next"
            data-nav="next"
            @click="pagePosters(1)"
          />
        </div>

        <!-- 指示点：一页一点，可点跳转。故意不用进度条 —— 那和滚动条太像 -->
        <div v-if="canPagePosters" class="rail-dots" data-role="page-dots">
          <button
            v-for="p in posterPages"
            :key="p"
            type="button"
            class="rail-dot"
            :class="{ 'is-on': p === posterPage }"
            :aria-label="`跳到第 ${p} 页`"
            :aria-current="p === posterPage ? 'true' : undefined"
            @click="goToPosterPage(p)"
          />
        </div>
      </section>

      <!-- 新歌首发 -->
      <section v-if="data.newSongs.length > 0" class="block" data-block="new-songs">
        <div class="block-head">
          <h2 class="block-title">新歌首发</h2>
        </div>
        <div class="list">
          <TrackRow
            v-for="(t, i) in data.newSongs.slice(0, 8)"
            :key="t.id"
            :track="t"
            :index="i + 1"
            :list="data.newSongs"
          />
          <button
            type="button"
            class="list-play-all neu-clickable"
            @click="playAllNewSongs(0)"
          >
            <NeuIcon name="play" :size="14" />
            <span>播放全部</span>
          </button>
        </div>
      </section>

      <!-- 巅峰榜 -->
      <section v-if="data.toplists.length > 0" class="block" data-block="toplists">
        <div class="block-head">
          <h2 class="block-title">巅峰榜</h2>
        </div>
        <div class="toplist-grid">
          <button
            v-for="t in data.toplists"
            :key="t.id"
            type="button"
            class="grid-btn"
            @click="openToplist(t.id)"
          >
            <CoverCard
              :title="t.name"
              :cover="t.picUrl || t.coverImgUrl"
              :subtitle="t.updateFrequency"
              badge="榜"
            />
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.home {
  padding-top: var(--sp-5);
  padding-bottom: var(--sp-7);
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  position: relative;
}

/* 下拉刷新提示条：绝对定位，不参与 flex 布局（参与的话 flex gap 在收起时仍会留空档） */
.pull-hint {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  pointer-events: none;
}
.pull-hint .pull-text {
  font-size: var(--fs-xs);
}
.pull-hint.ready .pull-text {
  color: var(--accent-text);
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
}
.hello {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.hi {
  margin: 0;
  font-size: 26px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.02em;
  line-height: 1.2;
  color: var(--t1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/*
 * AI 欢迎语是一句完整的话，不该被单行省略号截掉 —— 允许换到两行。
 * （时段问候仍是「早上好，用户名」这种短句，走上面的单行省略即可。）
 */
.hi-free {
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.sub {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
}

/* ---------- 新碟首发（顶部海报位） ---------- */
/*
 * 方块封面本身就是海报，所以让封面铺满整块、标题压在下缘，
 * 而不是"封面 + 下面两行字"（那是 CoverCard 的形态，尺寸一大就散）。
 *
 * 横滑，但**不露滚动条**：`scrollbar-width`（Firefox）与
 * `::-webkit-scrollbar`（Chrome/Safari）两条都要写 ——
 * 只写一条，在另一个内核的浏览器上照样露出来。
 *
 * padding 与负 margin 成对出现，是为了给 overflow 裁切留出缓冲 ——
 * 只要某一轴不是 visible，另一轴的 visible 也会被算成 auto，
 * 于是卡片抬起时的阴影会被容器边缘切掉。留出 16px 就切不到了。
 */
/*
 * 翻页按钮与海报区**并排**，不覆盖。
 * 上一版是绝对定位的浮层，按钮压在首/末张封面上 ——
 * 用户实测反馈"容易误触点到专辑"，因为点偏一点就落在封面上了。
 * 并排之后按钮与封面零重叠，误触点不到任何东西。
 *
 * 代价是海报区宽度少掉两个按钮 + 间距（约 112px），
 * 换来的是"想点翻页就只可能点到翻页"，这个交换是划算的。
 */
.rail {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.posters {
  flex: 1 1 auto;
  /* 没有这行，12 张卡片的固有宽度会把 flex 容器撑破 */
  min-width: 0;
  /*
   * 一屏**正好 4 张，连第 5 张的边都不露**（用户指定）。
   * 用百分比按"每页张数"反推卡片宽度，而不是写死 220px ——
   * 写死时张数随视口宽浮动，实测会露出"第 5 张的一半"。
   *
   * ⚠️ 这里的百分比**参照内容盒**，而可视区是**内边距盒**：
   * 本容器左右各有 --sp-4 内边距，所以 `100%` = 可视宽 - 2×间距。
   * 要的是：N 张卡 + (N-1) 个间距 + **1 个尾部间距** = 可视宽
   *   → N×W + N×gap = 可视宽
   *   → W = (100% - (N-2)×gap) / N
   * 第一版误按"填满内容盒"减了 (N-1) 个间距，于是尾部少了 1 个间距，
   * 第 5 张正好探进来 16px —— 就是用户看到的"漏了一点边"。
   */
  --poster-per-page: 4;
  grid-auto-columns: calc(
    (100% - (var(--poster-per-page) - 2) * var(--sp-4)) / var(--poster-per-page)
  );
  display: grid;
  grid-auto-flow: column;
  gap: var(--sp-4);
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x mandatory;
  scroll-behavior: smooth;
  scrollbar-width: none;
  padding: var(--sp-4);
  margin: calc(var(--sp-4) * -1);
}
.posters::-webkit-scrollbar {
  display: none;
}

/*
 * 投影用 `filter: drop-shadow` 而不是 `box-shadow`：
 * `NeuIconButton` 自带更弱的 `box-shadow` 写在子组件里，
 * 从外面覆盖会撞 scoped 特异性；`filter` 是另一个属性，不冲突。
 */
.rail-nav {
  flex: none;
}
/**
 * 左右翻页键只对**鼠标**有意义：触摸屏上直接横滑海报即可。
 * 在触摸设备上隐藏后，整行高度省下来，页码（1 / 6）与指示点仍然保留。
 */
@media (pointer: coarse) {
  .rail-nav {
    display: none;
  }
}

/* 翻页是辅助动作：不要面板，只留箭头。
   class 落在 NeuIconButton 的根元素上，所以是同一元素而非后代 —— 用 :global 覆盖 */
:global(.rail-nav.neu-icon-btn) {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  color: var(--t2);
}

/* ---- 指示点：一页一点。故意不用进度条，那和滚动条太像 ---- */
.rail-dots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  margin-top: calc(var(--sp-4) * -0.5);
}
.rail-dot {
  width: 6px;
  height: 6px;
  padding: 0;
  border-radius: 1px;
  background: var(--line);
  transition: background var(--dur-mid) var(--ease);
}
/* 当前页只换色，不拉长 —— 胶囊是旧版语言 */
.rail-dot.is-on {
  background: var(--accent);
}
.rail-dot:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: 2px;
}

/* 页码提示（3 / 8）：给"还有几页"一个明确数字，和指示点互为补充 */
.page-hint {
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

.poster {
  position: relative;
  display: block;
  width: 100%;
  scroll-snap-align: start;
  border-radius: var(--r-md);
  overflow: hidden;
  aspect-ratio: 1;
  background: var(--panel-2);
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--hi);
  transition: border-color var(--dur-mid) var(--ease);
}
/* 悬停微抬：幅度与 CoverCard 一致，软拟物的动效应当是"呼吸"而非"弹跳" */
.poster:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
}
.poster:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: 3px;
}
.poster-art {
  width: 100%;
  height: 100%;
  /* 上游封面是方图，容器也是 1:1，等比例贴上，裁不到内容 */
  object-fit: cover;
  border-radius: inherit;
}
/* 一道斜向高光，让图片看起来是"嵌在面板上"而不是"贴上去的" */
.poster-sheen {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    120deg,
    rgba(255, 255, 255, 0.16) 0%,
    rgba(255, 255, 255, 0) 42%
  );
  pointer-events: none;
}

/* 发行日角标，压在封面上。和压字同样的处理：自带暗底，不靠图片碰运气 */
.poster-date {
  position: absolute;
  top: var(--sp-3);
  left: var(--sp-3);
  padding: 1px 5px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 11px;
  line-height: 1.7;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  backdrop-filter: blur(6px);
  pointer-events: none;
}

/*
 * 标题压在封面下缘。
 * **必须自带上暗底**：白底封面太多了，只靠图片本身保证不了对比度。
 * 这是全站唯一允许"图上白字"的地方，所以对比度由渐变兜底、不靠图片碰运气。
 */
.poster-meta {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-6) var(--sp-3) var(--sp-3);
  text-align: left;
  color: #fff;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.78) 0%,
    rgba(0, 0, 0, 0.42) 52%,
    rgba(0, 0, 0, 0) 100%
  );
  pointer-events: none;
}
.poster-name {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  line-height: 1.35;
  /* 两行封顶：专辑名长短差得远，不封顶会有的压满大半张图 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.poster-sub {
  font-size: var(--fs-xs);
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.82);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 区块 ---------- */
.block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.resume {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-3);
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--t1);
  text-align: left;
  cursor: pointer;
}
.resume-art {
  width: 52px;
  height: 52px;
  border-radius: var(--r-sm);
  object-fit: cover;
  flex: none;
  border: 1px solid var(--line);
}
.resume-art.ph {
  display: block;
  background: var(--panel-2);
}
.resume-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.resume-title {
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
}
.resume-sub {
  font-size: var(--fs-xs);
  color: var(--t2);
}
.resume-bar {
  display: block;
  height: 2px;
  margin-top: 3px;
  background: var(--line);
}
.resume-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
}
.local-actions {
  display: flex;
  gap: var(--sp-3);
  flex-wrap: wrap;
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

.list-play-all {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: var(--panel);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--accent-text);
  box-shadow: inset 0 1px 0 var(--hi);
  transition: border-color var(--dur-fast) var(--ease);
}
.list-play-all:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
}
.list-play-all:active {
  transform: translateY(1px);
  box-shadow: inset 0 2px 7px var(--lo);
}

/* 曲目列表：直接落在页面底上，行间用发丝线分格 */
.list {
  padding: 0;
}

/* ---------- 网格卡片 ---------- */
.toplist-grid {
  /* 与上方海报轮播同构：同样的列宽公式（含尾随间隙）与同样的
     padding/负 margin 补偿，4 张卡逐列对齐海报位 */
  display: grid;
  gap: var(--sp-4);
  grid-template-columns: repeat(4, calc((100% - 2 * var(--sp-4)) / 4));
  padding: var(--sp-4);
  margin: calc(var(--sp-4) * -1);
}
@media (max-width: 767px) {
  .toplist-grid {
    grid-template-columns: repeat(2, calc((100% - 2 * var(--sp-4)) / 2));
  }
  .home {
    padding-bottom: 0;
  }
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

.sk-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.sk-art {
  aspect-ratio: 1;
  height: auto;
}
/* 骨架也要是"横向一排"，否则加载完页面会突然长高或换行长；
   宽度与真实海报位共用同一套算式，切换时才不会跳一下 */
.sk-posters {
  --poster-per-page: 4;
  grid-auto-columns: calc(
    (100% - (var(--poster-per-page) - 2) * var(--sp-4)) / var(--poster-per-page)
  );
  display: grid;
  grid-auto-flow: column;
  gap: var(--sp-4);
  overflow: hidden;
}

/* ---------- 状态块 ---------- */
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-7) var(--sp-5);
  border-radius: var(--r-md);
  text-align: center;
}
.state-title {
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
.state-msg {
  font-size: var(--fs-sm);
  max-width: 42ch;
  line-height: 1.7;
}
.retry {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  padding: var(--sp-2) var(--sp-5);
  border-radius: var(--r-md);
  color: var(--t1);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  background: var(--panel);
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--hi);
  cursor: pointer;
}
.retry:active {
  transform: translateY(1px);
  box-shadow: inset 0 2px 7px var(--lo);
}

@media (max-width: 767px) {
  .home {
    gap: var(--sp-4);
  }
  /* 窄屏一屏两张：卡片太小会看不清封面上的压字 */
  .posters {
    --poster-per-page: 2;
  }
  .sk-posters {
    --poster-per-page: 2;
  }
  /*
   * 窄屏把翻页按钮挪到海报下方：两侧各留一个 44px 会把本就只剩一张半的
   * 封面挤得没法看，而下方一排两个按钮既不挡内容、也离拇指更近。
   *
   * 用 grid 区域而不是 flex 折行：折行后两个按钮会各占一行竖着排，
   * 而"上一批 / 下一批"并排才符合直觉。1fr 列是为了不让海报区的
   * 固有宽度（12 张卡片）把容器撑破。
   */
  .rail {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-areas:
      'posters posters'
      'prev next';
    justify-items: center;
    gap: var(--sp-4) var(--sp-6);
  }
  .posters {
    grid-area: posters;
    width: 100%;
  }
  .rail-nav.prev {
    grid-area: prev;
  }
  .rail-nav.next {
    grid-area: next;
  }
  .rail-dots {
    margin-top: var(--sp-3);
  }
}

@media (min-width: 1024px) {
  /* 桌面：不再左右分栏 —— 新歌占满一整行，榜单在下方左右各半 */
  .home {
    display: flex;
    flex-direction: column;
    gap: var(--sp-6);
    padding-top: var(--sp-6);
    padding-bottom: var(--sp-5);
  }
}
</style>
