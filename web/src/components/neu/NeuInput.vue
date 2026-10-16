<script setup lang="ts">
/**
 * 输入框。
 *
 * 软拟物输入框用**深凹陷**（`neu-inset-deep`）—— 它是"被按进页面里"的形态，
 * 与凸起的按钮形成明确的空间关系：可点的浮起来，可写的凹下去。
 */
import { computed, ref, useId } from 'vue';
import NeuIcon from './NeuIcon.vue';
import type { IconName } from './NeuIcon.vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label?: string;
    placeholder?: string;
    type?: 'text' | 'password' | 'search';
    icon?: IconName;
    autocomplete?: string;
    disabled?: boolean;
    /** 错误文案。出现时边框不再是重点，label 变红并把消息显示在下方 */
    error?: string;
    hint?: string;
    /** 是否显示明文切换（仅 password 有效） */
    revealable?: boolean;
  }>(),
  {
    type: 'text',
    disabled: false,
    error: '',
    hint: '',
    revealable: true,
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'enter'): void;
}>();

const uid = useId();
const revealed = ref(false);

const actualType = computed(() => {
  if (props.type === 'password') return revealed.value ? 'text' : 'password';
  return props.type === 'search' ? 'search' : 'text';
});

function onInput(ev: Event) {
  emit('update:modelValue', (ev.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="field">
    <label v-if="label" class="lbl" :for="uid" :class="error ? 'lbl-err' : ''">
      {{ label }}
    </label>

    <div class="wrap neu-inset-deep" :class="[disabled ? 'is-disabled' : '', error ? 'is-err' : '']">
      <NeuIcon v-if="icon" :name="icon" :size="17" class="lead" />

      <input
        :id="uid"
        :type="actualType"
        :value="modelValue"
        :placeholder="placeholder"
        :autocomplete="autocomplete"
        :disabled="disabled"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="error || hint ? `${uid}-msg` : undefined"
        class="inp"
        @input="onInput"
        @keydown.enter.prevent="emit('enter')"
      />

      <button
        v-if="type === 'password' && revealable"
        type="button"
        class="reveal neu-focusable"
        :aria-label="revealed ? '隐藏密码' : '显示密码'"
        :title="revealed ? '隐藏密码' : '显示密码'"
        @click="revealed = !revealed"
      >
        <NeuIcon :name="revealed ? 'eye-off' : 'eye'" :size="17" />
      </button>
    </div>

    <p v-if="error || hint" :id="`${uid}-msg`" class="msg" :class="error ? 'msg-err' : ''">
      {{ error || hint }}
    </p>
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}

.lbl {
  font-size: var(--fs-sm);
  color: var(--t2);
  font-weight: var(--fw-medium);
}
.lbl-err {
  color: #b3261e;
}
:root[data-theme='dark'] .lbl-err {
  color: #ff9a92;
}

.wrap {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 0 var(--sp-4);
  min-height: 44px; /* 移动端触摸目标下限 */
  border-radius: var(--r-md);
  transition: box-shadow var(--dur-fast) var(--ease);
}
.wrap:focus-within {
  /* 聚焦时用强调色描一圈阴影，而不是加 border ——
     加 border 会改变盒模型尺寸并让整个框抖一下 */
  box-shadow:
    inset 2px 2px 5px var(--sd),
    inset -2px -2px 5px var(--sl),
    0 0 0 2px var(--accent-text);
}
.is-disabled {
  opacity: 0.55;
}

.lead {
  color: var(--t2);
}

.inp {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--t1);
  font-size: var(--fs-md);
}
/* 搜索框的浏览器原生清除按钮与软拟物风格冲突，隐藏掉 */
.inp::-webkit-search-cancel-button {
  display: none;
}
.inp::placeholder {
  color: var(--t2);
  opacity: 0.72;
}

.reveal {
  flex: none;
  display: inline-flex;
  color: var(--t2);
  padding: var(--sp-1);
  border-radius: var(--r-sm);
}
.reveal:hover {
  color: var(--t1);
}

.msg {
  font-size: var(--fs-xs);
  color: var(--t2);
  margin-top: -2px;
}
.msg-err {
  color: #b3261e;
}
:root[data-theme='dark'] .msg-err {
  color: #ff9a92;
}
</style>
