<script setup lang="ts">
/**
 * 酷狗验证 /verify/kugou?t=…
 *
 * 这个页面**不是**给 App 内部跳的普通页面：链接由移动端通知带过来，
 * 会在**手机系统浏览器**里直接打开 —— 所以它：
 *   · 不依赖登录态（路由 meta.public，接口只认 URL 上的 t）；
 *   · 单列窄屏布局、按钮 48px 起，拇指够得着；
 *   · 任何异常都有文字说明，绝不白屏。
 *
 * 三条分支（服务端的 supported=true 只有这三种）：
 *   · TX（图形）：加载 turing.captcha.qcloud.com/TCaptcha.js → new TencentCaptcha(txAppId)
 *     → 通过后把票据拼成 KGCodeTX|{ticket,randstr,txappid} 提交。格式与酷狗登录链路
 *     一致，字段名/顺序都不要动（少一个酷狗就回 20028）。
 *   · SMS（短信）：上游带了脱敏手机号就只展示，没带就让用户自己填；发送验证码走
 *     send-sms + 60s 倒计时，验证码走 submit。
 *   · LOGIN（登录确认）：上游在等用户在酷狗客户端点确认，本页**不伪造提交**，只给一个
 *     「我已完成，重新检查」→ refresh，needed=false 即通过。
 * 其余 provider 一律只显示服务端 message（「账号存在风险，请前往酷狗客户端处理」），
 * 不给操作按钮 —— 那些渠道在网页里做不到。
 *
 * 提交字段名统一为 `code`（契约 v2）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import { ApiError } from '@/api/client.ts';
import {
  buildTencentVerifyCode,
  fetchVerifyStateByToken,
  refreshVerifyStateByToken,
  saveVerifyToken,
  sendVerifySms,
  submitVerifyCode,
  type KugouVerifyState,
} from '@/api/kugou-verify.ts';

const CAPTCHA_SRC = 'https://turing.captcha.qcloud.com/TCaptcha.js';

type TencentCaptchaResult = {
  ret: number;
  ticket?: string;
  randstr?: string;
};

type TencentCaptchaInstance = {
  show: () => void;
  hide?: () => void;
  destroy?: () => void;
};

type TencentCaptchaConstructor = new (
  appId: string,
  callback: (result: TencentCaptchaResult) => void,
  options?: Record<string, unknown>,
) => TencentCaptchaInstance;

type Phase = 'loading' | 'ready' | 'sms' | 'login' | 'unsupported' | 'done' | 'error';

const route = useRoute();

const token = ref(readTokenFromQuery());
const state = ref<KugouVerifyState | null>(null);
const phase = ref<Phase>('loading');
const errorText = ref('');
const doneText = ref('');
const busy = ref(false);
/** 短信验证：发送验证码的独立 loading（提交用 busy，两个按钮各自转圈） */
const smsSending = ref(false);
const smsMobile = ref('');
const smsMobileError = ref('');
const smsCode = ref('');
const smsCodeError = ref('');
const smsNotice = ref('');
/** 发送成功后的 60 秒冷却；>0 时「发送验证码」不可点 */
const smsCountdown = ref(0);
/** 登录确认分支：点「重新检查」后仍 needed 时的提示 */
const loginNotice = ref('');

let captcha: TencentCaptchaInstance | null = null;
let countdownTimer: number | null = null;
/** 自动补刷只做一次：用户手动点「重新检查」不该被这条自动逻辑拦住 */
let autoRefreshed = false;
let captchaScript: Promise<TencentCaptchaConstructor> | null = null;

const provider = computed(() => state.value?.provider ?? 'UNKNOWN');
const providerName = computed(() => state.value?.providerName || provider.value);
/** 上游带的脱敏手机号（有则只展示、不再让用户填） */
const smsHint = computed(() => (state.value?.smsMobileHint || '').trim());

/**
 * 不支持 / 风险分支只说服务端的话。
 * 服务端契约保证这类 provider 的 message 就是「账号存在风险，请前往酷狗客户端处理」，
 * 这里只在 message 意外为空时兜一句同样的意思。
 */
