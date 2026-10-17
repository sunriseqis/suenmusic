<script setup lang="ts">
/**
 * 全屏播放页（移动端新版重构）。
 *
 * 针对移动端纯净沉浸与聚焦要求打磨：
 * 1. 彻底去除封面与歌词上的提示胶囊（点此看词 / 切回封面），采用原生直觉：
 *    点击封面全幅展开沉浸大视区歌词，点击歌词任意处切回封面；
 * 2. 专属推荐曲目展示精致微卡，内置两级「不喜欢」调优入口；
 * 3. 普通曲目完全不展示卡片与不喜欢按键，版面自然自适应垂直居中（Vertically Centered），清爽大气；
 * 4. 顶栏保持微指示灯（src-dot），零文字标签，零莫名其妙装饰图标；
 * 5. 底栏控件为收藏唯一事实来源，消除中间重复按键。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { addDislike } from '@/api/recommend.ts';
import { registerBackHandler } from '@/native/back.ts';
import ArtistLinks from '@/components/ArtistLinks.vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuIconButton from '@/components/neu/NeuIconButton.vue';
import NeuSlider from '@/components/neu/NeuSlider.vue';
import QueuePanel from '@/components/QueuePanel.vue';
import { usePlayerStore, PLAYBACK_MODE_LABEL, PLAYBACK_MODE_ICON } from '@/stores/player.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { useUiStore } from '@/stores/ui.ts';
import { useLyricsStore } from '@/stores/lyrics.ts';
import { cleanAiText, coverUrl, formatDuration } from '@/utils/format.ts';

const emit = defineEmits<{ (e: 'close'): void }>();

const route = useRoute();

// 任何路由跳转都收起全屏播放页
watch(
  () => route.fullPath,
  () => emit('close')
);

const player = usePlayerStore();
const favorites = useFavoritesStore();
const ui = useUiStore();
const lyrics = useLyricsStore();
const scrubMs = ref<number | null>(null);

/** 队列弹层开关 */
const queueOpen = ref(false);


/** 不喜欢两级菜单交互状态 */
const dislikeMenuOpen = ref(false);

/**
 * 移动端物理返回键与返回手势分层拦截：
 * 1. 优先关闭两级「不喜欢」浮层
 * 2. 其次关闭播放队列面板
 * 3. 再次从沉浸全屏歌词切回封面面
 * 4. 底层则收起全屏播放页
 */
const offBack = registerBackHandler(() => {
  if (dislikeMenuOpen.value) {
    dislikeMenuOpen.value = false;
    return true;
  }
  if (queueOpen.value) {
    queueOpen.value = false;
    return true;
  }
  emit('close');
  return true;
});
onBeforeUnmount(offBack);

/**
 * 播放页底部的三行歌词。
 *
 * 设计稿里歌词**始终在播放控件下方**，不再靠"点封面翻转"——
 * 翻转把两件本该同时存在的东西做成了互斥，用户想边看封面边看词就做不到。
 */
const peekLines = computed(() => {
  const ls = lyrics.lines;
  const i = lyrics.activeIdx;
  if (!ls.length || i < 0) return [];
  return ls.slice(Math.max(0, i - 1), i + 2);
});
const activeLine = computed(() => lyrics.lines[lyrics.activeIdx] ?? null);

/** 过渡用的键：当前行一变就换 key，触发交叉淡入 */
const lyricKey = computed(() => {
  const l = activeLine.value;
  return l ? `${l.time}:${l.text}` : 'none';
});

/** 收藏当前曲目 */
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

const modeIcon = computed(() => PLAYBACK_MODE_ICON[player.mode]);
const modeLabel = computed(() => PLAYBACK_MODE_LABEL[player.mode]);

onMounted(() => {
  favorites.ensureLoaded().catch(() => {});
});

const track = computed(() => player.currentTrack);
const cover = computed(() => coverUrl(track.value?.al?.picUrl, 500));
const albumName = computed(() => track.value?.al?.name || '');

// 切歌时重置菜单状态
watch(
  () => track.value?.id,
  () => {
    dislikeMenuOpen.value = false;
  }
);

const shownMs = computed(() => scrubMs.value ?? player.positionMs);
const shownPercent = computed(() => {
  const total = player.durationMs;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (shownMs.value / total) * 100));
});

