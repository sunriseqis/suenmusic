<script setup lang="ts">
/**
 * 登录 / 注册。
 *
 * 一个页面两种模式，而不是两个页面 —— 两者的字段几乎完全重合，
 * 拆开只会让"没有账号？去注册"这条路径多一次整页跳转。
 *
 * 「是否显示注册入口」由公开端点 `/api/auth/config` 决定。
 * 注意服务端的语义：**首个账号永远可注册**，所以不能只看
 * `allowRegistration`，要用 `registrationOpen`。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandLockup from '@/components/brand/BrandLockup.vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import ServerListEditor from '@/components/ServerListEditor.vue';
import { getBaseUrl } from '@/api/client.ts';
import { isNativeAudio } from '@/native/bridge.ts';
import { useSessionStore } from '@/stores/session.ts';

const router = useRouter();
const route = useRoute();
const session = useSessionStore();

type Mode = 'login' | 'register';
const mode = ref<Mode>('login');

/**
 * 服务器地址（安卓端的核心引导）。
 *
 * 桌面浏览器同源部署时不需要管它；手机 App 是**全新安装 + 不知道服务器在哪**，
 * 所以必须先填地址并当场验证——否则登录失败时报的是一句含糊的"网络错误"，
 * 用户根本分不清是地址错了还是服务器没开机。
 *
 * 已配置过时折叠显示（带"更改"入口），并在后台悄悄探测一次：
 * 上次能连、这次连不上（换网络/IPv6 挂了）会自动展开并说明。
 */
const serverOpen = ref(isNativeAudio && !getBaseUrl());

/**
 * 只有**安卓壳**才强制要求服务器地址。
 *
 * ⚠️ 之前写成 `!baseUrl` 是个回归：浏览器端同源部署（前端与 API 同域，
 * baseUrl 为空）会被判成"缺地址" —— 登录按钮永久禁用、还多出一个不该出现的
 * 地址输入框，表现为"桌面端登录 UI 不对、登录后跳不过去"（实测报障）。
 */
// 不做强制引导：登录按钮只受表单本身约束（服务器地址在设置里改）


const username = ref('');
const password = ref('');
const password2 = ref('');
const displayName = ref('');
const error = ref('');

const loading = computed(() => session.busy);

const title = computed(() => (mode.value === 'login' ? '欢迎回来' : '创建账号'));
const submitLabel = computed(() => (mode.value === 'login' ? '登录' : '注册并进入'));

/** 注册时口令最短长度由服务端下发，客户端不再硬编码 */
const minLen = computed(() => session.passwordMinLength);

const passwordError = computed(() => {
  if (mode.value !== 'register' || !password.value) return '';
  if (password.value.length < minLen.value) return `口令至少 ${minLen.value} 位`;
  return '';
});

const password2Error = computed(() => {
  if (mode.value !== 'register' || !password2.value) return '';
  if (password.value !== password2.value) return '两次输入的口令不一致';
  return '';
});

const canSubmit = computed(() => {
  if (!username.value.trim() || !password.value) return false;
  if (mode.value === 'register') {
    if (password.value.length < minLen.value) return false;
    if (password.value !== password2.value) return false;
  }
  return true;
});

onMounted(() => {
  // 配置可能还没取到（首帧并发），这里补一次，保证注册入口能正确显隐
  if (!session.authConfig) void session.loadAuthConfig();
});

function switchMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login';
  error.value = '';
  password.value = '';
  password2.value = '';
}

async function submit() {
  if (!canSubmit.value || loading.value) return;
  error.value = '';

  try {
    if (mode.value === 'login') {
      await session.login(username.value, password.value);
    } else {
      await session.register(username.value, password.value, displayName.value);
    }

    // 登录前想去哪就回哪，没有就回首页
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.replace(redirect);
  } catch (e) {
    error.value = session.describeError(e);
    password.value = '';
    password2.value = '';
  }
}
</script>

