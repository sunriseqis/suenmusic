<script setup lang="ts">
/**
 * 桌面全屏播放详情页（新版重构）。
 *
 * 与移动壳 FullPlayer 分开两份：布局差异太大（左封面右歌词 vs 竖排），
 * 硬抽共用壳只会满屏 props 分支；真正可共用的是 LyricsPanel。
 *
 * 底部控件与 PlayerBar（常驻播放条）同一套按钮、同一套布局：
 * 左翼（模式 / 收藏）— 中段（上下曲 + 播放）— 右翼（队列 / 静音 / 音量）。
 * 两边状态都来自同一个 player store，状态全局一致。
 *
 * 视觉打磨：
 * 1. 视线中心在左侧封面与曲目信息，普通歌曲自然垂直居中排版；
 * 2. 专属推荐曲目在信息下方呈现微拟物推荐卡片，内置两级「不喜欢」调优入口；
 * 3. 顶栏保持纯微圆点音源指示灯，零文字污染，零无意义装饰图标；
 * 4. 底部播放条为收藏单一控制源，消除界面多处重复按钮。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { addDislike } from '@/api/recommend.ts';
import ArtistLinks from '@/components/ArtistLinks.vue';
import LyricsPanel from '@/components/LyricsPanel.vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuIconButton from '@/components/neu/NeuIconButton.vue';
import NeuSlider from '@/components/neu/NeuSlider.vue';
import QueuePanel from '@/components/QueuePanel.vue';
import {
  usePlayerStore,
  PLAYBACK_MODE_LABEL,
  PLAYBACK_MODE_ICON,
} from '@/stores/player.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { useUiStore } from '@/stores/ui.ts';
import { cleanAiText, coverUrl, formatDuration } from '@/utils/format.ts';

const emit = defineEmits<{ (e: 'close'): void }>();

const player = usePlayerStore();
const favorites = useFavoritesStore();
const ui = useUiStore();
const router = useRouter();
const route = useRoute();

const track = computed(() => player.currentTrack);
const cover = computed(() => coverUrl(track.value?.al?.picUrl, 500));

/** 来源状态灯（不显示文字，颜色即语义：红=网易云 / 粉=B站） */
const sourceTitle = computed(() =>
  player.currentSource === 'netease' ? '音源：网易云' : '音源：B站'
);

const queueOpen = ref(false);
const dislikeMenuOpen = ref(false);

/** 播放模式 */
const modeIcon = computed(() => PLAYBACK_MODE_ICON[player.mode]);
const modeLabel = computed(() => PLAYBACK_MODE_LABEL[player.mode]);
function cycleMode() {
  const m = player.cycleMode();
  ui.ok(`播放模式：${PLAYBACK_MODE_LABEL[m]}`, 1600);
}

/** 收藏当前曲目（与播放条红心同一 store，状态全局一致） */
const currentFav = computed(() => {
  const t = player.currentTrack;
  return t ? favorites.contains(t.id) : false;
});
async function toggleCurrentFav() {
  const t = player.currentTrack;
  if (!t) return;
  try {
    await favorites.toggle(t);
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '收藏操作失败，请稍后重试');
  }
}

/** 两级不喜欢调优 */
function toggleDislikeMenu() {
  dislikeMenuOpen.value = !dislikeMenuOpen.value;
}
async function onDislike(type: 'track' | 'artist') {
  const t = track.value;
  if (!t) return;
  dislikeMenuOpen.value = false;
  try {
    if (type === 'track') {
      await addDislike('track', t.id, t.name);
      ui.ok(`已将《${t.name}》移出推荐，后续将减少同类推荐`);
      await player.removeAt(player.index);
    } else {
      const mid = t.ar?.[0]?.mid || '';
      const artistName = t.ar?.[0]?.name || '';
      if (!mid) {
        ui.err('该歌曲无歌手信息');
        return;
      }
      await addDislike('artist', mid, artistName);
      ui.ok(`已屏蔽歌手「${artistName}」，后续将不再推荐`);
      const matching = player.queue
        .map((item, i) => ({ item, i }))
        .filter(({ item }) => item.ar?.some(a => a.mid === mid))
        .map(({ i }) => i);
      for (const i of matching.filter(i => i !== player.index && i > player.index).sort((a, b) => b - a)) {
        await player.removeAt(i);
      }
      for (const i of matching.filter(i => i !== player.index && i < player.index).sort((a, b) => b - a)) {
        await player.removeAt(i);
      }
      const currentIndex = player.queue.findIndex(item => item.id === t.id);
      if (currentIndex >= 0) await player.removeAt(currentIndex);
    }
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '操作失败，请重试');
  }
}

