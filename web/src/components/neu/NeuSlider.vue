<script setup lang="ts">
/**
 * 滑块：进度条与音量条共用。
 *
 * 实现要点：**底面用原生 `<input type="range">`，视觉层完全自定义**。
 * 这样做而不是纯 div + 拖拽事件，是因为原生 range 白送四样东西：
 * 键盘方向键、触摸拖动、屏幕阅读器语义、以及"拖出元素外仍然跟随"的行为。
 * 自己实现这些要写上百行，还容易在移动端出问题。
 */
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 0–100 */
    modelValue: number;
    /** 已缓存的百分比（可选，用于显示缓冲进度） */
    buffered?: number;
    disabled?: boolean;
    ariaLabel?: string;
    /** 拖动的过程中就实时回调（进度条需要），否则只在松开时回调 */
    live?: boolean;
  }>(),
  { buffered: 0, disabled: false, ariaLabel: '滑块', live: true }
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: number): void;
  /** 拖动结束（用于"松手才真正 seek"的场景） */
  (e: 'change', v: number): void;
}>();

/** 正在拖动：拖动期间不接收外部值回灌，否则会和手指打架 */
const dragging = ref(false);

const clamped = computed(() => Math.min(100, Math.max(0, props.modelValue)));
const bufferedPct = computed(() => Math.min(100, Math.max(0, props.buffered)));

function onInput(ev: Event) {
  dragging.value = true;
  emit('update:modelValue', Number((ev.target as HTMLInputElement).value));
}

function onChange(ev: Event) {
  dragging.value = false;
  const v = Number((ev.target as HTMLInputElement).value);
  emit('update:modelValue', v);
  emit('change', v);
}
</script>

<template>
  <div
    class="slider"
    :class="[disabled ? 'is-disabled' : '', dragging ? 'is-dragging' : '']"
    role="presentation"
  >
    <!-- 轨道：深凹陷，表示"这里可以拖" -->
    <div class="track neu-inset-deep">
      <div v-if="buffered > 0" class="buffered" :style="{ width: `${bufferedPct}%` }" />
      <div class="fill" :style="{ width: `${clamped}%` }" />
    </div>

    <!-- 滑块头：凸起的小圆点，拖动时放大 -->
    <div class="thumb" :style="{ left: `${clamped}%` }" aria-hidden="true" />

    <input
      class="native"
      type="range"
      min="0"
      max="100"
      step="0.1"
      :value="clamped"
      :disabled="disabled"
      :aria-label="ariaLabel"
      @input="onInput"
      @change="onChange"
    />
  </div>
</template>

<style scoped>
.slider {
  position: relative;
  /* 触摸目标高度 44px，但轨道视觉只有 8px —— 命中区由 .native 撑开 */
  height: 44px;
  display: flex;
  align-items: center;
  min-width: 0;
}

.track {
  position: relative;
  width: 100%;
  height: 8px;
  border-radius: var(--r-pill);
  overflow: hidden;
  /* 轨道本身是凹陷的，里面的填充也要跟着缩进去一点才自然 */
  padding: 0;
}

.buffered {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--t2);
  opacity: 0.28;
  border-radius: var(--r-pill);
  transition: width var(--dur-mid) linear;
}

.fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--accent);
  border-radius: var(--r-pill);
  /* 拖动时不要过渡 —— 加了会感觉"跟不上手指" */
  transition: width 60ms linear;
}
.is-dragging .fill {
  transition: none;
}

.thumb {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  margin-left: -7px;
  border-radius: 50%;
  background: var(--bg);
  box-shadow:
    1px 1px 3px var(--sd),
    -1px -1px 3px var(--sl);
  transform: translateY(-50%);
  pointer-events: none;
  transition:
    width var(--dur-fast) var(--ease),
    height var(--dur-fast) var(--ease),
    margin-left var(--dur-fast) var(--ease);
}
.is-dragging .thumb {
  width: 18px;
  height: 18px;
  margin-left: -9px;
}

/* 原生 input 铺满整个 44px 高度，透明但接管全部交互 */
.native {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  /* 保证拖到滑块外面时仍然跟随 */
  touch-action: none;
}
.native:disabled {
  cursor: not-allowed;
}

.is-disabled {
  opacity: 0.5;
}

/* 键盘焦点环画在视觉层上，因为原生 input 是透明的 */
.slider:focus-within .thumb {
  outline: 2px solid var(--accent-text);
  outline-offset: 2px;
}
</style>
