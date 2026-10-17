<script setup lang="ts">
/**
 * 圆形图标按钮。用于播放控制、侧边栏折叠等。
 *
 * `aria-label` 是必填的 —— 图标按钮没有可见文字，没有 label
 * 屏幕阅读器就完全读不出它是干什么的。
 */
import { computed } from 'vue';
import NeuIcon from './NeuIcon.vue';
import type { IconName } from './NeuIcon.vue';

const props = withDefaults(
  defineProps<{
    icon: IconName;
    label: string;
    /** 主按钮：强调色填充 */
    primary?: boolean;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** 方形（大圆角）。页面级操作按钮用，与圆形的控制按钮区分 */
    square?: boolean;
    /** 选中态（凹陷），如"已收藏" */
    active?: boolean;
    disabled?: boolean;
    loading?: boolean;
  }>(),
  { primary: false, size: 'md', active: false, disabled: false, loading: false }
);

const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>();

/** 图标比按钮外壳小一圈，视觉上才"装得进去" */
const ICON_SIZE: Record<'sm' | 'md' | 'lg' | 'xl', number> = { sm: 15, md: 18, lg: 21, xl: 26 };
const PX_SIZE: Record<'sm' | 'md' | 'lg' | 'xl', number> = { sm: 28, md: 36, lg: 44, xl: 60 };

const iconSize = computed(() => ICON_SIZE[props.size]);
const boxSize = computed(() => PX_SIZE[props.size]);
const blocked = computed(() => props.disabled || props.loading);
</script>

<template>
  <button
    type="button"
    class="neu-icon-btn neu-clickable neu-focusable"
    :class="[
      `s-${size}`,
      square ? 'square' : '',
      primary ? 'primary' : '',
      active && !primary ? 'neu-selected' : '',
      blocked ? 'neu-disabled' : '',
    ]"
    :style="{ width: `${boxSize}px`, height: `${boxSize}px` }"
    :aria-label="label"
    :title="label"
    :aria-pressed="active || undefined"
    :disabled="blocked"
    @click="emit('click', $event)"
  >
    <span v-if="loading" class="spinner" />
    <NeuIcon v-else :name="icon" :size="iconSize" />
  </button>
</template>

<style scoped>
.neu-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 与设计稿一致：圆角键（不是圆形，也不是直角） */
  border-radius: var(--r-md);
  padding: 0;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--t1);
  box-shadow: inset 0 1px 0 var(--hi);
  flex: none;
}

.neu-icon-btn.square { border-radius: var(--r-md); }


.neu-icon-btn:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: inset 0 2px 7px var(--lo);
}

.primary {
  color: #1a1206;
  background: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 70%, #000);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28);
}
:root[data-theme='light'] .primary { color: #fff; }

/* 选中（已收藏等）：不换色，只把键按下去 */
.neu-icon-btn.neu-selected {
  color: var(--accent-text);
  background: var(--panel-2);
  box-shadow: inset 0 2px 7px var(--lo);
}

.spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