function onScrubInput(percent: number) {
  const total = player.durationMs;
  if (total <= 0) return;
  scrubMs.value = (percent / 100) * total;
}
function onScrubCommit(percent: number) {
  const total = player.durationMs;
  scrubMs.value = null;
  if (total <= 0) return;
  void player.seek((percent / 100) * total);
}
</script>

<template>
  <div class="full neu-bg" :class="{ 'dislike-open': dislikeMenuOpen }" data-view="full-player">
    <!-- 柔和背景微光晕 (Ambient Glow) -->
    <div v-if="cover" class="ambient-glow" :style="{ backgroundImage: `url(${cover})` }" />

    <!-- 遮罩：点击外部收起不喜欢浮层 -->
    <div v-if="dislikeMenuOpen" class="pop-backdrop" @click="dislikeMenuOpen = false" />

    <!-- 顶栏：左收起，中状态与纯微指示灯，右队列 -->
    <header class="head">
      <NeuIconButton icon="chevron-down" label="收起播放页" size="md" @click="emit('close')" />
      <div class="head-meta">
        <!-- 播放来源 · 音频源：用户要知道这首是从哪来的，而不是一句"正在播放" -->
        <span class="eyebrow" :class="{ 'head-err': !!player.errorMessage }">
          <template v-if="player.errorMessage">{{ player.errorMessage }}</template>
          <template v-else>{{ player.headStatus }} · {{ player.origin }}</template>
        </span>
      </div>
      <NeuIconButton
        v-if="track"
        icon="dots"
        :stroke="3"
        label="锚定音源"
        size="md"
        data-role="anchor-btn"
        @click="player.requestAnchor()"
      />
    </header>

    <!-- 中间主体：视图 A 封面展示面 vs 视图 B 沉浸全屏歌词面 -->
    <div class="body">
      <div class="stage-cover">
          <!-- 封面唱片 -->
          <div class="cover-wrap neu-raised-lg">
            <img v-if="cover" :src="cover" :alt="track?.name || ''" class="cover-img" />
            <span v-else class="art-ph" aria-hidden="true" />
            <div class="art-sheen" />
          </div>

          <!-- 曲目信息 -->
          <div class="info">
            <div class="info-main">
              <div class="info-text">
                <h2 class="t-name neu-clamp-2">{{ track?.name || '未在播放' }}</h2>
                <p class="t-artist neu-ellipsis">
                  <ArtistLinks v-if="track" :artists="track.ar" />
                  <template v-else>从搜索或首页选一首开始</template>
                  <template v-if="albumName"> · {{ albumName }}</template>
                </p>
              </div>
              <NeuIconButton
                :icon="currentFav ? 'heart-filled' : 'heart'"
                :label="currentFav ? '取消收藏' : '收藏'"
                size="md"
                :class="{ 'fav-on': currentFav }"
                :disabled="!track"
                @click="toggleCurrentFav"
              />
            </div>

            <!-- 推荐理由卡片：仅在专属推荐曲目展示，内置两级不喜欢；普通曲目纯净居中，无多余按键 -->
            <div
              v-if="track?.recommendReason"
              class="m-info-card neu-inset"
              @click.stop
            >
              <div class="m-card-top">
                <span class="m-card-tag">专属推荐理由</span>

                <!-- 两级不喜欢交互入口 -->
                <div class="dislike-popover-wrap">
                  <button
                    type="button"
                    class="dislike-trigger-btn neu-clickable"
                    :class="{ 'is-open': dislikeMenuOpen }"
                    title="不喜欢调优"
                    @click.stop="toggleDislikeMenu"
                  >
                    <NeuIcon name="dislike-song" :size="12" />
                    <span>不喜欢</span>
                    <NeuIcon :name="dislikeMenuOpen ? 'chevron-up' : 'chevron-down'" :size="9" class="chevron" />
                  </button>

                  <!-- 两级不喜欢浮层弹窗 -->
                  <transition name="pop-scale">
                    <div v-if="dislikeMenuOpen" class="dislike-popover neu-raised-md" @click.stop>
                      <button type="button" class="pop-option" @click="onDislike('track')">
                        <NeuIcon name="dislike-song" :size="13" class="pop-icon" />
                        <div class="pop-text">
                          <span class="pop-main">不喜欢这首歌</span>
                          <span class="pop-sub">后续不再推荐《{{ track.name }}》</span>
                        </div>
                      </button>
                      <div class="pop-divider" />
                      <button type="button" class="pop-option" @click="onDislike('artist')">
                        <NeuIcon name="dislike-artist" :size="13" class="pop-icon" />
                        <div class="pop-text">
                          <span class="pop-main">不喜欢该歌手</span>
                          <span class="pop-sub">后续不再推荐歌手「{{ track.ar?.[0]?.name || '' }}」</span>
                        </div>
                      </button>
                    </div>
                  </transition>
                </div>
              </div>

              <p class="m-card-text">{{ cleanAiText(track.recommendReason) }}</p>
            </div>

            <!-- 解析中提示 -->
            <p v-if="player.resolving && !player.errorMessage" class="hint">正在重新匹配音源…</p>
          </div>
        </div>

    </div>

    <!-- 移动端底栏：标准 5 键式布局，收藏功能唯一的视觉锚点 -->
    <footer class="foot">
      <div class="progress">
        <NeuSlider
          :model-value="shownPercent"
          :disabled="!track"
          aria-label="播放进度"
          @update:model-value="onScrubInput"
          @change="onScrubCommit"
        />
        <div class="times">
          <span class="neu-num">{{ formatDuration(shownMs) }}</span>
          <span class="neu-num">{{ formatDuration(player.durationMs) }}</span>
        </div>
      </div>

      <div class="controls">
        <div class="wing">
          <NeuIconButton
            :icon="modeIcon"
            :label="`播放模式：${modeLabel}`"
            size="md"
            @click="player.cycleMode()"
          />
        </div>
        <div class="mid">
          <NeuIconButton
            icon="prev"
            label="上一首"
            size="lg"
            :disabled="!player.hasPrev"
            @click="player.prev()"
          />
          <NeuIconButton
            :icon="player.playing ? 'pause' : 'play'"
            :label="player.playing ? '暂停' : '播放'"
            size="xl"
            primary
            :disabled="!track"
            :loading="player.loading || player.resolving"
            @click="player.toggle()"
          />
          <NeuIconButton
            icon="next"
            label="下一首"
            size="lg"
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
        </div>
      </div>

      <div class="lyric-wrap">
        <Transition name="lyric-fade">
          <div v-if="peekLines.length" :key="lyricKey" class="lyric-peek">
            <p
              v-for="(l, i) in peekLines"
              :key="i"
              class="peek-line"
              :class="{ on: l === activeLine }"
            >
              {{ l.text }}
            </p>
          </div>
        </Transition>
      </div>
    </footer>

    <QueuePanel :open="queueOpen" @close="queueOpen = false" />
  </div>
