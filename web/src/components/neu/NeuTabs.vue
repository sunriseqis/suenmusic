<script setup lang="ts">
/**
 * 分段标签页。
 *
 * 选中项用**凹陷**表达，而不是加背景色 —— 铁律：全局只用一种强调色，
 * 而这里连强调色都不该用（搜索结果有四个分片，全染成橙色会非常吵）。
 */
import { computed } from 'vue';

export interface TabItem {
  value: string;
  label: string;
  /** 可选的计数徽标，如各分片的结果条数 */
  count?: number;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    items: TabItem[];
    /** 撑满宽度均分 */
    block?: boolean;
    disabled?: boolean;
  }>(),
  { block: false, disabled: false }
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const activeIndex = computed(() => props.items.findIndex(i => i.value === props.modelValue));

function onKeydown(ev: KeyboardEvent) {
  if (props.disabled) return;
  const dir = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
  if (dir === 0) return;
  ev.preventDefault();
  const next = (activeIndex.value + dir + props.items.length) % props.items.length;
  const item = props.items[next];
  if (item) emit('update:modelValue', item.value);
}
</script>

<template>
  <div
    class="tabs"
    :class="[block ? 'block' : '', disabled ? 'is-disabled' : '']"
    role="tablist"
    @keydown="onKeydown"
  >
    <button
      v-for="item in items"
      :key="item.value"
      type="button"
      role="tab"
      class="tab neu-focusable"
      :class="item.value === modelValue ? 'neu-selected' : ''"
      :aria-selected="item.value === modelValue"
      :tabindex="item.value === modelValue ? 0 : -1"
      :disabled="disabled"
      @click="emit('update:modelValue', item.value)"
    >
      <span>{{ item.label }}</span>
      <span v-if="item.count !== undefined" class="count neu-num">{{ item.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1);
  border-radius: var(--r-pill);
  background: var(--bg);
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
  /* 分片多的时候允许横向滚动而不是换行挤成两行 */
  overflow-x: auto;
  scrollbar-width: none;
  max-width: 100%;
}
.tabs::-webkit-scrollbar {
  display: none;
}

.block {
  display: flex;
  width: 100%;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  min-height: 34px;
  border-radius: var(--r-pill);
  color: var(--t2);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  flex: none;
  transition:
    color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.block .tab {
  flex: 1 1 auto;
  justify-content: center;
}

.tab:hover:not(:disabled) {
  color: var(--t1);
}

/* 选中：凹陷 + 主文字色。凹陷由 .neu-selected 提供 */
.tab[aria-selected='true'] {
  color: var(--t1);
  font-weight: var(--fw-bold);
}

.count {
  color: var(--t2);
  font-size: 11px;
  opacity: 0.85;
}

.is-disabled {
  opacity: 0.55;
}
</style>
