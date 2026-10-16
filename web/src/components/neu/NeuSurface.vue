<script setup lang="ts">
/**
 * 通用软拟物容器。
 *
 * 存在的意义是把「凸起 / 凹陷 / 按下」这套形态收在一处 ——
 * 页面里到处手写 box-shadow 的话，深度不一致会立刻显脏。
 */
type Variant = 'raised' | 'raised-md' | 'raised-lg' | 'inset' | 'inset-deep' | 'flat';

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    /** 圆角档位。`pill` 用于胶囊形 */
    radius?: 'sm' | 'md' | 'lg' | 'xl' | 'pill' | 'none';
    /** 内边距档位；`none` 表示由调用方完全控制 */
    padding?: 'none' | '1' | '2' | '3' | '4' | '5' | '6';
    /** 可点击时自动获得按下反馈 */
    interactive?: boolean;
    /** 选中态（凹陷）。用于列表当前项等 */
    selected?: boolean;
    as?: string;
  }>(),
  {
    variant: 'raised',
    radius: 'lg',
    padding: '4',
    interactive: false,
    selected: false,
    as: 'div',
  }
);

const variantClass = () => {
  switch (props.variant) {
    case 'raised':
      return 'neu-raised';
    case 'raised-md':
      return 'neu-raised-md';
    case 'raised-lg':
      return 'neu-raised-lg';
    case 'inset':
      return 'neu-inset';
    case 'inset-deep':
      return 'neu-inset-deep';
    case 'flat':
      return '';
  }
};
</script>

<template>
  <component
    :is="as"
    :class="[
      variantClass(),
      selected && variant !== 'inset' && variant !== 'inset-deep' ? 'neu-selected' : '',
      interactive ? 'neu-clickable neu-focusable' : '',
      `r-${radius}`,
      `p-${padding}`,
    ]"
  >
    <slot />
  </component>
</template>

<style scoped>
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
.r-none {
  border-radius: 0;
}

.p-none {
  padding: 0;
}
.p-1 {
  padding: var(--sp-1);
}
.p-2 {
  padding: var(--sp-2);
}
.p-3 {
  padding: var(--sp-3);
}
.p-4 {
  padding: var(--sp-4);
}
.p-5 {
  padding: var(--sp-5);
}
.p-6 {
  padding: var(--sp-6);
}
</style>
