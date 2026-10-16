<script setup lang="ts">
/**
 * 播放条。
 *
 * 一个组件两种形态：
 *   - `compact`（移动迷你条）：封面 + 歌名 + 播放键，整条可点开全屏播放页
 *   - 默认（桌面常驻条）：封面 + 歌名 + 控制键 + 进度条 + 音量
 *
 * 进度条的拖动用了**本地草稿值**：拖动期间显示手指的位置，不与
 * `<audio>` 的 timeupdate 抢控制权；松手才真正 seek。
 * 直接双向绑定 store 的 positionMs 会导致"拖到一半被 timeupdate 拽回去"。
 */
import { computed, onMounted, ref } from 'vue';
import ArtistLinks from '@/components/ArtistLinks.vue';
import NeuIconButton from '@/components/neu/NeuIconButton.vue';
import NeuSlider from '@/components/neu/NeuSlider.vue';
import QueuePanel from '@/components/QueuePanel.vue';
import { usePlayerStore, PLAYBACK_MODE_LABEL, PLAYBACK_MODE_ICON } from '@/stores/player.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { useUiStore } from '@/stores/ui.ts';
import { coverUrl, formatDuration } from '@/utils/format.ts';

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
const emit = defineEmits<{ (e: 'expand'): void }>();

const player = usePlayerStore();
const favorites = useFavoritesStore();
const ui = useUiStore();

// 收藏集合懒加载：桌面播放条挂载时触发，红心状态随集合到位自动点亮。
// 失败静默（登出瞬间的 401 不值得报错）
onMounted(() => {
  favorites.ensureLoaded().catch(() => {});
});

/** 队列弹层开关（仅桌面条使用） */
const queueOpen = ref(false);

/** 当前播放模式的图标与提示文案 */
const modeIcon = computed(() => PLAYBACK_MODE_ICON[player.mode]);
const modeLabel = computed(() => PLAYBACK_MODE_LABEL[player.mode]);

function cycleMode() {
  const m = player.cycleMode();
  ui.ok(`播放模式：${PLAYBACK_MODE_LABEL[m]}`, 1600);
}

/** 当前曲目快速收藏。与 TrackRow 的红心共用同一个 store，状态全局一致 */
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

/** 拖动中的草稿毫秒数；null 表示没在拖 */
const scrubMs = ref<number | null>(null);

const track = computed(() => player.currentTrack);
const cover = computed(() => coverUrl(track.value?.al?.picUrl, 150));

const shownMs = computed(() => scrubMs.value ?? player.positionMs);
const shownPercent = computed(() => {
  const total = player.durationMs;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (shownMs.value / total) * 100));
});
const bufferedPercent = computed(() => {
  // 服务端按需返回 Range，没有"已缓冲"的概念；这里只在已播位置之后
  // 留一点视觉余量，让进度条不至于太素
  return Math.min(100, shownPercent.value + 4);
});

/** 总时长未知时（流还没探测完）也允许拖，只是显示 0:00 */
const totalLabel = computed(() => formatDuration(player.durationMs));
const posLabel = computed(() => formatDuration(shownMs.value));

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

const volumePercent = computed(() => (player.muted ? 0 : Math.round(player.volume * 100)));
function onVolume(percent: number) {
  player.setVolume(percent / 100);
}

function toggleMute() {
  player.setMuted(!player.muted);
}

/**
 * 桌面详情页展开入口（包 A）：点封面/标题区整块展开。
 * 区域里有真的链接（歌手可跳转），点链接时不能顺带展开 —— 拦下。
 */
/**
 * 迷你条左右滑动 = 上一首/下一首（用户拍板的手势交互）。
 *
 * 与点击展开的冲突处理：位移超过阈值即视为滑动，结束时置 swiped 旗标，
 * 随后到来的 click（浏览器在 touchend 后合成）会被 onMiniClick 吞掉。
 * 竖向位移大于横向时直接放弃手势 —— 让位给页面滚动。
 */
const miniDragX = ref(0);
const miniDragging = ref(false);
const SWIPE_TH = 60;
let touchStartX = 0, touchStartY = 0, gestureActive = false, swiped = false;

function onTouchStart(e: TouchEvent) {
  const t = e.touches[0];
  if (!t) return;
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  gestureActive = false;
  swiped = false;
}

function onTouchMove(e: TouchEvent) {
  const t = e.touches[0];
  if (!t) return;
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  if (!gestureActive && Math.abs(dy) > Math.abs(dx)) return;   // 竖向：不是我们的手势
  if (!gestureActive && Math.abs(dx) > 12) gestureActive = true;
  if (gestureActive) miniDragX.value = Math.max(-80, Math.min(80, dx));
}