const shownMs = computed(() => player.positionMs);
const shownPercent = computed(() => {
  const total = player.durationMs;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (shownMs.value / total) * 100));
});

function onScrubCommit(percent: number) {
  const total = player.durationMs;
  if (total <= 0) return;
  void player.seek((percent / 100) * total);
}

const volumePercent = computed(() => (player.muted ? 0 : Math.round(player.volume * 100)));
function onVolume(percent: number) {
  player.setVolume(percent / 100);
}

function openAlbum() {
  const id = track.value?.al?.id;
  if (!id) return;
  emit('close');
  void router.push(`/c/album/${id}`);
}

function onKeydown(e: KeyboardEvent) {
  // ESC 收起（全屏页的通用键盘习惯，不抢输入框焦点）
  if (e.key === 'Escape') {
    emit('close');
  }
}

// 任何路由跳转都收起详情页
watch(
  () => route.fullPath,
  () => emit('close')
);

// 切歌时自动收起不喜欢菜单
watch(
  () => track.value?.id,
  () => {
    dislikeMenuOpen.value = false;
  }
);

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  favorites.ensureLoaded().catch(() => {});
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    class="dfull neu-bg"
    :class="{ 'dislike-open': dislikeMenuOpen }"
    role="dialog"
    aria-label="播放详情页"
    data-view="desktop-full-player"
  >
    <!-- 柔和背景微光晕 (Ambient Glow) -->
    <div v-if="cover" class="ambient-glow" :style="{ backgroundImage: `url(${cover})` }" />

    <!-- 遮罩：点击外部收起不喜欢浮层 -->
    <div v-if="dislikeMenuOpen" class="pop-backdrop" @click="dislikeMenuOpen = false" />

    <header class="head">
      <NeuIconButton icon="chevron-down" label="收起详情页" size="md" @click="emit('close')" />
      <span class="head-title neu-t2" :class="{ 'head-err': !!player.errorMessage }">
        {{ track?.recommendReason ? '专属推荐 · 为你甄选' : player.headStatus }}
      </span>
      <!-- 音源状态灯跟在标题后面：纯净圆点，颜色即语义（红=网易云 / 粉=B站） -->
      <span class="head-end">
        <!-- 状态灯即锚定入口：点击打开锚定弹窗，随时覆写/解除 -->
        <button
          v-if="track"
          type="button"
          class="src-dot"
          :class="`src-${player.currentSource ?? 'bilibili'}`"
          :title="sourceTitle + ' · 点击锚定'"
          aria-label="锚定音源"
          data-role="anchor-btn"
          @click="player.requestAnchor()"
        />
      </span>
    </header>

    <div class="body">
      <!-- 左：Hero 视线中心（封面 + 元信息 + 专属推荐卡片），普通歌曲自然垂直居中排布 -->
      <section class="left">
        <!-- 封面唱片 -->
        <div class="art neu-raised-lg">
          <img v-if="cover" :src="cover" :alt="track?.name || ''" />
          <span v-else class="art-ph" aria-hidden="true" />
          <div class="art-sheen" />
        </div>

        <!-- 曲目元信息 -->
        <div class="meta">
          <h2 class="t-name neu-clamp-2" :title="track?.name || '未在播放'">
            {{ track?.name || '未在播放' }}
          </h2>
          <p class="t-sub neu-ellipsis">
            <ArtistLinks v-if="track" :artists="track.ar" />
            <template v-else>从搜索或首页选一首开始</template>
            <template v-if="track?.al?.name">
              <span class="sep" aria-hidden="true">·</span>
              <button
                type="button"
                class="album-link"
                :title="`打开专辑 ${track.al.name}`"
                @click="openAlbum"
              >
                {{ track.al.name }}
              </button>
            </template>
          </p>
        </div>

        <!-- 推荐理由卡片：仅在专属推荐曲目展示，内置两级不喜欢；普通曲目纯净居中，无多余按键 -->
        <div v-if="track?.recommendReason" class="info-card neu-inset">
          <div class="card-head">
            <span class="card-tag">专属推荐理由</span>

            <!-- 两级不喜欢交互入口 -->
            <div class="dislike-popover-wrap">
              <button
                type="button"
                class="dislike-trigger-btn neu-clickable"
                :class="{ 'is-open': dislikeMenuOpen }"
                title="不喜欢调优"
                @click.stop="toggleDislikeMenu"
              >
                <NeuIcon name="dislike-song" :size="13" />
                <span>不喜欢</span>
                <NeuIcon :name="dislikeMenuOpen ? 'chevron-up' : 'chevron-down'" :size="10" class="chevron" />
              </button>

              <!-- 两级不喜欢浮层弹窗 -->
              <transition name="pop-scale">
                <div v-if="dislikeMenuOpen" class="dislike-popover neu-raised-md" @click.stop>
                  <button type="button" class="pop-option" @click="onDislike('track')">
                    <NeuIcon name="dislike-song" :size="14" class="pop-icon" />
                    <div class="pop-text">
                      <span class="pop-main">不喜欢这首歌</span>
                      <span class="pop-sub">后续不再推荐《{{ track.name }}》</span>
                    </div>
                  </button>
                  <div class="pop-divider" />
                  <button type="button" class="pop-option" @click="onDislike('artist')">
                    <NeuIcon name="dislike-artist" :size="14" class="pop-icon" />
                    <div class="pop-text">
                      <span class="pop-main">不喜欢该歌手</span>
                      <span class="pop-sub">后续不再推荐歌手「{{ track.ar?.[0]?.name || '' }}」</span>
                    </div>
                  </button>
                </div>
              </transition>
            </div>
          </div>

          <p class="card-text">{{ cleanAiText(track.recommendReason) }}</p>
        </div>
      </section>

      <!-- 右：歌词。无框浮层，上下渐隐，让封面当视觉主体 -->
      <section class="right">
        <div class="lyric-area">
          <LyricsPanel />
        </div>
      </section>
    </div>

    <footer class="foot">
      <div class="progress">
        <span class="t neu-num">{{ formatDuration(shownMs) }}</span>
        <div class="track-wrap">
          <NeuSlider
            :model-value="shownPercent"
            :disabled="!track"
            aria-label="播放进度"
            @change="onScrubCommit"
          />
        </div>
        <span class="t neu-num">{{ formatDuration(player.durationMs) }}</span>
      </div>

      <!-- 与常驻播放条同构的三区控件，只是尺寸大一档 -->
      <div class="controls">
        <div class="wing">
          <NeuIconButton
            :icon="modeIcon"
            :label="`播放模式：${modeLabel}`"
            size="md"
            @click="cycleMode"
          />
          <NeuIconButton
            :icon="currentFav ? 'heart-filled' : 'heart'"
            :label="currentFav ? '取消收藏' : '收藏'"
            size="md"
            :class="{ 'fav-on': currentFav }"
            :disabled="!track"
            @click="toggleCurrentFav"
          />
        </div>
        <div class="mid">
          <NeuIconButton
            icon="prev"
            label="上一首"
            size="md"
            :disabled="!player.hasPrev"
            @click="player.prev()"
          />
          <NeuIconButton
            :icon="player.playing ? 'pause' : 'play'"
            :label="player.playing ? '暂停' : '播放'"
            size="lg"
            primary
            :disabled="!track"
            :loading="player.loading || player.resolving"
            @click="player.toggle()"
          />
          <NeuIconButton
            icon="next"
            label="下一首"
            size="md"
            :disabled="!player.hasNext"
            @click="player.next()"
          />
        </div>
        <div class="wing wing-r">
          <NeuIconButton
            icon="list"
            :label="queueOpen ? '收起队列' : '播放队列'"
            size="md"
            @click="queueOpen = !queueOpen"
          />
          <NeuIconButton
            :icon="player.muted || player.volume === 0 ? 'volume-mute' : 'volume'"
            :label="player.muted ? '取消静音' : '静音'"
            size="md"
            @click="player.setMuted(!player.muted)"
          />
          <div class="vol">
            <NeuSlider
              :model-value="volumePercent"
              aria-label="音量"
              @update:model-value="onVolume"
            />
          </div>
        </div>
      </div>
    </footer>

    <QueuePanel :open="queueOpen" @close="queueOpen = false" />
  </div>