const unsupportedText = computed(
  () => (state.value?.message || '').trim() || '账号存在风险，请前往酷狗客户端处理。',
);

const title = computed(() => {
  if (phase.value === 'loading') return '正在获取验证信息';
  if (phase.value === 'done') return '验证通过';
  if (phase.value === 'unsupported') return '需要另外的验证方式';
  if (phase.value === 'error') return '无法继续验证';
  if (phase.value === 'sms') return '短信安全验证';
  if (phase.value === 'login') return '登录确认';
  return '酷狗安全验证';
});

function readTokenFromQuery(): string {
  const raw = route.query.t;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value || '').trim();
}

/** expiresAt 可能是 ISO / 秒 / 毫秒，统一换算成毫秒 */
function timeOf(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const text = String(value).trim();
  const numeric = Number(text);
  if (text !== '' && Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExpired(next: KugouVerifyState): boolean {
  const expiresAt = timeOf(next.expiresAt);
  return expiresAt > 0 && expiresAt <= Date.now();
}

function applyState(next: KugouVerifyState): void {
  state.value = next;
  if (next.needed !== true) {
    // needed=false：要么已经解除，要么服务端没有待处理事件
    stopCountdown();
    phase.value = 'done';
    doneText.value = next.message || '当前无需验证，可以关闭本页。';
    return;
  }
  /*
   * 分支只认 provider，且必须 supported=true —— 服务端说「这条能做」才给操作；
   * 其余（GT/KG/KG2/SM/YD/BIND_PHONE/REAL_NAME/ACCOUNT_RISK/UNKNOWN）只有一句
   * 服务端 message，不给按钮：那些渠道在网页里做不到，给按钮只会让人白点。
   */
  if (next.supported === true) {
    if (next.provider === 'TX') {
      phase.value = 'ready';
      return;
    }
    if (next.provider === 'SMS') {
      phase.value = 'sms';
      return;
    }
    if (next.provider === 'LOGIN') {
      phase.value = 'login';
      return;
    }
  }
  phase.value = 'unsupported';
}

function handleLoadError(err: unknown): void {
  phase.value = 'error';
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      errorText.value = err.message || '验证链接无效或已过期，请回到 App 重新发起验证。';
      return;
    }
    errorText.value = err.message || '验证服务暂时不可用，请稍后重试。';
    return;
  }
  errorText.value =
    err instanceof Error && err.message ? err.message : '网络异常，请检查网络后重试。';
}

async function load(): Promise<void> {
  errorText.value = '';
  phase.value = 'loading';

  if (!token.value) {
    phase.value = 'error';
    errorText.value = '验证链接缺少参数 t，请回到 App 重新发起验证。';
    return;
  }

  saveVerifyToken(token.value);

  try {
    let next = await fetchVerifyStateByToken(token.value);
    /**
     * state 是纯读接口（不碰上游），刚登记事件时 info 还空着 → provider=UNKNOWN。
     * 这时必须主动 refresh 一次拿到真实渠道，否则好好的 TX 会被显示成
     * 「当前需要未知验证，暂不支持自动处理」。
     * 过期同理：先换一个新事件，别让用户点下去才发现白搭。
     */
    const unknownProvider = next.needed === true && next.provider === 'UNKNOWN';
    if (next.needed === true && (unknownProvider || isExpired(next)) && !autoRefreshed) {
      autoRefreshed = true;
      next = await refreshVerifyStateByToken(token.value);
    }
    applyState(next);
  } catch (err) {
    handleLoadError(err);
  }
}

async function renew(): Promise<void> {
  if (!token.value) {
    await load();
    return;
  }
  errorText.value = '';
  phase.value = 'loading';
  busy.value = true;
  try {
    applyState(await refreshVerifyStateByToken(token.value));
  } catch (err) {
    handleLoadError(err);
  } finally {
    busy.value = false;
  }
}

