<script setup lang="ts">
/**
 * 播放队列弹层（桌面）。
 *
 * 纯展示层：队列数据、跳播、移除全部走 player store 已有能力
 * （`jumpTo` / `removeAt`）。挂载在 body 上，用 fixed 定位停在
 * 播放条右上方 —— 播放条本身在布局流之外，跟着布局算位置反而对不齐。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import { registerBackHandler } from '@/native/back.ts';
import { usePlayerStore } from '@/stores/player.ts';
import { artistNames, coverUrl, formatDuration } from '@/utils/format.ts';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const player = usePlayerStore();

let offBack: (() => void) | null = null;
watch(
  () => props.open,
  isOpen => {
    if (isOpen) {
      offBack = registerBackHandler(() => {
        emit('close');
        return true;
      });
    } else {
      offBack?.();
      offBack = null;
    }
  },
  { immediate: true }
);
onBeforeUnmount(() => offBack?.());

const rows = computed(() =>
  player.queue.map((t, i) => ({
    track: t,
    index: i,
    isCurrent: i === player.index,
    cover: coverUrl(t.al?.picUrl, 150),
  }))
);

function jump(index: number) {
  void player.jumpTo(index);
}

function remove(index: number) {
  void player.removeAt(index);
}

// ---------------------------------------------------------------------------
// 移动端：右滑手势删除
// ---------------------------------------------------------------------------
const swipingTrackId = ref<string | null>(null);
const swipeOffset = ref(0);
const removingTrackId = ref<string | null>(null);

let touchStartX = 0;
let touchStartY = 0;
let isHorizontal = false;

function onTouchStart(e: TouchEvent, trackId: string) {
  if (removingTrackId.value) return;
  const touch = e.touches[0];
  if (!touch) return;
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  swipingTrackId.value = trackId;
  swipeOffset.value = 0;
  isHorizontal = false;
}

function onTouchMove(e: TouchEvent, trackId: string) {
  if (swipingTrackId.value !== trackId) return;
  const touch = e.touches[0];
  if (!touch) return;
  const diffX = touch.clientX - touchStartX;
  const diffY = touch.clientY - touchStartY;

  if (!isHorizontal) {
    if (Math.abs(diffX) > 8 && Math.abs(diffX) > Math.abs(diffY)) {
      isHorizontal = true;
    }
  }

  if (isHorizontal) {
    if (diffX > 0) {
      if (e.cancelable) e.preventDefault();
      // 右滑阻尼感
      swipeOffset.value = diffX > 150 ? 150 + (diffX - 150) * 0.25 : diffX;
    } else {
      swipeOffset.value = 0;
    }
  }
}

function onTouchEnd(index: number, trackId: string) {
  if (swipingTrackId.value !== trackId) return;
  const currentDiff = swipeOffset.value;
  if (currentDiff > 85) {
    // 超过阈值：平滑滑出并删除
    removingTrackId.value = trackId;
    swipeOffset.value = 360;
    setTimeout(() => {
      remove(index);
      removingTrackId.value = null;
      swipingTrackId.value = null;
      swipeOffset.value = 0;
    }, 200);
  } else {
    // 未达阈值：弹回原位
    swipeOffset.value = 0;
    setTimeout(() => {
      if (swipingTrackId.value === trackId) {
        swipingTrackId.value = null;
      }
    }, 200);
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="qp">
      <div v-if="props.open" class="qp-root" @click.self="emit('close')">
        <section class="panel neu-raised-md" role="dialog" aria-label="播放队列">
          <header class="head">
            <span class="head-title">播放队列</span>
            <span class="head-count neu-num neu-t2">{{ rows.length }} 首</span>
            <button type="button" class="head-close" aria-label="关闭队列" @click="emit('close')">
              <NeuIcon name="close" :size="16" />
            </button>
          </header>

          <p v-if="rows.length === 0" class="empty neu-t2">队列是空的，去挑几首吧。</p>

          <ul v-else class="list">
            <li
              v-for="row in rows"
              :key="row.track.id"
              class="item-wrapper"
              :class="{ 'is-removing': removingTrackId === row.track.id }"
            >
              <!-- 底层滑动删除背景 -->
              <div class="swipe-delete-bg" aria-hidden="true">
                <NeuIcon name="close" :size="15" />
                <span>移除</span>
              </div>

              <!-- 顶层项目内容 -->
              <div
                class="item"
                :class="{
                  current: row.isCurrent,
                  'is-swiping': swipingTrackId === row.track.id
                }"
                :style="swipingTrackId === row.track.id ? { transform: `translateX(${swipeOffset}px)` } : {}"
                @touchstart="onTouchStart($event, row.track.id)"
                @touchmove="onTouchMove($event, row.track.id)"
                @touchend="onTouchEnd(row.index, row.track.id)"
              >
                <button
                  type="button"
                  class="item-main"
                  :aria-label="`播放 ${row.track.name}`"
                  @click="jump(row.index)"
                >
                  <span v-if="row.isCurrent" class="bars" aria-hidden="true">
                    <i /><i /><i />
                  </span>
                  <span v-else class="neu-num num">{{ row.index + 1 }}</span>

                  <span class="cov">
                    <img v-if="row.cover" :src="row.cover" :alt="''" loading="lazy" />
                    <span v-else class="cov-ph" aria-hidden="true" />
                  </span>

                  <span class="meta">
                    <span class="name neu-ellipsis">{{ row.track.name }}</span>
                    <span class="artist neu-ellipsis">{{ artistNames(row.track.ar) }}</span>
                  </span>

                  <span class="dur neu-num">{{ formatDuration(row.track.dt) }}</span>
                </button>
                <button
                  type="button"
                  class="item-remove"
                  :aria-label="`从队列移除 ${row.track.name}`"
                  title="从队列移除"
                  @click="remove(row.index)"
                >
                  <NeuIcon name="close" :size="14" />
                </button>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.qp-root {
  position: fixed;
  inset: 0;
  z-index: 60;
  /* 不加遮罩暗化：队列只是个旁挂面板，全屏变暗太重 */
  pointer-events: none;
}