</template>

<style scoped>
.head-err {
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--danger, #c2410c);
}
.dfull {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-overlay) + 5);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-columns: minmax(0, 1fr);
  padding: var(--sp-5) var(--sp-7) calc(var(--sp-5) + var(--safe-bottom, 0px));
  overflow: hidden;
}

/* 柔和背景微光晕 (Ambient Glow) */
.ambient-glow {
  position: absolute;
  inset: -20px;
  background-size: cover;
  background-position: center;
  filter: blur(64px);
  opacity: 0.12;
  pointer-events: none;
  z-index: 0;
}
:root[data-theme='dark'] .ambient-glow {
  opacity: 0.18;
}

/* 浮层遮罩 */
.pop-backdrop {
  position: fixed;
  inset: 0;
  z-index: 99;
  background: transparent;
}

.head {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--sp-4);
  margin-bottom: var(--sp-2);
}
.head-title {
  justify-self: center;
  letter-spacing: 0.6px;
  font-size: var(--fs-sm);
}
.head-end {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-1);
  min-width: 36px;
}

/* 来源状态灯：纯净圆点微指示灯，带柔光 */
.src-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.src-dot:hover {
  transform: scale(1.25);
}
.src-dot.src-netease {
  background: #e60026;
  box-shadow: 0 0 7px rgba(230, 0, 38, 0.7);
}
.src-dot.src-bilibili {
  background: #fb7299;
  box-shadow: 0 0 7px rgba(251, 114, 153, 0.7);
}

