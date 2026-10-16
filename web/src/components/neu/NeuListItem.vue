<script setup lang="ts">
/**
 * 列表项。
 *
 * 密集列表里**不给每一行加凸起** —— 那样整页会糊成一片（PLAN.md 3.4）。
 * 所以这里的默认视觉是「平的」，只在悬停时给极轻的凹陷提示，
 * 选中时才用完整的凹陷。
 *
 * `to` 有值时渲染为 router-link，`href` 有值渲染为 a，都没有则渲染为
 * `button`（有 `@click` 时）或 `div`。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    to?: string;
    href?: string;
    /** 当前项（凹陷） */
    selected?: boolean;
    disabled?: boolean;
    radius?: 'sm' | 'md' | 'lg';
    padding?: '1' | '2' | '3';
  }>(),
  { selected: false, disabled: false, radius: 'md', padding: '2' }
);

const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>();

const tag = computed(() => {
  if (props.disabled) return 'div';
  if (props.to) return 'router-link';
  if (props.href) return 'a';
  return 'button';
});

const bindings = computed(() => {
  if (props.disabled) return {};
  if (props.to) return { to: props.to };
  if (props.href) return { href: props.href, target: '_blank', rel: 'noreferrer' };
  return { type: 'button' as const };
});
</script>

<template>
  <component
    :is="tag"
    v-bind="bindings"
    class="item neu-clickable neu-focusable"
    :class="[
      `r-${radius}`,
      `p-${padding}`,
      selected ? 'neu-selected' : '',
      disabled ? 'neu-disabled' : '',
    ]"
    :aria-current="selected ? 'page' : undefined"
    @click="emit('click', $event)"
  >
    <slot />
  </component>
</template>

<style scoped>
.item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-width: 0;
  text-align: left;
  color: var(--t1);
  text-decoration: none;
  /* 移动端触摸目标下限 */
  min-height: 44px;
  background: var(--bg);
  transition:
    box-shadow var(--dur-fast) var(--ease),
    background-color var(--dur-fast) var(--ease);
}
.item:hover {
  text-decoration: none;
}

/* 悬停只给最轻的凹陷 —— 密集列表里任何"浮起"都会互相干扰 */
.item:hover:not(.neu-disabled):not(.neu-selected) {
  box-shadow:
    inset 1px 1px 2px var(--sd),
    inset -1px -1px 2px var(--sl);
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

.p-1 {
  padding: var(--sp-2) var(--sp-2);
}
.p-2 {
  padding: var(--sp-2) var(--sp-3);
}
.p-3 {
  padding: var(--sp-3) var(--sp-4);
}
</style>