<template>
  <div class="wrap">
    <div class="card neu-raised-lg">
      <div class="brand">
        <BrandLockup size="lg" flat />
      </div>

      <h1 class="title">{{ title }}</h1>
      <p class="sub">
        {{
          mode === 'login'
            ? '登录后即可搜索并播放'
            : session.authConfig && !session.authConfig.hasUsers
              ? '这是第一个账号，将自动成为管理员'
              : '注册后即可使用'
        }}
      </p>

      <form class="form" @submit.prevent="submit">
        <NeuInput
          v-model="username"
          label="用户名"
          placeholder="登录用的账号名"
          icon="user"
          autocomplete="username"
          :disabled="loading"
        />

        <NeuInput
          v-if="mode === 'register'"
          v-model="displayName"
          label="显示名（可选）"
          placeholder="界面上展示的名字"
          autocomplete="nickname"
          :disabled="loading"
        />

        <NeuInput
          v-model="password"
          label="口令"
          type="password"
          placeholder="请输入口令"
          autocomplete="current-password"
          :disabled="loading"
          :error="passwordError"
          :hint="mode === 'register' ? `至少 ${minLen} 位` : ''"
          @enter="submit"
        />

        <NeuInput
          v-if="mode === 'register'"
          v-model="password2"
          label="确认口令"
          type="password"
          placeholder="再输入一次"
          autocomplete="new-password"
          :disabled="loading"
          :error="password2Error"
          @enter="submit"
        />

        <p v-if="error" class="err" role="alert">{{ error }}</p>

        <NeuButton
          type="submit"
          variant="primary"
          size="lg"
          block
          :disabled="!canSubmit"
          :loading="loading"
        >
          {{ submitLabel }}
        </NeuButton>
      </form>

      <!-- 服务端设置：不强制引导，需要时手动展开 -->
      <div v-if="serverOpen" class="server-panel" data-role="server-box">
        <ServerListEditor />
      </div>

      <!-- 只有服务端允许时才显示注册入口。
           左侧的"还没有账号？"文案去掉，位置让给「服务端设置」入口（用户要求） -->
      <div class="switch">
        <button
          type="button"
          class="linkneu"
          data-role="server-toggle"
          @click="serverOpen = !serverOpen"
        >
          <NeuIcon name="settings" :size="15" />
          {{ serverOpen ? '收起服务端设置' : '服务端设置' }}
        </button>
        <button v-if="session.canRegister" type="button" class="linkneu" @click="switchMode">
          <NeuIcon :name="mode === 'login' ? 'plus' : 'chevron-left'" :size="15" />
          {{ mode === 'login' ? '注册' : '返回登录' }}
        </button>
      </div>

      <!-- 配置获取失败 ≠ 关闭注册：别把"连不上"误报成"已关闭"（用户实测踩过） -->
      <p v-if="session.authConfigFailed" class="closed">
        服务配置获取失败：请检查服务端地址与网络后刷新重试。
      </p>
      <p
        v-else-if="!session.canRegister && session.authConfig && mode === 'login'"
        class="closed"
      >
        本服务已关闭注册。需要新账号请联系管理员创建。
      </p>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  width: 100%;
  display: flex;
  justify-content: center;
}

.server-panel {
  margin-top: var(--sp-4);
  text-align: left;
}

.card {
  width: 100%;
  max-width: 420px;
  padding: var(--sp-6) var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  border-radius: var(--r-xl);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  justify-content: center;
}


.title {
  font-size: var(--fs-xl);
  text-align: center;
  color: var(--t1);
  margin-top: var(--sp-2);
}
.sub {
  font-size: var(--fs-sm);
  color: var(--t2);
  text-align: center;
  /* 与标题的间距收紧，让它们读起来是一组 */
  margin-top: calc(var(--sp-2) * -1);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  margin-top: var(--sp-2);
}

.err {
  font-size: var(--fs-sm);
  color: #b3261e;
  text-align: center;
  /* 错误条也用凹陷，和输入框一个语义层次 */
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}
:root[data-theme='dark'] .err {
  color: #ff9a92;
}

.switch {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
}

.linkneu {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent-text);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
}
.linkneu:hover {
  text-decoration: underline;
}

.closed {
  font-size: var(--fs-xs);
  color: var(--t2);
  text-align: center;
}
</style>
