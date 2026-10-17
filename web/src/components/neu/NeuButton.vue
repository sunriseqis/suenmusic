<script setup lang="ts">
/**
 * 软拟物按钮。
 *
 * 视觉上只有三种状态，全部由 CSS 承担（见 neu.css 的 .neu-clickable）：
 * 凸起 → 悬停（文字提亮）→ 按下（凹陷 + 缩放）。
 *
 * `variant="primary"` 用强调色**填充**（--accent，对比度达标的是背景而不是文字，
 * 所以文字用白色）；`variant="ghost"` 文字用 --accent-text。
 * 这正是「强调色必须拆填充用与文字用」这条铁律的落地（PLAN.md 3.2 铁律 2）。
 */
const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    /** 撑满父容器宽度 */
    block?: boolean;
    disabled?: boolean;
    loading?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }>(),
  {
    variant: 'default',
    size: 'md',
    block: false,
    disabled: false,
    loading: false,
    type: 'button',
  }
);

const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>();

function onClick(ev: MouseEvent) {
  if (props.disabled || props.loading) {
    ev.preventDefault();
    ev.stopPropagation();
    return;
  }
  emit('click', ev);
}
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    class="neu-btn neu-clickable neu-focusable"
    :class="[
      `v-${variant}`,
      `s-${size}`,
      block ? 'block' : '',
      disabled || loading ? 'neu-disabled' : '',
    ]"
    @click="onClick"
  >
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.neu-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  min-height: 36px;
  border: 1px solid transparent;
  border-radius: var(--r-md);
}

.block { width: 100%; }

.s-sm { min-height: 30px; padding: 0 var(--sp-3); font-size: var(--fs-sm); }
.s-md { min-height: 40px; padding: 0 var(--sp-4); font-size: var(--fs-md); }
.s-lg { min-height: 48px; padding: 0 var(--sp-5); font-size: var(--fs-lg); }

/* ---- 变体 ---- */

/* 默认：一块装在面板上的键 */
.v-default {
  color: var(--t1);
  background: var(--panel);
  border-color: var(--line);
  box-shadow: inset 0 1px 0 var(--hi);
}
.v-default:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: inset 0 2px 7px var(--lo);
}

/* 主按钮：琥珀填充，深色字（深色主题）/ 白字（纸白主题） */
.v-primary {
  color: #1a1206;
  background: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 70%, #000);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28);
}
:root[data-theme='light'] .v-primary {
  color: #fff;
}
.v-primary:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: inset 0 2px 7px rgba(0, 0, 0, 0.35);
}

/* 幽灵：没有厚度，只有文字 */
.v-ghost {
  color: var(--accent-text);
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}
.v-ghost:hover:not(:disabled) { text-decoration: underline; }
.v-ghost:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: none;
}

/* 危险：只用文字色，不做红色填充 */
.v-danger {
  color: #d4564a;
  background: transparent;
  border-color: transparent;
}
:root[data-theme='light'] .v-danger { color: #a8322a; }

.spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: spin 0.7s linear infinite;
  flex: none;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