/** 60 秒重发冷却。计时器必须在卸载时清掉，否则页面关了还在跑 */
function startCountdown(): void {
  stopCountdown();
  smsCountdown.value = 60;
  countdownTimer = window.setInterval(() => {
    smsCountdown.value -= 1;
    if (smsCountdown.value <= 0) stopCountdown();
  }, 1000);
}

function stopCountdown(): void {
  if (countdownTimer !== null) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (smsCountdown.value < 0) smsCountdown.value = 0;
}

/** 服务端 message 优先 —— 限频、号码不可用这类原因只有服务端知道 */
function smsErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return err.message || '验证链接无效或已过期，请回到 App 重新发起验证。';
    }
    return err.message || '操作失败，请稍后重试。';
  }
  return err instanceof Error && err.message ? err.message : '网络异常，请检查网络后重试。';
}

async function sendSms(): Promise<void> {
  errorText.value = '';
  smsNotice.value = '';
  if (smsCountdown.value > 0) return;

  const mobile = smsMobile.value.trim();
  if (!smsHint.value) {
    if (!mobile) {
      smsMobileError.value = '请先填写手机号';
      return;
    }
    if (!/^1\d{10}$/.test(mobile)) {
      smsMobileError.value = '手机号格式不正确，请填 11 位手机号';
      return;
    }
  }
  smsMobileError.value = '';

  smsSending.value = true;
  try {
    /*
     * 上游给了脱敏号码时，真实号码只有上游知道，body.mobile 只能给空串，
     * 由服务端回落到事件上的手机号（字段名仍是契约里的 mobile，不可改成可选）。
     */
    const res = await sendVerifySms(token.value, smsHint.value ? '' : mobile);
    if (!res.ok) {
      errorText.value = res.message || '验证码发送失败，请稍后重试。';
      return;
    }
    smsNotice.value = res.message || '验证码已发送，请注意查收。';
    startCountdown();
  } catch (err) {
    errorText.value = smsErrorText(err);
  } finally {
    smsSending.value = false;
  }
}

async function submitSmsCode(): Promise<void> {
  errorText.value = '';
  const code = smsCode.value.trim();
  if (!code) {
    smsCodeError.value = '请输入短信验证码';
    return;
  }
  smsCodeError.value = '';

  busy.value = true;
  try {
    const res = await submitVerifyCode(token.value, code);
    if (res.state) state.value = res.state;
    if (res.ok) {
      stopCountdown();
      phase.value = 'done';
      doneText.value = '验证通过，已解除酷狗风控限制，可以关闭本页。';
      return;
    }
    errorText.value = res.message || '验证未通过，请重新输入。';
  } catch (err) {
    errorText.value = smsErrorText(err);
  } finally {
    busy.value = false;
  }
}

/** LOGIN：本页不伪造提交，只问服务端事件还在不在 */
async function recheckLogin(): Promise<void> {
  errorText.value = '';
  loginNotice.value = '';
  if (!token.value) {
    await load();
    return;
  }
  busy.value = true;
  try {
    const next = await refreshVerifyStateByToken(token.value);
    applyState(next);
    if (next.needed === true) {
      loginNotice.value = '服务端仍认为本次验证未完成，请先在酷狗客户端点确认，再来点一次。';
    }
  } catch (err) {
    handleLoadError(err);
  } finally {
    busy.value = false;
  }
}

function loadTencentCaptcha(): Promise<TencentCaptchaConstructor> {
  const existing = (window as any).TencentCaptcha as TencentCaptchaConstructor | undefined;
  if (existing) return Promise.resolve(existing);
  if (captchaScript) return captchaScript;

  captchaScript = new Promise<TencentCaptchaConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CAPTCHA_SRC;
    script.async = true;
    const timer = window.setTimeout(() => {
      script.remove();
      reject(new Error('腾讯验证码加载超时，请检查网络后重试'));
    }, 15_000);
    script.onload = () => {
      window.clearTimeout(timer);
      const ctor = (window as any).TencentCaptcha as TencentCaptchaConstructor | undefined;
      if (ctor) resolve(ctor);
      else reject(new Error('腾讯验证码加载失败，请稍后重试'));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('腾讯验证码加载失败，请检查网络后重试'));
    };
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    captchaScript = null;
    throw err;
  });

  return captchaScript;
}