.panel {
  pointer-events: auto;
  position: absolute;
  right: var(--sp-4);
  bottom: calc(var(--playerbar-h) + var(--sp-4));
  width: 380px;
  max-width: calc(100vw - 2 * var(--sp-4));
  max-height: min(60vh, 520px);
  display: flex;
  flex-direction: column;
  border-radius: var(--r-lg);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--track);
}
.head-title {
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.head-count {
  flex: 1 1 auto;
  font-size: var(--fs-xs);
}
.head-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: none;
  color: var(--t2);
  cursor: pointer;
  border-radius: var(--r-sm);
}
.head-close:hover {
  color: var(--t1);
}

.empty {
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
}

.list {
  /* 平铺：行间用发丝线分格，不做卡片容器 */
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  min-height: 0;
}

.item {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  border-radius: var(--r-md);
}
.item-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: none;
  background: none;
  color: var(--t1);
  cursor: pointer;
  text-align: left;
  border-radius: var(--r-md);
  font-size: inherit;
}
.item:hover .item-main {
  background: var(--panel-2);
}
.item.current {
  background: var(--panel-2);
  box-shadow: inset 2px 0 0 var(--accent);
}
.item.current .name {
  color: var(--accent-text);
  font-weight: var(--fw-medium);
}

.num {
  min-width: 20px;
  text-align: center;
  color: var(--t2);
  font-size: var(--fs-xs);
}

/* 与 TrackRow 一致的三根跳动竖条（当前播放项指示） */
.bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
  min-width: 20px;
  justify-content: center;
}
.bars i {
  width: 2px;
  background: var(--accent);
  border-radius: 1px;
  animation: bounce 1s var(--ease) infinite;
}
.bars i:nth-child(1) {
  height: 60%;
}
.bars i:nth-child(2) {
  height: 100%;
  animation-delay: 160ms;
}
.bars i:nth-child(3) {
  height: 45%;
  animation-delay: 320ms;
}
@keyframes bounce {
  0%,
  100% {
    transform: scaleY(0.5);
  }
  50% {
    transform: scaleY(1);
  }
}

.cov,
.cov img,
.cov-ph {
  width: 36px;
  height: 36px;
  border-radius: var(--r-sm);
  flex: none;
}
.cov-ph {
  display: block;
  background: var(--panel-2);
}
.cov img {
  object-fit: cover;
  background: var(--track);
}

.meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.name {
  font-size: var(--fs-sm);
}
.artist {
  font-size: var(--fs-xs);
  color: var(--t2);
}
.dur {
  flex: none;
  font-size: var(--fs-xs);
  color: var(--t2);
}

.item-wrapper {
  position: relative;
  overflow: hidden;
  border-radius: 0;
}
.item-wrapper + .item-wrapper {
  border-top: 1px solid var(--line);
}
.item-wrapper.is-removing {
  transition: max-height 0.2s var(--ease), margin 0.2s var(--ease), opacity 0.2s var(--ease);
  max-height: 0;
  margin: 0;
  opacity: 0;
}

.swipe-delete-bg {
  position: absolute;
  inset: 0;
  background: #b3261e;
  color: #fff;
  display: flex;
  align-items: center;
  padding-left: var(--sp-4);
  gap: var(--sp-1);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  border-radius: var(--r-md);
}
:root[data-theme='dark'] .swipe-delete-bg {
  background: #8a1f18;
  color: #ffdad6;
}

.item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  border-radius: var(--r-md);
  background: var(--bg);
  transition: transform var(--dur-fast) var(--ease);
  z-index: 1;
}
.item.is-swiping {
  transition: none;
}

.item-remove {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  background: none;
  color: var(--t2);
  cursor: pointer;
  border-radius: var(--r-sm);
  opacity: 0;
}
.item:hover .item-remove,
.item-remove:focus-visible {
  opacity: 1;
}
.item-remove:hover {
  color: var(--accent-text);
}
.item-remove:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: -1px;
}

/* 进出场：从播放条方向浮起 */
.qp-enter-active,
.qp-leave-active {
  transition: opacity 160ms var(--ease);
}
.qp-enter-active .panel,
.qp-leave-active .panel {
  transition: transform 160ms var(--ease);
}
.qp-enter-from,
.qp-leave-to {
  opacity: 0;
}
.qp-enter-from .panel,
.qp-leave-to .panel {
  transform: translateY(12px);
}

@media (max-width: 1023px) {
  .qp-root {
    pointer-events: auto;
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(2px);
  }
  .panel {
    right: var(--sp-3);
    left: var(--sp-3);
    width: auto;
    max-width: none;
    bottom: calc(var(--safe-bottom) + var(--sp-3));
    max-height: 70vh;
  }
  .item-remove {
    opacity: 0.5;
  }
}
</style>
