<script setup lang="ts">
/**
 * 底部弹层。
 *
 * 设置页里的一次性任务（登入、备份、导入、去重）都走这里 ——
 * 它们是"做完就关"的动作，不该长期占着页面。
 */
import { onBeforeUnmount, watch } from 'vue';

const props = defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  open => {
    if (open) document.addEventListener('keydown', onKey);
    else document.removeEventListener('keydown', onKey);
  }
);
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="scrim" @click.self="emit('close')">
        <section class="sheet" role="dialog" aria-modal="true" :aria-label="title">
          <div class="grip" aria-hidden="true" />
          <header class="head">
            <span class="title">{{ title }}</span>
            <button type="button" class="close" @click="emit('close')">关闭</button>
          </header>
          <div class="body">
            <slot />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  background: var(--scrim);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.sheet {
  width: 100%;
  max-width: 520px;
  background: var(--panel);
  border-top: 1px solid var(--line);
  border-radius: 14px 14px 0 0;
  padding: 10px var(--sp-4) calc(var(--sp-5) + var(--safe-bottom));
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-height: 82vh;
}
.grip {
  width: 36px;
  height: 3px;
  border-radius: 2px;
  background: var(--line);
  align-self: center;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  font-size: var(--fs-md);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
.close {
  border: 0;
  background: transparent;
  color: var(--t2);
  font: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
}
.body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  overflow-y: auto;
  min-height: 0;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 200ms var(--ease);
}
.sheet-enter-active .sheet,
.sheet-leave-active .sheet {
  transition: transform 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .sheet,
.sheet-leave-to .sheet {
  transform: translateY(100%);
}
</style>