</template>

<style scoped>
.full {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-columns: minmax(0, 1fr);
  padding: calc(var(--sp-3) + var(--safe-top)) var(--sp-5)
    calc(var(--sp-4) + var(--safe-bottom));
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
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.head-meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.eyebrow {
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--t2);
  text-transform: uppercase;
}
.head-err {
  font-size: 11px;
  color: #d4564a;
}
.h1-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
}
.h1 {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--t1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head-err {
  color: var(--danger, #c2410c);
}
.h2 {
  font-size: 11px;
  color: var(--t2);
  max-width: 80%;
  letter-spacing: 0.2px;
}

/* 纯净圆点音源微指示灯 */
.src-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  padding: 0;
  flex: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.src-dot:hover {
  transform: scale(1.25);
}
.src-dot.src-netease {
  background: var(--src-netease);
}
.src-dot.src-bilibili {
  background: var(--src-bili);
}

/* ---- 中间主体 ---- */
.body {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--sp-2) 0;
}
.full.dislike-open .body {
  z-index: 101;
  pointer-events: none;
}
.full.dislike-open .dislike-popover-wrap,
.full.dislike-open .dislike-popover-wrap * {
  pointer-events: auto;
}

/* 封面面：自然自适应垂直居中 */
.stage-cover {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  cursor: pointer;
  user-select: none;
}
.cover-wrap {
  position: relative;
  width: min(74vw, 300px);
  aspect-ratio: 1;
  border-radius: var(--r-md);
  overflow: hidden;
  margin-bottom: var(--sp-4);
  flex-shrink: 0;
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--hi);
}
.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.art-ph {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--panel-2);
  box-shadow: inset 0 1px 0 var(--hi);
}
.art-sheen {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.25);
  pointer-events: none;
}

