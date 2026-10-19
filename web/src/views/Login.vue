<script setup lang="ts">
/**
 * 登录 / 首次创建管理员。
 *
 * Web 与后端同源，没有服务端地址可填；首次打开且库里没有用户时，
 * 这里直接变成「创建管理员」，创建完自动登录。
 */
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import { ApiError } from '@/api/client.ts';
import { useSessionStore } from '@/stores/session.ts';

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const displayName = ref('');
const errorText = ref('');
const registerMode = ref(false);

const setupMode = computed(() => session.authConfig?.setupRequired === true);
const canRegister = computed(() => session.canRegister);
const showRegister = computed(() => setupMode.value || registerMode.value);

const title = computed(() => (setupMode.value ? '创建管理员' : showRegister.value ? '注册' : '登录'));

function done(): void {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
  void router.replace(redirect);
}

async function submit(): Promise<void> {
  errorText.value = '';
  const u = username.value.trim();
  if (!u) {
    errorText.value = '请填写用户名';
    return;
  }
  if (password.value.length < session.passwordMinLength) {
    errorText.value = `口令至少 ${session.passwordMinLength} 位`;
    return;
  }
  try {
    if (showRegister.value) {
      await session.register(u, password.value, displayName.value.trim() || undefined);
    } else {
      await session.login(u, password.value);
    }
    done();
  } catch (e) {
    errorText.value = e instanceof ApiError ? e.message : e instanceof Error ? e.message : '操作失败';
  }
}
</script>

<template>
  <div class="login-page neu-bg">
    <div class="card">
      <h1 class="title">{{ title }}</h1>
      <p v-if="setupMode" class="sub neu-t2">库里还没有账号，第一个账号会成为管理员。</p>

      <div class="field">
        <span class="k">用户名</span>
        <NeuInput v-model="username" autocomplete="username" @enter="submit" />
      </div>
      <div v-if="showRegister" class="field">
        <span class="k">显示名</span>
        <NeuInput v-model="displayName" autocomplete="nickname" />
      </div>
      <div class="field">
        <span class="k">口令</span>
        <NeuInput v-model="password" type="password" autocomplete="current-password" @enter="submit" />
      </div>

      <NeuButton variant="primary" block :loading="session.busy" @click="submit">
        {{ setupMode ? '创建并进入' : showRegister ? '注册并进入' : '登录' }}
      </NeuButton>

      <p v-if="errorText" class="err">{{ errorText }}</p>

      <button
        v-if="!setupMode && canRegister"
        type="button"
        class="switch"
        @click="registerMode = !registerMode"
      >
        {{ registerMode ? '已有账号，去登录' : '没有账号？注册' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
}
.card {
  width: min(100%, 380px);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-6);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--panel);
  box-shadow: inset 0 1px 0 var(--hi);
}
.title {
  margin: 0;
  font-size: 24px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.02em;
}
.sub {
  margin: 0;
  font-size: var(--fs-xs);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.k {
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--t2);
}
.err {
  margin: 0;
  font-size: var(--fs-xs);
  color: #d4564a;
}
.switch {
  align-self: center;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--accent-text);
  font-size: var(--fs-xs);
  cursor: pointer;
}
</style>