function destroyCaptcha(): void {
  const current = captcha;
  captcha = null;
  if (!current) return;
  try {
    current.hide?.();
  } catch {
    /* 不同版本 SDK 方法不一致，清理失败不影响页面 */
  }
  try {
    current.destroy?.();
  } catch {
    /* 同上 */
  }
}

async function startCaptcha(): Promise<void> {
  const appId = (state.value?.txAppId || '').trim();
  errorText.value = '';
  if (!appId) {
    errorText.value = '缺少腾讯验证码配置，请回到 App 重新发起验证。';
    return;
  }

  destroyCaptcha();
  busy.value = true;
  try {
    const TencentCaptcha = await loadTencentCaptcha();
    captcha = new TencentCaptcha(
      appId,
      (result) => {
        void onCaptchaResult(result);
      },
      { type: '', showHeader: false },
    );
    captcha.show();
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : '腾讯验证码加载失败，请稍后重试';
  } finally {
    busy.value = false;
  }
}

async function onCaptchaResult(result: TencentCaptchaResult): Promise<void> {
  if (result.ret !== 0) {
    destroyCaptcha();
    errorText.value = '未完成验证，可以重新点击「开始验证」。';
    return;
  }

  const verifyCode = buildTencentVerifyCode({
    ticket: result.ticket,
    randstr: result.randstr,
    txAppId: (state.value?.txAppId || '').trim(),
  });

  busy.value = true;
  try {
    const res = await submitVerifyCode(token.value, verifyCode);
    if (res.state) state.value = res.state;
    if (res.ok) {
      phase.value = 'done';
      doneText.value = '验证通过，已解除酷狗风控限制，可以关闭本页。';
      return;
    }
    phase.value = 'ready';
    errorText.value = res.message || '验证未通过，请重新验证。';
  } catch (err) {
    if (err instanceof ApiError) {
      errorText.value = err.message || '提交失败，请重新验证。';
      if (err.status === 401 || err.status === 403) {
        phase.value = 'error';
        errorText.value = err.message || '验证链接无效或已过期，请回到 App 重新发起验证。';
      }
      return;
    }
    errorText.value = err instanceof Error && err.message ? err.message : '提交失败，请重新验证。';
  } finally {
    busy.value = false;
    destroyCaptcha();
  }
}

/** 用户开始改输入就收起上一次的校验错误，别让红字跟着他走 */
watch(smsMobile, () => {
  smsMobileError.value = '';
});
watch(smsCode, () => {
  smsCodeError.value = '';
});

function closePage(): void {
  // 系统浏览器里 window.close 只对脚本打开的窗口生效，失败也不能让用户困惑：
  // 文案本来就写着「可以关闭本页」，按钮只是顺手帮一下。
  try {
    window.close();
  } catch {
    /* 忽略：改用手动关闭 */
  }
}

onMounted(() => {
  document.title = '酷狗验证';
  void load();
});

onBeforeUnmount(() => {
  destroyCaptcha();
  stopCountdown();
});
</script>

