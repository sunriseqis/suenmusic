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
  border: 1px solid var(--line);
  background: var(--bg);
  box-shadow: inset 0 2px 6px var(--lo);
  transition:
    background-color var(--dur-mid) var(--ease),
    border-color var(--dur-mid) var(--ease);
}

.on {
  background: color-mix(in srgb, var(--accent) 20%, var(--panel));
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
}

.knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--panel);
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--hi);
  transition:
    transform var(--dur-mid) var(--ease),
    background-color var(--dur-mid) var(--ease);
}
.on .knob {
  transform: translateX(20px);
  background: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 70%, #000);
}
</style>