function onTouchEnd(e: TouchEvent) {
  if (!gestureActive) return;
  const t = e.changedTouches[0];
  if (!t) return;
  const dx = t.clientX - touchStartX;
  miniDragX.value = 0;
  miniDragging.value = false;
  if (Math.abs(dx) >= SWIPE_TH) {
    swiped = true;
    if (dx < 0) player.next(); else player.prev();
  }
}

function onMiniClick() {
  if (swiped) { swiped = false; return; }   // 滑动结束后的合成 click 不展开
  emit('expand');
}

function onNowClick(e: MouseEvent) {
  const el = e.target as HTMLElement | null;
  if (el && el.closest('a, button')) return;
  emit('expand');
}
</script>

<template>
  <!-- ================= 移动迷你条 ================= -->
  <div
    v-if="props.compact"
    class="mini neu-raised-md"
    :class="{ dragging: miniDragging }"
    :style="miniDragging ? { transform: `translateX(${miniDragX}px)` } : undefined"
    @click="onMiniClick"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd"
    @touchcancel.passive="onTouchEnd"
  >
    <div class="mini-progress neu-inset" aria-hidden="true">
      <div class="mini-fill" :style="{ width: `${shownPercent}%` }" />
    </div>

    <div class="mini-cover">
      <img v-if="cover" :src="cover" :alt="track?.name || ''" />
      <span v-else class="mini-cover-ph" aria-hidden="true" />
    </div>

    <div class="mini-meta">
      <span class="mini-title neu-ellipsis">{{ track?.name || '未在播放' }}</span>
      <span class="mini-artist neu-ellipsis"><ArtistLinks :artists="track?.ar" /></span>
    </div>

    <!-- 点击播放键不应该顺带展开全屏播放页 -->
    <div class="mini-action" @click.stop>
      <NeuIconButton
        :icon="currentFav ? 'heart-filled' : 'heart'"
        :label="currentFav ? '取消收藏' : '收藏'"
        size="sm"
        :class="{ 'fav-on': currentFav }"
        :disabled="!track"
        @click="toggleCurrentFav"
      />
      <!-- 播放/暂停必须留在条上：手势（左右滑切歌）不可发现，播放键是唯一必见的控件 -->
      <NeuIconButton
        :icon="player.playing ? 'pause' : 'play'"
        :label="player.playing ? '暂停' : '播放'"
        size="md"
        :loading="player.loading || player.resolving"
        @click="player.toggle()"
      />
    </div>
  </div>

  <!-- ================= 桌面常驻条 ================= -->
  <div v-else class="bar neu-bg">
    <!-- 左：当前曲目（整块可点展开详情页；链接与按钮除外） -->
    <div
      class="now"
      role="button"
      tabindex="0"
      aria-label="展开播放详情页"
      @click="onNowClick"
      @keydown.enter="emit('expand')"
    >
      <div class="cover">
        <img v-if="cover" :src="cover" :alt="track?.name || ''" />
        <span v-else class="cover-ph" aria-hidden="true" />
        <!-- 音源状态灯：红=网易云 / 粉=B站，静态圆点 -->
        <span
          v-if="track"
          class="src-dot"
          :class="`src-${player.currentSource ?? 'bilibili'}`"
          :title="player.currentSource === 'netease' ? '音源：网易云' : '音源：B站'"
        />
      </div>
      <div class="meta">
        <span class="title neu-ellipsis">{{ track?.name || '未在播放' }}</span>
        <span class="artist neu-ellipsis">
          <ArtistLinks v-if="track" :artists="track.ar" />
          <template v-else>从搜索或首页选一首开始</template>
        </span>
      </div>
    </div>

    <!-- 中：模式 + 控制 + 进度 -->
    <div class="center">
      <div class="controls">
        <NeuIconButton
          :icon="modeIcon"
          :label="`播放模式：${modeLabel}`"
          size="md"
          @click="cycleMode"
        />
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

      <div class="progress">
        <span class="t neu-num">{{ posLabel }}</span>
        <!--
          滑块必须包一层并显式 `flex: 1 1 auto`。
          直接把它作为 flex 子项时会塌成 0 宽：它自己的样式里只有
          `min-width: 0`（防止内容撑破容器），并没有伸展因子 ——
          结果是进度条肉眼不可见、也点不到（实测由端到端验收抓到）。
        -->
        <div class="track-wrap">
          <NeuSlider
            :model-value="shownPercent"
            :buffered="bufferedPercent"
            :disabled="!track"
            aria-label="播放进度"
            @update:model-value="onScrubInput"
            @change="onScrubCommit"
          />
        </div>
        <span class="t neu-num">{{ totalLabel }}</span>
      </div>
    </div>

    <!-- 右：收藏 + 队列 + 音量 -->
    <div class="right">
      <NeuIconButton
        :icon="currentFav ? 'heart-filled' : 'heart'"
        :label="currentFav ? '取消收藏' : '收藏'"
        size="sm"
        :class="{ 'fav-on': currentFav }"
        :disabled="!track"
        @click="toggleCurrentFav"
      />
      <NeuIconButton
        icon="list"
        :label="queueOpen ? '收起队列' : '播放队列'"
        size="sm"
        @click="queueOpen = !queueOpen"
      />
      <NeuIconButton
        :icon="player.muted || player.volume === 0 ? 'volume-mute' : 'volume'"
        :label="player.muted ? '取消静音' : '静音'"
        size="sm"
        @click="toggleMute"
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

  <!-- 队列弹层：仅桌面条提供（移动端的全屏播放页在包 A 里接入） -->
  <QueuePanel v-if="!props.compact" :open="queueOpen" @close="queueOpen = false" />
