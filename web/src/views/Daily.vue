<script setup lang="ts">
/**
 * 每日专属推荐。
 *
 * 数据来自服务端的 AI 推荐流（受控画像 + 严格比例 + 审核把关），全天固定。
 * 懒加载：当天首次打开时触发生成，前端呈现多源文案轮播与轮询；就绪后即时返回。
 * 列表保持极简沉浸，无任何标签；推荐理由在正在播放详情页优雅露出。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuSkeleton from '@/components/neu/NeuSkeleton.vue';
import TrackRow from '@/components/TrackRow.vue';
import { ApiError } from '@/api/client.ts';
import { fetchDailyRecommend } from '@/api/recommend.ts';
import { parseAiHeader } from '@/utils/format.ts';
import { usePlayerStore } from '@/stores/player.ts';
import { useDislikesStore } from '@/stores/dislikes.ts';
import { useUiStore } from '@/stores/ui.ts';
import type { Track } from '@/api/types.ts';

const player = usePlayerStore();
const ui = useUiStore();
const dislikes = useDislikesStore();

const PLEASANT_COPIES = [
  '正在为你挑选今日专属歌单…',
  '正在聆听你的音乐印记…',
  '正在穿梭曲库寻觅共鸣…',
  'AI 正在为你细细甄选…',
  '今日心动旋律正在调配中…',
  '正在把控今日专属风格比例…',
];

const loading = ref(true);
const status = ref<'ready' | 'generating' | 'shortfall' | 'error'>('generating');
const errorText = ref('');
const tracks = ref<Track[]>([]);
const greeting = ref('');

const headerInfo = computed(() => parseAiHeader(greeting.value, '专属推荐'));
const headerTitle = computed(() => headerInfo.value.title);
const headerSub = computed(() => headerInfo.value.sub);

const copyIndex = ref(0);
const currentCopy = computed(() => PLEASANT_COPIES[copyIndex.value % PLEASANT_COPIES.length]);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let copyTimer: ReturnType<typeof setInterval> | null = null;

const isEmpty = computed(() => status.value === 'ready' && tracks.value.length === 0);
const list = computed(() => tracks.value);

function startCopyRotation() {
  stopCopyRotation();
  copyTimer = setInterval(() => {
    copyIndex.value = (copyIndex.value + 1) % PLEASANT_COPIES.length;
  }, 3200);
}

function stopCopyRotation() {
  if (copyTimer) {
    clearInterval(copyTimer);
    copyTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const res = await fetchDailyRecommend();
      if (res.status === 'ready') {
        stopPolling();
        stopCopyRotation();
        tracks.value = res.tracks;
        greeting.value = res.greeting || '';
        status.value = 'ready';
        loading.value = false;
      } else if (res.status === 'shortfall') {
        stopPolling();
        stopCopyRotation();
        status.value = 'shortfall';
        loading.value = false;
      } else if (res.status === 'error') {
        stopPolling();
        stopCopyRotation();
        status.value = 'error';
        errorText.value = res.message || '生成失败，请稍后重试';
        loading.value = false;
      }
    } catch {
      // 轮询偶发网络抖动静默，继续下一次尝试
    }
  }, 4000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function load(force = false) {
  loading.value = true;
  errorText.value = '';
  try {
    const res = await fetchDailyRecommend({ force });
    status.value = res.status;
    if (res.status === 'ready') {
      tracks.value = res.tracks;
      greeting.value = res.greeting || '';
      loading.value = false;
    } else if (res.status === 'generating') {
      startCopyRotation();
      startPolling();
    } else if (res.status === 'shortfall') {
      loading.value = false;
    } else {
      errorText.value = res.message || '生成专属推荐失败';
      loading.value = false;
    }
  } catch (e) {
    status.value = 'error';
    errorText.value =
      e instanceof ApiError ? e.message : '每日推荐加载失败，请稍后重试';
    loading.value = false;
  }
}

/**
 * 把一首歌从"当日歌单 + 播放队列"里同时摘掉。自然缩水，不补位。
 */
