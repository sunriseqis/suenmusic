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
  /* 触摸目标最小 36px；移动端另有 44px 的硬要求，由 s-lg 承担 */
  min-height: 36px;
}

.block {
  width: 100%;
}

.s-sm {
  min-height: 30px;
  padding: 0 var(--sp-3);
  font-size: var(--fs-sm);
  border-radius: var(--r-md);
}
.s-md {
  min-height: 40px;
  padding: 0 var(--sp-4);
  font-size: var(--fs-md);
  border-radius: var(--r-md);
}
.s-lg {
  min-height: 48px;
  padding: 0 var(--sp-5);
  font-size: var(--fs-lg);
  border-radius: var(--r-lg);
}

/* ---- 变体 ---- */

/* 默认：与页面同底色，只靠阴影浮起 */
.v-default {
  color: var(--t1);
}

/* 主按钮：强调色填充。文字用白色 —— 铁律 2 说 --accent 当文字只有 3.74:1，
   但当背景时白字对比度是够的 */
.v-primary {
  color: #fff;
  background: var(--accent);
  box-shadow:
    2px 2px 5px var(--sd),
    -2px -2px 5px var(--sl);
}
:root[data-theme='dark'] .v-primary {
  /* 深色下 --accent 更亮，白字对比度下降，改用深色文字 */
  color: #2b1a0e;
}
.v-primary:active:not(:disabled) {
  /* 填充类按钮的按下态不能用 inset 阴影（会被背景色盖住看不出），
     改为压缩外阴影 + 缩放 */
  box-shadow: 1px 1px 2px var(--sd);
  transform: scale(0.98);
}

/* 幽灵按钮：无凸起，仅强调色文字。用于"次要但重要"的动作 */
.v-ghost {
  color: var(--accent-text);
  background: transparent;
  box-shadow: none;
}
.v-ghost:hover:not(:disabled) {
  color: var(--accent-text);
  text-decoration: underline;
}
.v-ghost:active:not(:disabled) {
  box-shadow: none;
}

/* 危险动作：删除。软拟物里没有红色令牌，这里直接用语义红，
   但只用于文字与按下态的轻阴影，不引入第五种颜色面 */
.v-danger {
  color: #b3261e;
}
:root[data-theme='dark'] .v-danger {
  color: #ff9a92;
}
.v-danger:active:not(:disabled) {
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}

/* 加载指示：一个旋转的缺口圆环，不用 emoji */
.spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: spin 0.7s linear infinite;
  flex: none;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