/* ---- 主体：左视线中心 + 右歌词 ---- */
.body {
  position: relative;
  z-index: 2;
  min-height: 0;
  min-width: 0;
  width: min(100%, 1040px);
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
  gap: var(--sp-7);
  align-items: stretch;
  overflow: hidden;
}
.dfull.dislike-open .body {
  z-index: 101;
  pointer-events: none;
}
.dfull.dislike-open .dislike-popover-wrap,
.dfull.dislike-open .dislike-popover-wrap * {
  pointer-events: auto;
}

.left {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center; /* 自然自适应垂直居中：消灭普通曲目底部的突兀留白 */
  gap: var(--sp-3);
  min-height: 0;
  min-width: 0;
  width: 100%;
}
.art {
  position: relative;
  width: 100%;
  max-width: 380px;
  aspect-ratio: 1;
  border-radius: var(--r-lg);
  overflow: hidden;
  flex: none;
  border: 1px solid var(--line);
}
.art img,
.art-ph {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
  display: block;
}
.art-ph {
  background: var(--panel-2);
}
.art-sheen {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.25);
  pointer-events: none;
}

.meta {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.t-name {
  margin: 0;
  font-size: var(--fs-2xl);
  font-weight: var(--fw-bold);
  color: var(--t1);
  line-height: var(--lh-tight);
}
.t-sub {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--t2);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}
.t-sub :deep(.artists) {
  min-width: 0;
}
.t-sub :deep(a) {
  color: inherit;
}
.sep {
  opacity: 0.6;
}
.album-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.album-link:hover {
  color: var(--t1);
}

/* 推荐理由卡片（专属推荐时展示） */
.info-card {
  width: 100%;
  max-width: 380px;
  padding: var(--sp-3);
  border-radius: var(--r-lg);
  box-sizing: border-box;
  margin-top: 2px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.card-tag {
  font-size: 11px;
  font-weight: var(--fw-semibold);
  color: var(--accent);
  letter-spacing: 0.04em;
}
.card-text {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--t2);
}

/* 两级不喜欢交互组件 */
.dislike-popover-wrap {
  position: relative;
  display: inline-block;
}
.dislike-trigger-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: var(--r-sm);
  border: none;
  background: transparent;
  color: var(--t2);
  font-size: 11px;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease);
}
.dislike-trigger-btn:hover,
.dislike-trigger-btn.is-open {
  color: var(--danger, #ef4444);
  background: rgba(239, 68, 68, 0.08);
}
.chevron {
  opacity: 0.7;
}

.dislike-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  width: 220px;
  padding: 6px;
  border-radius: var(--r-lg);
  background: var(--panel);
  border: 1px solid var(--line);
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: inset 0 1px 0 var(--hi);
}
.pop-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border-radius: var(--r-sm);
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: all var(--dur-fast) var(--ease);
}
.pop-option:hover {
  background: rgba(239, 68, 68, 0.08);
}
.pop-icon {
  color: var(--danger, #ef4444);
  flex-shrink: 0;
  margin-top: 2px;
}
.pop-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pop-main {
  font-size: 12px;
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.pop-option:hover .pop-main {
  color: var(--danger, #ef4444);
}
.pop-sub {
  font-size: 10px;
  color: var(--t2);
  line-height: 1.3;
}
.pop-divider {
  height: 1px;
  background: rgba(125, 125, 125, 0.1);
  margin: 2px 0;
}
.pop-scale-enter-active,
.pop-scale-leave-active {
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.pop-scale-enter-from,
.pop-scale-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(4px);
}

/* ---- 歌词：无框，居中一列 ---- */
.right {
  min-height: 0;
  min-width: 0;
  display: flex;
}
.lyric-area {
  flex: 1 1 auto;
  min-height: 0;
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
}

/* ---- 底部：进度 + 三区控件，与播放条同构 ---- */
.foot {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding-top: var(--sp-3);
}
.progress {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
}
.track-wrap {
  flex: 1 1 auto;
  min-width: 0;
}
.progress .t {
  color: var(--t2);
  min-width: 44px;
  text-align: center;
  font-size: var(--fs-xs);
}

.controls {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--sp-5);
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
}
.wing {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.wing-r {
  justify-content: flex-end;
}
.mid {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
}
.vol {
  width: 110px;
}

:deep(.fav-on) {
  color: var(--accent-text);
}
</style>