</template>

<style scoped>
/* ---------------- 迷你条 ---------------- */
.mini {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  padding-top: calc(var(--sp-2) + 3px);
  border-radius: var(--r-lg);
  overflow: hidden;
  cursor: pointer;
  min-height: 58px;
  transition: transform 0.18s ease;
}
/* 拖动跟手时不做过渡（松手后的回弹才做） */
.mini.dragging {
  transition: none;
}
.mini.dragging * {
  pointer-events: none;   /* 拖动中不让子元素偷事件 */
}

.mini-progress {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  border-radius: 0;
  box-shadow: none;
  background: var(--track);
}
.mini-fill {
  height: 100%;
  background: var(--accent);
  transition: width 120ms linear;
}

.mini-cover,
.mini-cover img,
.mini-cover-ph {
  width: 42px;
  height: 42px;
  border-radius: var(--r-sm);
  flex: none;
}
.mini-cover-ph {
  display: block;
  background: var(--track);
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}
.mini-cover img {
  object-fit: cover;
  background: var(--track);
}

.mini-meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.mini-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.mini-artist {
  font-size: var(--fs-xs);
  color: var(--t2);
}
.mini-action {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

/* ---------------- 桌面条 ---------------- */
.bar {
  display: grid;
  grid-template-columns: minmax(0, 260px) minmax(0, 1fr) minmax(0, 200px);
  align-items: center;
  gap: var(--sp-5);
  padding: var(--sp-3) var(--sp-5);
  min-height: var(--playerbar-h);
  /* 与页面同底色，靠一条向上的高光把播放条"抬"起来 */
  box-shadow: inset 0 1px 0 var(--sl);
}

.now {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

.cover,
.cover img,
.cover-ph {
  width: 48px;
  height: 48px;
  border-radius: var(--r-md);
  flex: none;
}
.cover-ph {
  display: block;
  background: var(--track);
  box-shadow:
    inset 2px 2px 5px var(--sd),
    inset -2px -2px 5px var(--sl);
}
.cover img {
  object-fit: cover;
  background: var(--track);
  box-shadow:
    2px 2px 5px var(--sd),
    -2px -2px 5px var(--sl);
}

/* 音源状态灯：封面左下角的小圆点 */
.cover {
  position: relative;
}
.src-dot {
  position: absolute;
  left: -3px;
  bottom: -3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--bg);
  pointer-events: auto;
}
.src-dot.src-bilibili {
  background: var(--src-bili);
}
.src-dot.src-netease {
  background: var(--src-netease);
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.title {
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.artist {
  font-size: var(--fs-xs);
  color: var(--t2);
}

.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
  width: 100%;
  max-width: 620px;
  justify-self: center;
}

.controls {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}

.progress {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-width: 0;
}
.track-wrap {
  flex: 1 1 auto;
  min-width: 0;
}
.progress .t {
  color: var(--t2);
  min-width: 38px;
  text-align: center;
}

.right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  justify-content: flex-end;
}
.vol {
  width: 96px;
}

/* 已收藏的红心用强调色点亮，与未收藏的灰描边形成状态差 */
:deep(.fav-on) {
  color: var(--accent-text);
}
</style>