.info {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.info-main {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
}
.info-text {
  flex: 1 1 auto;
  min-width: 0;
}
.head-spacer {
  width: 44px;
  flex: none;
}

/* 次级控件一律无面板 —— 设计稿里只有播放键有厚度。
   全给面板会让 5 个键变成一排按钮，厚度也不稀缺了。 */
.head :deep(.neu-icon-btn),
.info-main :deep(.neu-icon-btn),
.controls :deep(.neu-icon-btn:not(.primary)) {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}
.head :deep(.neu-icon-btn:active),
.info-main :deep(.neu-icon-btn:active),
.controls :deep(.neu-icon-btn:not(.primary):active) {
  background: var(--panel-2);
  box-shadow: none;
}
.t-name {
  margin: 0;
  text-align: left;
  font-size: 24px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.01em;
  color: var(--t1);
  max-width: 92%;
  line-height: 1.2;
}
.t-artist {
  margin: 2px 0 0;
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--t2);
}
.t-artist :deep(a) {
  color: inherit;
}
.hint {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-xs);
  color: var(--t2);
  letter-spacing: 0.3px;
}

/* 移动端推荐理由卡片 */
.m-info-card {
  margin-top: var(--sp-2);
  padding: 8px 12px;
  border-radius: var(--r-md);
  width: 100%;
  max-width: 90%;
  box-sizing: border-box;
}
.m-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.m-card-tag {
  font-size: 10px;
  font-weight: var(--fw-semibold);
  color: var(--accent);
}
.m-card-text {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--t2);
  text-align: left;
}

/* 移动端两级不喜欢交互组件 */
.dislike-popover-wrap {
  position: relative;
  display: inline-block;
}
.dislike-trigger-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: var(--r-pill);
  border: none;
  background: transparent;
  color: var(--t2);
  font-size: 10px;
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
  bottom: calc(100% + 4px);
  right: -8px;
  width: 210px;
  padding: 6px;
  border-radius: var(--r-lg);
  background: var(--bg);
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow:
    0 6px 18px rgba(0, 0, 0, 0.18),
    4px 4px 10px var(--sd),
    -4px -4px 10px var(--sl);
}
.pop-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
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
  font-size: 11px;
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.pop-option:hover .pop-main {
  color: var(--danger, #ef4444);
}
.pop-sub {
  font-size: 9px;
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

/* 沉浸全屏歌词面 */
.stage-lyrics {
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  cursor: pointer;
  user-select: none;
  mask-image: linear-gradient(to bottom, transparent 0, #000 36px, #000 calc(100% - 36px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 36px, #000 calc(100% - 36px), transparent 100%);
}
.lyrics-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 视图切换动画 */
.view-fade-enter-active,
.view-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.view-fade-enter-from {
  opacity: 0;
  transform: scale(0.96);
}
.view-fade-leave-to {
  opacity: 0;
  transform: scale(1.04);
}

/* ---- 底部控件 ---- */
.foot {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding-top: var(--sp-2);
}
.progress {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.times {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--t2);
  padding: 0 2px;
}
.controls {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
}
.controls .wing {
  display: flex;
  align-items: center;
}
.controls .wing-r {
  justify-content: flex-end;
}
.controls .mid {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}

:deep(.fav-on) {
  color: var(--accent-text);
}

/* 底部三行歌词：不滚动、不遮挡，只做"此刻唱到哪"的提示 */
.lyric-wrap {
  position: relative;
  min-height: 58px;
}
/* 换行时整块向上淡出、新块从下方浮上来 —— 像一块滑动显示板，
   而不是"啪"地换字 */
.lyric-fade-enter-active {
  transition:
    opacity 240ms var(--ease),
    transform 240ms var(--ease);
}
.lyric-fade-leave-active {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  transition:
    opacity 160ms var(--ease),
    transform 160ms var(--ease);
}
.lyric-fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.lyric-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.lyric-peek {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  min-height: 58px;
}
.peek-line {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--t2);
  opacity: 0.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 92%;
}
.peek-line.on {
  color: var(--accent);
  opacity: 1;
  font-size: 13px;
  font-weight: var(--fw-medium);
}

/* 播放键是整页唯一有厚度的控件：面板色键面 + 琥珀图标，按下位移 1px。
   NeuIconButton 的 primary 写在子组件里，用 :deep + !important 压过去。 */
.controls :deep(.primary) {
  background: linear-gradient(180deg, var(--panel-2), var(--panel)) !important;
  color: var(--accent) !important;
  border: 1px solid var(--line) !important;
  box-shadow: inset 0 1px 0 var(--hi) !important;
}
.controls :deep(.primary:active) {
  transform: translateY(1px) !important;
  box-shadow: inset 0 2px 8px var(--lo) !important;
}
</style>