<template>
  <div class="verify-page">
    <div class="card">
      <div class="head">
        <h1 class="title">{{ title }}</h1>
        <span v-if="phase !== 'loading' && phase !== 'done'" class="badge">{{ providerName }}</span>
      </div>

      <p v-if="phase === 'loading'" class="desc">正在获取验证信息…</p>

      <template v-else-if="phase === 'ready'">
        <p class="desc">
          酷狗取流被风控拦截，需要在这里完成一次安全验证。验证通过后即可回到 App 继续播放。
        </p>
        <p v-if="state?.message" class="desc">{{ state.message }}</p>
        <p v-if="errorText" class="err">{{ errorText }}</p>
        <NeuButton variant="primary" size="lg" block :loading="busy" @click="startCaptcha">
          开始验证
        </NeuButton>
        <button type="button" class="link-btn" @click="renew">重新获取验证</button>
      </template>

      <template v-else-if="phase === 'sms'">
        <p class="desc">
          酷狗要求完成一次短信安全验证。验证通过后即可回到 App 继续播放。
        </p>

        <p v-if="smsHint" class="desc">验证码将发送至 {{ smsHint }}</p>
        <NeuInput
          v-else
          v-model="smsMobile"
          label="手机号"
          placeholder="请输入手机号"
          autocomplete="tel"
          :error="smsMobileError"
          @enter="sendSms"
        />

        <NeuInput
          v-model="smsCode"
          label="验证码"
          placeholder="请输入短信验证码"
          autocomplete="one-time-code"
          :error="smsCodeError"
          @enter="submitSmsCode"
        />

        <p v-if="state?.message" class="desc">{{ state.message }}</p>
        <p v-if="smsNotice" class="hint-left">{{ smsNotice }}</p>
        <p v-if="errorText" class="err">{{ errorText }}</p>

        <NeuButton
          size="lg"
          block
          :loading="smsSending"
          :disabled="smsCountdown > 0"
          @click="sendSms"
        >
          {{ smsCountdown > 0 ? `${smsCountdown} 秒后可重新发送` : '发送验证码' }}
        </NeuButton>

        <NeuButton variant="primary" size="lg" block :loading="busy" @click="submitSmsCode">
          提交
        </NeuButton>
      </template>

      <template v-else-if="phase === 'login'">
        <p class="desc">
          酷狗正在等你确认这次登录。请打开酷狗客户端完成确认，然后回来点下面的按钮。
        </p>
        <p v-if="state?.message" class="desc">{{ state.message }}</p>
        <p v-if="loginNotice" class="desc">{{ loginNotice }}</p>
        <p v-if="errorText" class="err">{{ errorText }}</p>
        <NeuButton variant="primary" size="lg" block :loading="busy" @click="recheckLogin">
          我已完成，重新检查
        </NeuButton>
      </template>

      <!-- 其余渠道（GT/KG/KG2/SM/YD/BIND_PHONE/REAL_NAME/ACCOUNT_RISK/UNKNOWN）：
           只有服务端那句话，不给操作按钮 —— 按钮点了也做不成事 -->
      <template v-else-if="phase === 'unsupported'">
        <p class="desc">{{ unsupportedText }}</p>
        <p class="hint">处理完成后返回 App 重试即可。</p>
      </template>

      <template v-else-if="phase === 'done'">
        <p class="desc">{{ doneText }}</p>
        <NeuButton variant="primary" size="lg" block @click="closePage">关闭本页</NeuButton>
        <p class="hint">若浏览器没有关掉这一页，直接返回 App 即可。</p>
      </template>

      <template v-else>
        <p class="err">{{ errorText }}</p>
        <NeuButton variant="primary" size="lg" block @click="load">重试</NeuButton>
        <button v-if="token" type="button" class="link-btn" @click="renew">
          重新获取验证
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.verify-page {
  width: min(100%, 420px);
  margin: 0 auto;
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-6) var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--panel);
  box-shadow: inset 0 1px 0 var(--hi);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}

.title {
  margin: 0;
  font-size: 20px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.01em;
}

.badge {
  flex: none;
  padding: 2px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--t2);
}

.desc {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--t2);
  overflow-wrap: anywhere;
}

.err {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: #d4564a;
  overflow-wrap: anywhere;
}

.hint {
  margin: 0;
  font-size: 12px;
  text-align: center;
  color: var(--t2);
}

/* 左对齐的辅助行（「验证码已发送」这类补充说明，跟居中提示不是一类） */
.hint-left {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--accent-text);
  overflow-wrap: anywhere;
}

.link-btn {
  align-self: center;
  min-height: 44px;
  padding: 0 var(--sp-3);
  border: 0;
  background: transparent;
  color: var(--accent-text);
  font-family: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
}

/* 窄屏（手机系统浏览器）：去掉卡片外框，把整屏都给内容 */
@media (max-width: 480px) {
  .card {
    gap: var(--sp-3);
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
  }
  .title {
    font-size: 18px;
  }
}
</style>
