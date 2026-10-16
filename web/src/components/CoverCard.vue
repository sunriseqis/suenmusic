<script setup lang="ts">
/**
 * 封面卡片：歌单 / 榜单 / 专辑 / 歌手共用。
 *
 * 一整块是凸起的，图片嵌在里面 —— 软拟物里图片本身就是一个"面"，
 * 不需要再给图片单独加框。
 */
import { computed } from 'vue';
import { coverUrl } from '@/utils/format.ts';

const props = withDefaults(
  defineProps<{
    title: string;
    cover?: string;
    /** 副标题，如播放量或更新频率 */
    subtitle?: string;
    /** 右下角的小角标，如"每日更新" */
    badge?: string;
    /** 顶部圆角形状：方形（专辑/歌单）或圆形（歌手） */
    shape?: 'square' | 'circle';
  }>(),
  { shape: 'square' }
);

const src = computed(() => coverUrl(props.cover, 500));
</script>

<template>
  <div class="card">
    <div class="art" :class="shape">
      <img v-if="src" :src="src" :alt="title" loading="lazy" />
      <span v-else class="ph" aria-hidden="true" />
      <span v-if="badge" class="badge">{{ badge }}</span>
    </div>

    <div class="meta">
      <span class="title neu-clamp-2">{{ title }}</span>
      <span v-if="subtitle" class="sub neu-ellipsis">{{ subtitle }}</span>
    </div>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
}

.art {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--r-lg);
  overflow: hidden;
  /* 封面整体凸起，与页面分层 */
  box-shadow:
    3px 3px 8px var(--sd),
    -3px -3px 8px var(--sl);
  transition:
    transform var(--dur-mid) var(--ease),
    box-shadow var(--dur-mid) var(--ease);
}
.art.circle {
  border-radius: 50%;
}

/* 悬停时微微抬起。幅度很小 —— 软拟物的动效应当是"呼吸"而不是"弹跳" */
.card:hover .art {
  transform: translateY(-2px);
  box-shadow:
    5px 5px 12px var(--sd),
    -5px -5px 12px var(--sl);
}

.art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
  background: var(--track);
}

.ph {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--bg);
  box-shadow:
    inset 3px 3px 8px var(--sd),
    inset -3px -3px 8px var(--sl);
}

.badge {
  position: absolute;
  right: var(--sp-2);
  bottom: var(--sp-2);
  padding: 2px var(--sp-2);
  border-radius: var(--r-pill);
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  line-height: 1.6;
  /* 角标压在图片上，必须有阴影才能从杂乱的封面里跳出来 */
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
:root[data-theme='dark'] .badge {
  color: #2b1a0e;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 0 var(--sp-1);
}
.title {
  font-size: var(--fs-sm);
  color: var(--t1);
  line-height: 1.4;
}
.sub {
  font-size: var(--fs-xs);
  color: var(--t2);
}
</style>
