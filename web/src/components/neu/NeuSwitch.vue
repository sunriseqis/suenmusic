<script setup lang="ts">
/**
 * 开关。
 *
 * 开 = 凹陷 + 强调色填充的轨道；关 = 凸起。用形态区分而不是纯颜色，
 * 因为软拟物里"颜色突变"会显得很突兀。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    label?: string;
    disabled?: boolean;
    ariaLabel?: string;
  }>(),
  { disabled: false }
);

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

function toggle() {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    class="switch neu-focusable"
    :class="[modelValue ? 'on' : 'off', disabled ? 'neu-disabled' : '']"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="ariaLabel || label"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="knob" />
    <span v-if="label" class="neu-sr">{{ label }}</span>
  </button>
</template>

<style scoped>
.switch {
  position: relative;
  width: 50px;
  height: 30px;
  border-radius: var(--r-pill);
  padding: 0;
  flex: none;
  transition:
    box-shadow var(--dur-mid) var(--ease),
    background-color var(--dur-mid) var(--ease);
}

.off {
  background: var(--bg);
  box-shadow:
    inset 2px 2px 5px var(--sd),
    inset -2px -2px 5px var(--sl);
}

.on {
  /* 开态：填充强调色。白/深色文字不涉及，滑块是独立的圆形 */
  background: var(--accent);
  box-shadow:
    inset 1px 1px 3px rgba(0, 0, 0, 0.25),
    inset -1px -1px 3px rgba(255, 255, 255, 0.18);
}

.knob {
  position: absolute;
  top: 4px;
  left: 4px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--bg);
  box-shadow:
    1px 1px 3px var(--sd),
    -1px -1px 3px var(--sl);
  transition: transform var(--dur-mid) var(--ease);
}
.on .knob {
  transform: translateX(20px);
}
</style>