function removeFromList(track: Track): void {
  const qi = player.queue.findIndex(t => t.id === track.id);
  if (qi >= 0) void player.removeAt(qi);
  tracks.value = tracks.value.filter(t => t.id !== track.id);
}

async function dislikeTrack(track: Track) {
  try {
    await dislikes.add('track', track.id, track.name);
    ui.ok(`已不再推荐「${track.name}」`);
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '操作失败，请稍后重试');
    return;
  }
  removeFromList(track);
}

async function dislikeArtist(track: Track) {
  const mid = track.ar?.[0]?.mid || '';
  const name = track.ar?.[0]?.name || '';
  if (!mid) {
    ui.err('这首曲目没有可识别的歌手信息');
    return;
  }
  try {
    await dislikes.add('artist', mid, name);
    ui.ok(`已不再推荐歌手「${name}」的相关歌曲`);
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '操作失败，请稍后重试');
    return;
  }
  // 该歌手的所有歌都从当日歌单与队列里移除
  for (const t of tracks.value.filter(x => x.ar?.[0]?.mid === mid)) {
    removeFromList(t);
  }
}

onMounted(() => void load());

onBeforeUnmount(() => {
  stopPolling();
  stopCopyRotation();
});
</script>

<template>
  <div class="daily neu-container" data-view="daily">
    <header class="head">
      <div class="head-info">
        <h1 class="title neu-t1" :title="headerTitle">
          {{ headerTitle }}
        </h1>
        <p v-if="headerSub" class="sub neu-t2">{{ headerSub }}</p>
      </div>
    </header>

    <!-- 生成中轮播状态 -->
    <div v-if="status === 'generating'" class="generating neu-raised-md">
      <div class="gen-box">
        <div class="spin-disc" aria-hidden="true">
          <NeuIcon name="sparkles" :size="28" class="disc-icon" />
        </div>
        <p class="gen-text neu-ellipsis">{{ currentCopy }}</p>
      </div>
      <div class="skeleton-wrap">
        <NeuSkeleton :lines="5" height="52px" />
      </div>
    </div>

    <!-- 错误状态 -->
    <div v-else-if="status === 'error' || errorText" class="empty neu-raised-md">
      <p>{{ errorText || '推荐生成遇到问题，请重试' }}</p>
      <NeuButton @click="load(true)">重试</NeuButton>
    </div>

    <!-- 曲库不足状态 -->
    <div v-else-if="status === 'shortfall' || isEmpty" class="empty neu-raised-md">
      <p>
        还没有足够的音乐偏好数据。<br />
        先去<strong>收藏几首歌</strong>，明天再来为你定制专属歌单。
      </p>
    </div>

    <!-- 推荐曲目列表（纯粹沉浸，无任何标签干扰） -->
    <div v-else class="list neu-raised-md">
      <TrackRow
        v-for="(t, i) in list"
        :key="t.id"
        :track="t"
        :index="i + 1"
        :list="list"
        dislikeable
        @dislike-track="dislikeTrack"
        @dislike-artist="dislikeArtist"
      />
    </div>
  </div>
</template>

<style scoped>
.daily {
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
}
.sub {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--t2);
  max-width: 780px;
}

.generating {
  padding: var(--sp-5) var(--sp-4);
  border-radius: var(--r-xl);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.gen-box {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
}
.spin-disc {
  display: flex;
  align-items: center;
  justify-content: center;
  animation: disc-spin 3s linear infinite;
  color: var(--p-primary, #6366f1);
}
@keyframes disc-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.gen-text {
  margin: 0;
  font-size: var(--fs-base);
  font-weight: var(--fw-medium);
  color: var(--t1);
  letter-spacing: 0.03em;
  transition: opacity 0.3s ease;
}

.skeleton-wrap {
  padding-top: var(--sp-2);
}

.list {
  padding: var(--sp-2);
  border-radius: var(--r-xl);
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
  .daily {
    padding-bottom: 0;
  }
  .title {
    font-size: var(--fs-xl);
  }
}
</style>
