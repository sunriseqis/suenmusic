<script setup lang="ts">
/**
 * 头像。
 *
 * 没有头像图时退化成一个凹陷的圆 + 首字 —— 不用占位图，
 * 也不用 emoji（项目硬性规则）。
 */
import { computed } from 'vue';
import { coverUrl } from '@/utils/format.ts';

const props = withDefaults(
  defineProps<{
    src?: string;
    name?: string;
    size?: number;
    /** 圆形（歌手/用户）还是方形圆角（专辑/歌单） */
    shape?: 'circle' | 'square';
  }>(),
  { size: 40, shape: 'circle' }
);

const initial = computed(() => (props.name || '').trim().charAt(0) || '?');
const resolved = computed(() => (props.src ? coverUrl(props.src, 150) : ''));
</script>

<template>
  <div
    class="avatar"
    :class="[shape, resolved ? '' : 'placeholder']"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }"
  >
    <img v-if="resolved" :src="resolved" :alt="name || ''" loading="lazy" />
    <span v-else aria-hidden="true">{{ initial }}</span>
  </div>
</template>

<style scoped>
.avatar {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--t2);
  font-weight: var(--fw-medium);
  /* 图片是一块贴上去的板：一条发丝线 + 顶沿高光 */
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--hi);
}
.circle {
  border-radius: 50%;
}
.square {
  border-radius: var(--r-md);
}
.placeholder {
  /* 无图时是凹的，暗示"这里本该有内容" */
  border: 1px solid var(--line);
  box-shadow: inset 0 2px 6px var(--lo);
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
  background: var(--track);
}
</style>
