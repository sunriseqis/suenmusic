<script setup lang="ts">
/**
 * 提示条容器。
 *
 * 挂在 App 根部，位置固定在底部中间 —— 移动端底部有导航栏，所以
 * 整体要往上抬一个导航高度，否则会被盖住。
 *
 * 类型区分用**左侧色条**而不是 emoji 图标（项目硬性规则：UI 里禁止 emoji）。
 */
import { useUiStore } from '@/stores/ui.ts';

const ui = useUiStore();
</script>

<template>
  <div class="toast-layer" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="toast neu-raised-md"
        :class="`k-${t.kind}`"
        @click="ui.dismissToast(t.id)"
      >
        <span class="bar" aria-hidden="true" />
        <span class="text">{{ t.text }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-layer {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  /* 底部留出播放条 + 移动导航的高度，避免被遮挡 */
  bottom: calc(var(--playerbar-h) + var(--sp-5) + var(--safe-bottom));
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  /* 容器不能吃掉点击 —— 只有提示条本身可点 */
  pointer-events: none;
  max-width: min(92vw, 460px);
}

@media (max-width: 1023px) {
  .toast-layer {
    bottom: calc(var(--mobile-nav-h) + var(--sp-4) + var(--safe-bottom));
  }
}

.toast {
  display: flex;
  align-items: stretch;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  pointer-events: auto;
  cursor: pointer;
  max-width: 100%;
}

.bar {
  width: 3px;
  border-radius: var(--r-pill);
  flex: none;
  background: var(--t2);
}

/* 成功 / 失败都用强调色的两个极端：成功用强调色本身，
   失败用一个偏暗的红 —— 不引入第五种颜色面，但要能一眼区分 */
.k-ok .bar {
  background: var(--accent);
}
.k-err .bar {
  background: #b3261e;
}
:root[data-theme='dark'] .k-err .bar {
  background: #ff9a92;
}

.text {
  color: var(--t1);
  font-size: var(--fs-sm);
  line-height: 1.5;
  word-break: break-word;
}

/* 进出场：从下方滑入并淡出，幅度刻意小 —— 软拟物整体是安静的 */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur-mid) var(--ease),
    transform var(--dur-mid) var(--ease);
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.toast-move {
  transition: transform var(--dur-mid) var(--ease);
}
</style>
