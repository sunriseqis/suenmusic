<script setup lang="ts">
/**
 * 骨架屏。
 *
 * 软拟物的骨架不能用灰色方块 —— 整页同底色的体系里，唯一的暗色就是阴影。
 * 所以骨架是「凹陷的、会呼吸的」形状。
 */
withDefaults(
  defineProps<{
    width?: string;
    height?: string;
    radius?: 'sm' | 'md' | 'lg' | 'xl' | 'pill';
    /** 一次渲染多行，最后一行略短，像真实段落 */
    lines?: number;
  }>(),
  { width: '100%', height: '16px', radius: 'md', lines: 0 }
);
</script>

<template>
  <div v-if="lines > 0" class="stack">
    <div
      v-for="i in lines"
      :key="i"
      class="neu-skeleton"
      :class="`r-${radius}`"
      :style="{ width: i === lines && lines > 1 ? '62%' : width, height }"
    />
  </div>
  <div v-else class="neu-skeleton" :class="`r-${radius}`" :style="{ width, height }" />
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  width: 100%;
}
.r-sm {
  border-radius: var(--r-sm);
}
.r-md {
  border-radius: var(--r-md);
}
.r-lg {
  border-radius: var(--r-lg);
}
.r-xl {
  border-radius: var(--r-xl);
}
.r-pill {
  border-radius: var(--r-pill);
}
</style>
