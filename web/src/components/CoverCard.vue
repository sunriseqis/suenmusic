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
  border-radius: var(--r-md);
  overflow: hidden;
  /* 一块贴上去的板：发丝线 + 顶沿高光，不外投影 */
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--hi);
  transition: border-color var(--dur-mid) var(--ease);
}
.art.circle {
  border-radius: 50%;
}

/* 悬停时微微抬起。幅度很小 —— 软拟物的动效应当是"呼吸"而不是"弹跳" */
.card:hover .art {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
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
  background: var(--panel-2);
}

.badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 5px;
  border-radius: 2px;
  background: var(--accent);
  color: #1a1206;
  font-size: 10px;
  line-height: 1.5;
  letter-spacing: 0.08em;
}
:root[data-theme='light'] .badge {
  color: #fff;
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
