<script setup lang="ts">
/**
 * 设置。
 *
 * 五块内容：基地址、外观、本站账号（改口令 / 会话管理 / 退出）、
 * B 站音源账号（扫码登录）、服务状态。
 *
 * 基地址必须可改（PLAN.md 5.4）：线上是 `https://<域名>:<非标端口>`，
 * 局域网访问又是另一个地址，硬编码会让每种部署方式都得改代码重构建。
 *
 * B 站那块容易误读：登录的是**服务端访问 B 站用的身份**，不是本站账号 ——
 * 见视图里那两处说明文案，别把它们删掉。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { useRouter } from 'vue-router';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import NeuTabs from '@/components/neu/NeuTabs.vue';
import type { TabItem } from '@/components/neu/NeuTabs.vue';
import NeuSkeleton from '@/components/neu/NeuSkeleton.vue';
import NeuSwitch from '@/components/neu/NeuSwitch.vue';
import ServerListEditor from '@/components/ServerListEditor.vue';
import OfflineCachePanel from '@/components/OfflineCachePanel.vue';
import {
  isNativeAudio,
  isBluetoothLyricsEnabled,
  setBluetoothLyricsEnabled,
  isHarmonyLyricsEnabled,
  setHarmonyLyricsEnabled,
  SuenAudio,
} from '@/native/audio.ts';
import { useLyricsStore } from '@/stores/lyrics.ts';
import { useUpdateStore } from '@/stores/update.ts';
import { isAndroid, isIOS, isHarmony, isNativeUpdate } from '@/native/update.ts';
import * as authApi from '@/api/auth.ts';
import * as biliApi from '@/api/bilibili.ts';
import * as neApi from '@/api/netease.ts';
import * as aiApi from '@/api/ai.ts';
import { ApiError } from '@/api/client.ts';
import {
  exportSmBackup,
  importQQPlaylist,
  importSmBackup,
  previewSmBackup,
  previewFavoritesDedup,
  executeFavoritesDedup,
  type FavoritesDedupPreviewResult,
  type SmPreviewResult,
} from '@/api/library.ts';
import { downloadBlob } from '@/utils/download.ts';
import type { PersonaDetail } from '@/api/types.ts';
import type { DislikeItem } from '@/api/recommend.ts';

import { usePlayerStore } from '@/stores/player.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { useSessionStore } from '@/stores/session.ts';
import { useDislikesStore } from '@/stores/dislikes.ts';
import { useUiStore } from '@/stores/ui.ts';
import { formatDateTime, formatRelative } from '@/utils/format.ts';
import type { SessionInfo } from '@/api/types.ts';

const router = useRouter();
const session = useSessionStore();
const dislikes = useDislikesStore();
const ui = useUiStore();
const player = usePlayerStore();
const favorites = useFavoritesStore();
const lyrics = useLyricsStore();
const update = useUpdateStore();
const bluetoothLyricsEnabled = ref(isBluetoothLyricsEnabled());

async function toggleBluetoothLyrics(enabled: boolean): Promise<void> {
  bluetoothLyricsEnabled.value = enabled;
  setBluetoothLyricsEnabled(enabled);
  lyrics.setEnabled(enabled);
  if (enabled) {
    if (isNativeAudio) await SuenAudio.requestNotificationPermission().catch(() => {});
    ui.ok('车机蓝牙歌词已开启');
  } else {
    ui.ok('车机蓝牙歌词已关闭');
  }
}

/** 鸿蒙的「系统歌词」开关。默认开，逻辑与蓝牙那条一致：关掉时由 store 收回已推送的歌词 */
const harmonyLyricsEnabled = ref(isHarmonyLyricsEnabled());

function toggleHarmonyLyrics(enabled: boolean): void {
  harmonyLyricsEnabled.value = enabled;
  setHarmonyLyricsEnabled(enabled);
  lyrics.setEnabled(enabled);
  ui.ok(enabled ? '系统歌词已开启' : '系统歌词已关闭');
}

// 更新检查/下载安装全部在 stores/update.ts 里 —— 启动时的静默检查（App.vue）
// 与这里的按钮共用同一份状态，所以卡片和弹窗不会各说各话。

// ---- 顶层分类模式：个人设置 / 系统运维 ----
/**
 * 顶层分类按「这是本机的事，还是服务端的事」切，不按功能切。
 *
 * 没有服务端时**整块隐藏服务端 tab** —— 直连模式下那些设置全部无意义，
 * 摆在那里只会让人以为"我是不是没配好"。
 */
const MAIN_TABS = computed<TabItem[]>(() => {
  const tabs: TabItem[] = [{ value: 'personal', label: '本机' }];
  if (ui.baseUrl.trim()) tabs.push({ value: 'system', label: '服务端' });
  return tabs;
});
const activeMainTab = ref<'personal' | 'system'>('personal');

/** 服务端地址被清空时把人踢回「本机」，否则会停在一个已经消失的 tab 上 */
watch(
  () => ui.baseUrl,
  v => {
    if (!v.trim() && activeMainTab.value === 'system') activeMainTab.value = 'personal';
  }
);

// ---- 主题 ----
const THEME_TABS: TabItem[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];
const themeValue = computed({
  get: () => ui.themeMode,
  set: (v: string) => ui.setTheme(v as 'system' | 'light' | 'dark'),
});

// ---- 改口令 ----
const oldPassword = ref('');
const newPassword = ref('');
const newPassword2 = ref('');
const pwError = ref('');
const pwBusy = ref(false);

const newPwError = computed(() => {
  if (!newPassword.value) return '';
  if (newPassword.value.length < session.passwordMinLength) {
    return `口令至少 ${session.passwordMinLength} 位`;
  }
  return '';
});
const newPw2Error = computed(() => {
  if (!newPassword2.value) return '';
  if (newPassword.value !== newPassword2.value) return '两次输入的口令不一致';
  return '';
});
const canChangePw = computed(
  () =>
    oldPassword.value.length > 0 &&
    newPassword.value.length >= session.passwordMinLength &&
    newPassword.value === newPassword2.value
);

async function submitPassword() {
  if (!canChangePw.value || pwBusy.value) return;
  pwBusy.value = true;
  pwError.value = '';
  try {
    await session.changePassword(oldPassword.value, newPassword.value);
    oldPassword.value = '';
    newPassword.value = '';
    newPassword2.value = '';
    ui.ok('口令已修改，其他设备已全部下线');
    void loadSessions();
  } catch (e) {
    pwError.value = session.describeError(e);
  } finally {
    pwBusy.value = false;
  }
}

// ---- 会话 ----
const sessions = ref<SessionInfo[]>([]);
const sessionsLoading = ref(false);

/** 优先将本机/当前活跃设备排在首位 */
const sortedSessions = computed(() => {
  return [...sessions.value].sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    return b.lastUsedAt - a.lastUsedAt;
  });
});

async function loadSessions() {
  sessionsLoading.value = true;
  try {
    const res = await authApi.fetchSessions();
    sessions.value = res.sessions;
  } catch {
    // 拿不到会话列表不该打断设置页 —— 静默即可
    sessions.value = [];
  } finally {
    sessionsLoading.value = false;
  }
}

async function revoke(id: string) {
  try {
    await authApi.revokeSession(id);
    ui.ok('该设备已下线');
    void loadSessions();
  } catch (e) {
    ui.err(session.describeError(e));
  }
}

/**
 * 退出当前设备。
 *
 * 清空本地会话（`session.logout()` 内部保证网络失败也照样清），
 * 然后交给路由守卫跳登录页。播放队列属于上一个账号，必须一起清掉。
 */
async function doLogout() {
  await session.logout();
  player.reset();
  favorites.reset();
  ui.ok('已退出登录');
  await router.replace({ name: 'login' });
}

async function doLogoutAll() {
  try {
    await session.logoutAll();
    player.reset();
    favorites.reset();
    await router.replace({ name: 'login' });
  } catch (e) {
    ui.err(session.describeError(e));
  }
}

// ---- 服务状态 ----
const cfg = computed(() => session.authConfig);

// ---- 歌单管理（导出 .sm 备份、导入 QQ 歌单 / .sm 备份、歌单去重） ----
const exportingSm = ref(false);
const importQqLink = ref('');
const importingQq = ref(false);
const smFileInput = ref<HTMLInputElement | null>(null);
const importingSm = ref(false);

// 去重状态
const dedupChecking = ref(false);
const dedupExecuting = ref(false);
const showDedupModal = ref(false);
const dedupPreviewData = ref<FavoritesDedupPreviewResult | null>(null);

// .sm 导入预检状态
const showSmModal = ref(false);
const smPendingData = ref('');
const smPreviewData = ref<SmPreviewResult | null>(null);
const smImportPersona = ref(true);

async function handleExportSm() {
  if (exportingSm.value) return;
  exportingSm.value = true;
  try {
    const blob = await exportSmBackup();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `suenmusic_backup_${session.user?.username || 'user'}_${dateStr}.sm`;
    const ok = await downloadBlob(blob, filename);
    if (ok) {
      ui.ok('已成功导出备份文件 (.sm)');
    } else {
      ui.err('导出文件下载失败，请稍后重试');
    }
  } catch (e) {
    ui.err(session.describeError(e));
  } finally {
    exportingSm.value = false;
  }
}

async function handleImportQq() {
  const link = importQqLink.value.trim();
  if (!link || importingQq.value) return;
  importingQq.value = true;
  try {
    const res = await importQQPlaylist(link);
    ui.ok(
      `「${res.playlistName}」导入完成：新增 ${res.added} 首` +
        (res.skipped > 0 ? `，已收藏跳过 ${res.skipped} 首` : '')
    );
    importQqLink.value = '';
    favorites.reset();
    await favorites.ensureLoaded().catch(() => {});
  } catch (e) {
    ui.err(session.describeError(e));
  } finally {
    importingQq.value = false;
  }
}

async function handleSmFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || importingSm.value) return;

  const reader = new FileReader();
  reader.onload = async () => {
    const result = String(reader.result ?? '');
    const b64 = result.slice(result.indexOf(',') + 1);
    importingSm.value = true;
    try {
      const preview = await previewSmBackup(b64);
      smPendingData.value = b64;
      smPreviewData.value = preview;
      smImportPersona.value = preview.hasPersona;
      showSmModal.value = true;
    } catch (err) {
      ui.err(session.describeError(err));
    } finally {
      importingSm.value = false;
      input.value = '';
    }
  };
  reader.onerror = () => {
    ui.err('读取备份文件失败');
    input.value = '';
  };
  reader.readAsDataURL(file);
}

async function handleConfirmSmImport() {
  if (!smPendingData.value || importingSm.value) return;
  importingSm.value = true;
  try {
    const res = await importSmBackup(smPendingData.value, smImportPersona.value);
    showSmModal.value = false;
    let msg = `恢复完成：新增收藏 ${res.added} 首` + (res.skipped > 0 ? `，已收藏跳过 ${res.skipped} 首` : '');
    if (res.personaImported) msg += '，已恢复口味画像';
    ui.ok(msg);
    favorites.reset();
    await favorites.ensureLoaded().catch(() => {});
    void loadPersona();
  } catch (err) {
    ui.err(session.describeError(err));
  } finally {
    importingSm.value = false;
  }
}

async function handleCheckDedup() {
  if (dedupChecking.value) return;
  dedupChecking.value = true;
  try {
    const res = await previewFavoritesDedup();
    if (res.duplicateCount === 0) {
      ui.ok('太棒了，当前收藏中没有重复歌曲');
    } else {
      dedupPreviewData.value = res;
      showDedupModal.value = true;
    }
  } catch (e) {
    ui.err(session.describeError(e));
  } finally {
    dedupChecking.value = false;
  }
}

async function handleExecuteDedup() {
  if (dedupExecuting.value) return;
  dedupExecuting.value = true;
  try {
    const res = await executeFavoritesDedup();
    showDedupModal.value = false;
    ui.ok(`去重完成，已清理 ${res.removedCount} 首重复歌曲`);
    favorites.reset();
    await favorites.ensureLoaded().catch(() => {});
  } catch (e) {
    ui.err(session.describeError(e));
  } finally {
    dedupExecuting.value = false;
  }
}

// ---------------------------------------------------------------------------
// 音源授权（B 站 + 网易云，一张卡片两个 tab）
// ---------------------------------------------------------------------------
//
// 这块**不是**本站账号 —— 音源由服务端代理取流，整台服务只有一个出网身份，
// 凭证全站共用：登录一次所有客户端都受益，退出也是全员退出。
//
// 两个音源的登录流程完全同构（扫码 → 轮询 → 落库），所以抽成同一个状态工厂，
// 界面上也是同一张卡片：按钮切换音源，下方渲染当前音源的状态。避免两张
// 又大又笨重的卡片各复制一份逻辑。
//
// 扫码结果只能轮询（上游没有推送）。轮询定时器必须跟着组件销毁一起停，
// 否则用户离开设置页后还在后台打上游接口。

interface AuthApi {
  fetchStatus(signal?: AbortSignal): Promise<any>;
  startQr(): Promise<{ qrcodeKey: string; qrImage: string | null; url: string }>;
  pollQr(key: string, signal?: AbortSignal): Promise<{ state: string; message: string }>;
  logout(): Promise<{ revertedToEnv: boolean }>;
}

interface AuthDisplay {
  /** 已登录时显示的名字；未登录为空 */
  name: string;
  face: string;
  /** 会员徽标文案（「大会员」「黑胶 VIP」）；无会员为空 */
  vip: string;
  /** 身份元信息（UID xxx / ID xxx） */
  meta: string;
  canLogout: boolean;
}

/**
 * 对外形状：**解包后**的类型（工厂返回 reactive 包装，refs 已自动解包）。
 * 工厂内部的闭包变量仍是 Ref —— 两套形状靠 reactive 的类型解包对上。
 */
interface AuthSource {
  /** 按钮上的文案（用户指定大写英文） */
  tab: string;
  scanHint: string;
  openLabel: string;
  api: AuthApi;
  status: any | null;
  loading: boolean;
  busy: boolean;
  qr: { key: string; image: string | null; url: string } | null;
  qrState: string | null;
  qrMessage: string;
  faceBroken: boolean;
  display: AuthDisplay;
  sourceLabel: string;
  tone: string;
  load(): Promise<void>;
  startLogin(): Promise<void>;
  tick(): Promise<void>;
  stopPolling(): void;
  resetQr(): void;
  doLogout(): Promise<void>;
}

const POLL_MS = 2500;

function sourceLabelOf(status: Ref<any | null>): ComputedRef<string> {
  return computed(() => {
    const src = status.value?.source;
    if (src === 'database') return '界面扫码登录';
    if (src === 'env') return '服务端环境变量配置';
    return '';
  });
}

function toneOf(qrState: Ref<string | null>): ComputedRef<string> {
  return computed(() => {
    switch (qrState.value) {
      case 'scanned':
        return '已扫码，请在手机上确认';
      case 'expired':
        return '二维码已失效';
      case 'failed':
        return '登录失败';
      case 'confirmed':
        return '登录成功';
      default:
        return '等待扫码';
    }
  });
}

function createAuthSource(opts: {
  tab: string;
  scanHint: string;
  openLabel: string;
  api: AuthApi;
  /** 从 status 里拼账号展示行 */
  displayOf: (status: any) => AuthDisplay;
}): AuthSource {
  const status = ref<any | null>(null);
  const loading = ref(true);
  const busy = ref(false);
  const qr = ref<{ key: string; image: string | null; url: string } | null>(null);
  const qrState = ref<string | null>(null);
  const qrMessage = ref('');
  const faceBroken = ref(false);
  let timer: number | null = null;

  const source = {
    tab: opts.tab,
    scanHint: opts.scanHint,
    openLabel: opts.openLabel,
    api: opts.api,
    status,
    loading,
    busy,
    qr,
    qrState,
    qrMessage,
    faceBroken,
    timer,
    display: computed<AuthDisplay>(() => opts.displayOf(status.value)),
    sourceLabel: sourceLabelOf(status),
    tone: toneOf(qrState),

    async load() {
      loading.value = true;
      try {
        status.value = await opts.api.fetchStatus();
        faceBroken.value = false;
      } catch {
        // 拿不到状态不该打断整个设置页 —— 其余设置项仍然可用
        status.value = null;
      } finally {
        loading.value = false;
      }
    },

    stopPolling() {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    },

    resetQr() {
      source.stopPolling();
      qr.value = null;
      qrState.value = null;
      qrMessage.value = '';
    },

    async startLogin() {
      if (busy.value) return;
      busy.value = true;
      source.resetQr();
      try {
        const res = await opts.api.startQr();
        qr.value = { key: res.qrcodeKey, image: res.qrImage, url: res.url };
        qrState.value = 'pending';
        qrMessage.value = opts.scanHint;
        source.stopPolling();
        timer = window.setInterval(() => void source.tick(), POLL_MS);
      } catch (e) {
        ui.err(session.describeError(e));
      } finally {
        busy.value = false;
      }
    },

    async tick() {
      const key = qr.value?.key;
      if (!key) {
        source.stopPolling();
        return;
      }
      try {
        const res = await opts.api.pollQr(key);
        qrState.value = res.state;
        qrMessage.value = res.message;

        if (res.state === 'confirmed') {
          source.resetQr();
          ui.ok(res.message);
          await source.load();
        } else if (res.state === 'expired' || res.state === 'failed') {
          // 终态就停轮询，别继续空转
          source.stopPolling();
        }
      } catch (e) {
        source.stopPolling();
        qrState.value = 'failed';
        qrMessage.value = session.describeError(e);
      }
    },

    async doLogout() {
      if (busy.value) return;
      busy.value = true;
      try {
        const res = await opts.api.logout();
        ui.ok(res.revertedToEnv ? '已退出，回落到环境变量里的凭证' : `已退出${opts.tab}授权`);
        source.resetQr();
        await source.load();
      } catch (e) {
        ui.err(session.describeError(e));
      } finally {
        busy.value = false;
      }
    },
  };

  // reactive 包装：模板直接读 cur.loading / cur.display（refs 自动解包，
  // 类型上 UnwrapNestedRefs 也同步解包，与 AuthSource 声明对上）。
  return reactive(source);
}

const authSources = {
  bilibili: createAuthSource({
    tab: 'BILIBILI',
    scanHint: '请用 B 站手机客户端扫码',
    openLabel: '在 B 站打开',
    api: {
      fetchStatus: biliApi.fetchBilibiliStatus,
      startQr: biliApi.startBilibiliQr,
      pollQr: biliApi.pollBilibiliQr,
      logout: biliApi.logoutBilibili,
    },
    displayOf: (s) =>
      s?.configured
        ? {
            name: s.account?.name || '已配置 B 站凭证',
            face: s.account?.face ?? '',
            vip: s.account?.vip ? '大会员' : '',
            meta: s.account ? `UID ${s.account.mid}` : '',
            canLogout: Boolean(s.canLogout),
          }
        : { name: '', face: '', vip: '', meta: '', canLogout: false },
  }),
  netease: createAuthSource({
    tab: 'NETEASE',
    scanHint: '请用网易云音乐 App 扫码',
    openLabel: '在网易云打开',
    api: {
      fetchStatus: neApi.fetchNeteaseStatus,
      startQr: neApi.startNeteaseQr,
      pollQr: neApi.pollNeteaseQr,
      logout: neApi.logoutNetease,
    },
    displayOf: (s) =>
      s?.configured
        ? {
            name: s.account?.name || '已配置网易云凭证',
            face: s.account?.face ?? '',
            vip: (s.account?.vipType ?? 0) >= 10 ? '黑胶 VIP' : '',
            meta: s.account ? `ID ${s.account.userId}` : '',
            canLogout: Boolean(s.canLogout),
          }
        : { name: '', face: '', vip: '', meta: '', canLogout: false },
  }),
};

/** 当前编辑的音源。两个 tab 共享一张卡片，切换只换渲染的数据源 */
const activeAuth = ref<'bilibili' | 'netease'>('bilibili');
const cur = computed(() => authSources[activeAuth.value]);

/**
 * 是否触屏设备。
 *
 * B 站扫码登录给的是 **H5 页面地址**，桌面浏览器打开它会被当成移动端缺失而
 * **跳去下载安卓客户端**（用户实测反馈）。所以「在 xx 打开」这个入口只给
 * 触屏设备 —— 桌面端扫二维码即可。
 *
 * 唯一例外：二维码没画出来时（登录地址超出编码能力），链接是**唯一**出路，
 * 此时不管是桌面还是手机都得给。
 */
const isTouchDevice = ref(false);

// ---- 网易云只保留扫码登录（2026-09-11 用户拍板）：
//      密码/验证码登录被网易云反作弊与账号风险判定反复拦截，已整体移除 ----

onMounted(() => {
  void loadSessions();
  void authSources.bilibili.load();
  void authSources.netease.load();
  isTouchDevice.value = window.matchMedia('(pointer: coarse)').matches;
  void loadDislikeList();
  void loadPersona();
  void loadAiModels();
});

// ---- 偏好管理（不喜欢过的歌曲/歌手，可撤销；tab 区分两类） ----
const dislikeItems = ref<DislikeItem[]>([]);
const dislikeLoading = ref(false);
const prefTab = ref<'track' | 'artist'>('track');

const trackDislikes = computed(() => dislikeItems.value.filter(d => d.type === 'track'));
const artistDislikes = computed(() => dislikeItems.value.filter(d => d.type === 'artist'));

async function loadDislikeList() {
  dislikeLoading.value = true;
  try {
    await dislikes.ensureLoaded();
    // 有服务端时对一次账（并集，不会抹掉本地）
    void dislikes.syncFromServer();
    dislikeItems.value = dislikes.items;
  } catch {
    dislikeItems.value = [];
  } finally {
    dislikeLoading.value = false;
  }
}

async function undoDislike(item: DislikeItem) {
  try {
    await dislikes.remove(item.type, item.targetId);
    dislikeItems.value = [...dislikes.items];
    ui.ok('已恢复推荐');
  } catch (e) {
    ui.err(session.describeError(e));
  }
}

// ---- 我的音乐画像（AI 维护 + 用户引导模式，A3 原则） ----
const persona = ref<PersonaDetail | null>(null);
const personaLoading = ref(false);
const personaTuning = ref(false);
const personaRefreshing = ref(false);
const personaGuidance = ref('');
const personaError = ref('');

function renderMarkdown(text: string): string {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const bolded = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  const lines = bolded.split('\n');
  const htmlParts: string[] = [];
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) {
        htmlParts.push('<ul class="persona-list">');
        inList = true;
      }
      htmlParts.push(`<li>${line.slice(2)}</li>`);
    } else if (line.startsWith('#')) {
      if (inList) {
        htmlParts.push('</ul>');
        inList = false;
      }
      const headingLevel = line.match(/^#+/)?.[0].length || 1;
      const headingText = line.replace(/^#+\s*/, '');
      htmlParts.push(`<h${Math.min(headingLevel + 2, 6)} class="persona-heading">${headingText}</h${Math.min(headingLevel + 2, 6)}>`);
    } else if (line === '') {
      if (inList) {
        htmlParts.push('</ul>');
        inList = false;
      }
    } else {
      if (inList) {
        htmlParts.push('</ul>');
        inList = false;
      }
      htmlParts.push(`<p class="persona-p">${line}</p>`);
    }
  }
  if (inList) {
    htmlParts.push('</ul>');
  }
  return htmlParts.join('');
}

async function loadPersona() {
  personaLoading.value = true;
  personaError.value = '';
  try {
    persona.value = await aiApi.fetchPersona();
  } catch (e) {
    personaError.value = session.describeError(e);
  } finally {
    personaLoading.value = false;
  }
}

async function submitTunePersona() {
  const g = personaGuidance.value.trim();
  if (!g || personaTuning.value || personaRefreshing.value) return;
  personaTuning.value = true;
  personaError.value = '';
  const currentUpdated = persona.value?.updatedAt ?? 0;
  try {
    const res = await aiApi.tunePersona(g);
    persona.value = res.persona;
    personaGuidance.value = '';
    ui.ok('音乐画像已根据你的指导调优');
  } catch (e) {
    // 容错补偿：若前端偶发网络断开或超时，模型可能已在后台生成成功入库，尝试拉取一次最新画像验证
    try {
      const latest = await aiApi.fetchPersona();
      if (latest?.summary && (latest.updatedAt ?? 0) > currentUpdated) {
        persona.value = latest;
        personaGuidance.value = '';
        ui.ok('音乐画像已在后台完成更新');
        return;
      }
    } catch {
      /* ignore fallback check error */
    }
    // 长任务的失败要说到实处：真正发生的是「连接在 AI 生成过程中断了」，
    // 不是「服务端地址配错了」——后者会把人引去乱改设置，与事实不符。
    personaError.value =
      e instanceof ApiError && e.isNetworkError
        ? '与服务器的连接中断了。AI 可能仍在后台生成，稍等片刻回来刷新画像即可。'
        : session.describeError(e);
    ui.err(personaError.value);
  } finally {
    personaTuning.value = false;
  }
}

async function handleRefreshPersona() {
  if (personaRefreshing.value || personaTuning.value) return;
  personaRefreshing.value = true;
  personaError.value = '';
  const currentUpdated = persona.value?.updatedAt ?? 0;
  try {
    const res = await aiApi.refreshPersona();
    persona.value = res.persona;
    ui.ok('已基于曲库全量重构音乐画像');
  } catch (e) {
    // 容错补偿：若前端偶发超时，尝试静默拉取一次最新画像验证
    try {
      const latest = await aiApi.fetchPersona();
      if (latest?.summary && (latest.updatedAt ?? 0) > currentUpdated) {
        persona.value = latest;
        ui.ok('音乐画像已在后台全量重构');
        return;
      }
    } catch {
      /* ignore fallback check error */
    }
    // 长任务的失败要说到实处：真正发生的是「连接在 AI 生成过程中断了」，
    // 不是「服务端地址配错了」——后者会把人引去乱改设置，与事实不符。
    personaError.value =
      e instanceof ApiError && e.isNetworkError
        ? '与服务器的连接中断了。AI 可能仍在后台生成，稍等片刻回来刷新画像即可。'
        : session.describeError(e);
    ui.err(personaError.value);
  } finally {
    personaRefreshing.value = false;
  }
}

// ---- AI 模型配置（OpenAI 兼容协议 + 多模型切换与角色分工） ----
interface EditableProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeyMasked?: string;
  hasApiKey?: boolean;
  model: string;
}

const aiConfig = ref<{
  profiles: EditableProfile[];
  decideProfileId: string;
  reviewProfileId: string;
}>({
  profiles: [],
  decideProfileId: '',
  reviewProfileId: '',
});

const activeModelSummary = computed(() => {
  if (aiConfig.value.profiles.length === 0) return '尚未配置模型（请在下方「模型接入」中配置）';
  const decide = aiConfig.value.profiles.find(p => p.id === aiConfig.value.decideProfileId);
  const review = aiConfig.value.profiles.find(p => p.id === aiConfig.value.reviewProfileId);
  if (!decide && !review) return '未指定生效模型';
  if (decide && review && decide.id === review.id) {
    return `生效模型：${decide.name || decide.model}`;
  }
  const decideName = decide ? (decide.name || decide.model) : '未指定';
  const reviewName = review ? (review.name || review.model) : '未指定';
  return `主理人：${decideName}\n审核员：${reviewName}`;
});

const aiLoading = ref(false);
const aiSaving = ref(false);
const aiError = ref('');
const modelTestStatus = ref<Record<string, { testing: boolean; result?: string; error?: string }>>({});

const editingProfile = ref<EditableProfile | null>(null);
const isCreatingProfile = ref(false);
const editProfileError = ref('');
const editProfileTesting = ref(false);
const editProfileTestSuccess = ref('');

async function loadAiModels() {
  aiLoading.value = true;
  aiError.value = '';
  try {
    const res = await aiApi.fetchAiModels();
    aiConfig.value = {
      profiles: res.profiles.map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: '',
        apiKeyMasked: p.apiKeyMasked,
        hasApiKey: p.hasApiKey,
        model: p.model,
      })),
      decideProfileId: res.decideProfileId,
      reviewProfileId: res.reviewProfileId,
    };
  } catch (e) {
    aiError.value = session.describeError(e);
  } finally {
    aiLoading.value = false;
  }
}

function startAddProfile() {
  editingProfile.value = {
    id: '',
    name: '',
    baseUrl: '',
    apiKey: '',
    model: '',
  };
  isCreatingProfile.value = true;
  editProfileError.value = '';
  editProfileTestSuccess.value = '';
}

function startEditProfile(p: EditableProfile) {
  editingProfile.value = {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: '',
    apiKeyMasked: p.apiKeyMasked,
    hasApiKey: p.hasApiKey,
    model: p.model,
  };
  isCreatingProfile.value = false;
  editProfileError.value = '';
  editProfileTestSuccess.value = '';
}

function cancelEditProfile() {
  editingProfile.value = null;
  editProfileError.value = '';
  editProfileTestSuccess.value = '';
}

async function testCurrentEditProfile() {
  if (!editingProfile.value) return;
  const ep = editingProfile.value;
  if (!ep.baseUrl.trim()) {
    editProfileError.value = '请填写 Base URL';
    return;
  }
  if (!ep.model.trim()) {
    editProfileError.value = '请填写模型标识符';
    return;
  }
  if (!ep.apiKey.trim() && !ep.hasApiKey) {
    editProfileError.value = '请填写 API Key';
    return;
  }

  editProfileTesting.value = true;
  editProfileError.value = '';
  editProfileTestSuccess.value = '';

  try {
    const res = await aiApi.testAiModel({
      id: ep.id || undefined,
      baseUrl: ep.baseUrl.trim(),
      apiKey: ep.apiKey.trim() || undefined,
      model: ep.model.trim(),
    });
    editProfileTestSuccess.value = `连接成功（延迟 ${res.latencyMs}ms）`;
  } catch (e) {
    editProfileError.value = session.describeError(e);
  } finally {
    editProfileTesting.value = false;
  }
}

function saveCurrentEditProfile() {
  if (!editingProfile.value) return;
  const ep = editingProfile.value;
  if (!ep.name.trim()) {
    editProfileError.value = '请填写模型备注名称';
    return;
  }
  if (!ep.baseUrl.trim()) {
    editProfileError.value = '请填写 Base URL';
    return;
  }
  if (!ep.model.trim()) {
    editProfileError.value = '请填写 Model 标识符';
    return;
  }
  if (!ep.apiKey.trim() && !ep.hasApiKey) {
    editProfileError.value = '请填写 API Key';
    return;
  }

  if (isCreatingProfile.value) {
    const newId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const trimmedKey = ep.apiKey.trim();
    aiConfig.value.profiles.push({
      id: newId,
      name: ep.name.trim(),
      baseUrl: ep.baseUrl.trim(),
      apiKey: trimmedKey,
      apiKeyMasked: trimmedKey.length > 8 ? `${trimmedKey.slice(0, 3)}***${trimmedKey.slice(-4)}` : '********',
      hasApiKey: true,
      model: ep.model.trim(),
    });
    if (!aiConfig.value.decideProfileId) {
      aiConfig.value.decideProfileId = newId;
    }
    if (!aiConfig.value.reviewProfileId) {
      aiConfig.value.reviewProfileId = newId;
    }
  } else {
    const idx = aiConfig.value.profiles.findIndex(p => p.id === ep.id);
    if (idx !== -1) {
      const existing = aiConfig.value.profiles[idx]!;
      const trimmedKey = ep.apiKey.trim();
      aiConfig.value.profiles[idx] = {
        ...existing,
        name: ep.name.trim(),
        baseUrl: ep.baseUrl.trim(),
        apiKey: trimmedKey || existing.apiKey,
        apiKeyMasked: trimmedKey
          ? (trimmedKey.length > 8 ? `${trimmedKey.slice(0, 3)}***${trimmedKey.slice(-4)}` : '********')
          : existing.apiKeyMasked,
        hasApiKey: existing.hasApiKey || Boolean(trimmedKey),
        model: ep.model.trim(),
      };
    }
  }

  editingProfile.value = null;
  ui.ok('模型已更新至列表，点击下方“保存配置”以验证连通性并生效');
}

function removeProfile(id: string) {
  aiConfig.value.profiles = aiConfig.value.profiles.filter(p => p.id !== id);
  if (aiConfig.value.decideProfileId === id) {
    aiConfig.value.decideProfileId = aiConfig.value.profiles[0]?.id ?? '';
  }
  if (aiConfig.value.reviewProfileId === id) {
    aiConfig.value.reviewProfileId = aiConfig.value.profiles[0]?.id ?? '';
  }
}

async function testProfileItem(p: EditableProfile) {
  modelTestStatus.value[p.id] = { testing: true };
  try {
    const res = await aiApi.testAiModel({
      id: p.id,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey || undefined,
      model: p.model,
    });
    modelTestStatus.value[p.id] = { testing: false, result: `成功 · ${res.latencyMs}ms` };
  } catch (e) {
    modelTestStatus.value[p.id] = { testing: false, error: session.describeError(e) };
  }
}

async function submitAiConfig() {
  if (aiSaving.value) return;
  aiSaving.value = true;
  aiError.value = '';
  try {
    const res = await aiApi.saveAiModels({
      profiles: aiConfig.value.profiles.map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey || undefined,
        model: p.model,
      })),
      decideProfileId: aiConfig.value.decideProfileId,
      reviewProfileId: aiConfig.value.reviewProfileId,
    });
    aiConfig.value = {
      profiles: res.config.profiles.map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: '',
        apiKeyMasked: p.apiKeyMasked,
        hasApiKey: p.hasApiKey,
        model: p.model,
      })),
      decideProfileId: res.config.decideProfileId,
      reviewProfileId: res.config.reviewProfileId,
    };
    ui.ok('AI 模型配置已保存，连通性验证通过');
  } catch (e) {
    aiError.value = session.describeError(e);
    ui.err(`保存失败：${aiError.value}`);
  } finally {
    aiSaving.value = false;
  }
}

onBeforeUnmount(() => {
  authSources.bilibili.stopPolling();
  authSources.netease.stopPolling();
});

/** 从 UA 里认出一个像样的设备名，认不出就原样截断显示 */
function deviceLabel(ua: string): string {
  if (!ua) return '未知设备';
  if (/android/i.test(ua)) return 'Android 设备';
  if (/iphone|ipad|ios/i.test(ua)) return 'iOS 设备';
  if (/windows/i.test(ua)) return 'Windows 电脑';
  if (/macintosh|mac os/i.test(ua)) return 'Mac';
  if (/linux/i.test(ua)) return 'Linux 设备';
  return ua.slice(0, 40);
}
</script>

<template>
  <div class="settings neu-container">
    <h1 class="h1-settings">设置</h1>

    <!-- 顶层主分类切换：个人设置 vs 系统运维 -->
    <div v-if="MAIN_TABS.length > 1" class="main-tabs-wrap">
      <NeuTabs v-model="activeMainTab" :items="MAIN_TABS" />
    </div>

    <!-- ==================== 【本机】分区 ==================== -->
    <template v-if="activeMainTab === 'personal'">
      <section class="card neu-raised-md" data-section="appearance">
        <div class="card-head">
          <h2 class="card-title">外观与播放</h2>
          <p class="card-desc neu-t2">主题、强调色、歌词同步与应用更新</p>
        </div>


        <!-- 外观微调组件（降级收拢） -->
        <div class="appearance-widget neu-raised-md">
          <div class="appearance-row">
            <span class="appearance-lbl neu-t2">主题模式</span>
            <NeuTabs v-model="themeValue" :items="THEME_TABS" />
          </div>

        </div>

        <!-- 设备与更新：两个紧凑入口。原先各占一张整卡片，只放一个控件，很突兀。
             容器整体也要跟着隐藏：它带 neu-inset（凹陷底），两行都被 v-if 藏掉后
             会在 PC 端剩一个空凹槽。 -->
        <div v-if="isNativeUpdate || isHarmony" class="quick-toggles neu-raised-md">
          <!-- 车机蓝牙歌词只对安卓开放：iOS 的 Now Playing 不支持实时改字段
               （AVRCP 转发机制不同），插件侧 setLyricTimeline/setLyricLine 是空操作，
               摆出开关只会让用户以为开了却不生效。 -->
          <div v-if="isAndroid" class="qt-row">
            <div class="qt-text">
              <span class="qt-title">车机蓝牙歌词</span>
              <span class="qt-hint neu-t2">锁屏与后台播放时，把当前歌词同步到车机</span>
            </div>
            <NeuSwitch
              :model-value="bluetoothLyricsEnabled"
              aria-label="车机蓝牙歌词"
              @update:model-value="toggleBluetoothLyrics"
            />
          </div>

          <!-- 鸿蒙的系统歌词：锁屏 / 播控中心显示当前歌词。
               默认开 —— 关掉会立刻把已经推出去的歌词收回来。 -->
          <div v-if="isHarmony" class="qt-row">
            <div class="qt-text">
              <span class="qt-title">系统歌词</span>
              <span class="qt-hint neu-t2">锁屏与播控中心显示当前歌词</span>
            </div>
            <NeuSwitch
              :model-value="harmonyLyricsEnabled"
              aria-label="系统歌词"
              @update:model-value="toggleHarmonyLyrics"
            />
          </div>

          <div v-if="isNativeUpdate" class="qt-row">
            <div class="qt-text">
              <span class="qt-title">应用更新</span>
              <span class="qt-hint neu-t2">
                {{ update.appVersion?.versionName ? `当前 v${update.appVersion.versionName}` : '读取中…' }}
                <template v-if="update.latest"> · 最新 v{{ update.latest.versionName }}</template>
                <template v-if="update.message"> · {{ update.message }}</template>
              </span>
              <!-- iOS 装不了自己：这里提前说清"更新要经过重签工具"，免得点下去
                   跳走之后用户不知道发生了什么 -->
              <span v-if="isIOS" class="qt-hint neu-t2">
                更新包由重签工具（AltStore / SideStore）安装；免费签名 7 天到期后需重新安装
              </span>
            </div>
            <div class="qt-actions">
              <NeuButton size="sm" :loading="update.checking" @click="update.check(false)">
                检查更新
              </NeuButton>
              <NeuButton
                v-if="update.available"
                size="sm"
                variant="primary"
                :loading="update.installing"
                @click="update.open()"
              >
                立即更新
              </NeuButton>
            </div>
          </div>
        </div>
      </section>

      <section v-if="isNativeAudio" class="card neu-raised-md" data-section="storage">
        <div class="card-head">
          <h2 class="card-title">离线存储与缓存</h2>
          <p class="card-desc neu-t2">管理设备本地音频缓存（最大 4GB）</p>
        </div>
        <OfflineCachePanel />
      </section>

      <section class="card neu-raised-md" data-section="dislikes">
        <div class="card-head">
          <h2 class="card-title">不喜欢</h2>
          <p class="card-desc neu-t2">被标记的歌曲与歌手不会出现在推荐里；存在本机，可随时恢复</p>
        </div>

            <!-- 折叠区：偏好管理（不喜欢的歌曲 / 歌手黑名单） -->
            <details class="disclosure">
              <summary class="sum">
                <NeuIcon name="chevron-right" :size="16" class="chev" />
                黑名单与偏好过滤
              </summary>

              <div class="auth-tabs" role="tablist" data-role="pref-tabs">
                <button
                  type="button"
                  role="tab"
                  class="auth-tab"
                  :class="{ active: prefTab === 'track' }"
                  :aria-selected="prefTab === 'track'"
                  data-auth-tab="track"
                  @click="prefTab = 'track'"
                >
                  不喜欢的歌曲（{{ trackDislikes.length }}）
                </button>
                <button
                  type="button"
                  role="tab"
                  class="auth-tab"
                  :class="{ active: prefTab === 'artist' }"
                  :aria-selected="prefTab === 'artist'"
                  data-auth-tab="artist"
                  @click="prefTab = 'artist'"
                >
                  不喜欢的歌手（{{ artistDislikes.length }}）
                </button>
              </div>

              <p v-if="dislikeLoading" class="note neu-t2">加载中…</p>

              <ul v-else-if="prefTab === 'track'" class="dislike-list">
                <li v-for="d in trackDislikes" :key="d.targetId" class="dislike-row">
                  <span class="d-name neu-ellipsis">{{ d.name || d.targetId }}</span>
                  <NeuButton variant="ghost" size="sm" @click="undoDislike(d)">恢复推荐</NeuButton>
                </li>
                <li v-if="trackDislikes.length === 0" class="note neu-t2">还没有不喜欢过的歌曲。</li>
              </ul>
              <ul v-else class="dislike-list">
                <li v-for="d in artistDislikes" :key="d.targetId" class="dislike-row">
                  <span class="d-name neu-ellipsis">{{ d.name || d.targetId }}</span>
                  <NeuButton variant="ghost" size="sm" @click="undoDislike(d)">恢复推荐</NeuButton>
                </li>
                <li v-if="artistDislikes.length === 0" class="note neu-t2">还没有不喜欢过的歌手。</li>
              </ul>
            </details>
      </section>

      <section class="card neu-raised-md" data-section="diagnostics">
        <div class="card-head">
          <h2 class="card-title">诊断</h2>
          <p class="card-desc neu-t2">检查搜索、解析、播放这三条直连链路是否正常</p>
        </div>

        <div class="actions">
          <NeuButton @click="router.push('/probe')">
            <NeuIcon name="info" :size="16" />
            打开直连诊断
          </NeuButton>
        </div>
      </section>
    </template>

    <!-- ==================== 【服务端】分区 ==================== -->
    <template v-else-if="activeMainTab === 'system'">
      <!-- 提示条 -->
      <div class="system-banner neu-inset">
        <NeuIcon name="info" :size="18" class="banner-icon" />
        <div class="banner-text">
          <span class="banner-title">服务端设置</span>
          <p class="banner-desc neu-t2">
            这些配置需要你自己的服务端。不配也能正常搜歌、播放、收藏 —— 只是没有多端同步、AI 与高音质凭据。
          </p>
        </div>
      </div>

      <section class="card neu-raised-md" data-section="server">
        <div class="card-head">
          <h2 class="card-title">服务端网络与选路</h2>
          <p class="card-desc neu-t2">
            管理内网与公网多节点地址，支持自动探测低延迟线路与智能容灾
          </p>
        </div>

        <ServerListEditor />
      </section>

      <section class="card neu-raised-md" data-section="security">
        <div class="card-head">
          <h2 class="card-title">账号与设备</h2>
          <p class="card-desc neu-t2">修改口令、查看并下线正在登录的设备</p>
        </div>

        <!-- 折叠项 1：修改口令 -->
        <details class="disclosure">
          <summary class="sum">
            <NeuIcon name="chevron-right" :size="16" class="chev" />
            修改口令
          </summary>

          <div class="form">
            <NeuInput
              v-model="oldPassword"
              label="当前口令"
              type="password"
              autocomplete="current-password"
              :disabled="pwBusy"
            />
            <NeuInput
              v-model="newPassword"
              label="新口令"
              type="password"
              autocomplete="new-password"
              :hint="`至少 ${session.passwordMinLength} 位`"
              :error="newPwError"
              :disabled="pwBusy"
            />
            <NeuInput
              v-model="newPassword2"
              label="确认新口令"
              type="password"
              autocomplete="new-password"
              :error="newPw2Error"
              :disabled="pwBusy"
              @enter="submitPassword"
            />

            <p v-if="pwError" class="err" role="alert">{{ pwError }}</p>

            <p class="note neu-t2">
              修改口令会<strong>下线全部设备</strong>（包括这一台），本机随后自动换上新凭据，不需要重新登录。
            </p>

            <NeuButton
              variant="primary"
              :disabled="!canChangePw"
              :loading="pwBusy"
              @click="submitPassword"
            >
              修改口令
            </NeuButton>
          </div>
        </details>

        <!-- 折叠项 2：登录中的设备 -->
        <details class="disclosure">
          <summary class="sum">
            <NeuIcon name="chevron-right" :size="16" class="chev" />
            登录中的设备（{{ sessions.length }}）
          </summary>

          <div v-if="sessionsLoading" class="sessions">
            <NeuSkeleton :lines="2" height="40px" />
          </div>
          <ul v-else-if="sessions.length > 0" class="sessions">
            <li
              v-for="s in sortedSessions"
              :key="s.id"
              class="srow"
              :class="{ 'srow-current': s.isCurrent }"
            >
              <div class="sinfo">
                <div class="sname-row">
                  <span class="sname">{{ deviceLabel(s.userAgent) }}</span>
                  <span v-if="s.isCurrent" class="current-tag neu-raised-xs">本机 / 当前设备</span>
                </div>
                <span class="smeta neu-t2">
                  {{ s.isCurrent ? '当前正处于活跃状态' : `最近使用 ${formatRelative(s.lastUsedAt)}` }} · 过期于
                  {{ formatDateTime(s.expiresAt) }}
                </span>
              </div>
              <button
                v-if="!s.isCurrent"
                type="button"
                class="kick"
                title="下线此设备"
                @click="revoke(s.id)"
              >
                下线
              </button>
              <button
                v-else
                type="button"
                class="kick kick-current"
                title="退出当前登录"
                @click="doLogout"
              >
                退出
              </button>
            </li>
          </ul>
          <p v-else class="note neu-t2">没有可显示的会话。</p>

          <div class="actions">
            <NeuButton variant="danger" @click="doLogoutAll">退出所有设备</NeuButton>
          </div>
        </details>
      </section>

      <section class="card neu-raised-md" data-section="auth">
        <div class="card-head">
          <h2 class="card-title">音源授权</h2>
          <p class="card-desc neu-t2">第三方音源平台凭证绑定与扫码授权</p>
        </div>

        <div class="auth-tabs" role="tablist" data-role="auth-tabs">
          <button
            v-for="(src, key) in authSources"
            :key="key"
            type="button"
            role="tab"
            class="auth-tab"
            :class="{ active: activeAuth === key }"
            :aria-selected="activeAuth === key"
            :data-auth-tab="key"
            @click="activeAuth = key"
          >
            {{ src.tab }}
            <span class="auth-dot" :class="{ on: src.status?.configured }" aria-hidden="true" />
          </button>
        </div>

        <div v-if="cur.loading" class="sessions">
          <NeuSkeleton :lines="2" height="36px" />
        </div>

        <template v-else>
          <!-- 已登录 -->
          <div v-if="cur.status?.configured" class="auth-account" data-role="auth-account">
            <span class="auth-face">
              <img
                v-if="cur.display.face && !cur.faceBroken"
                :src="cur.display.face"
                :alt="`${cur.display.name} 的头像`"
                referrerpolicy="no-referrer"
                loading="lazy"
                @error="cur.faceBroken = true"
              />
              <span v-else class="auth-face-fallback" aria-hidden="true">
                {{ cur.display.name.slice(0, 1) || cur.tab.slice(0, 1) }}
              </span>
            </span>
            <div class="auth-who">
              <span class="auth-name">
                {{ cur.display.name }}
                <span v-if="cur.display.vip" class="auth-vip">{{ cur.display.vip }}</span>
              </span>
              <span class="auth-meta neu-t2">
                <template v-if="cur.display.meta">{{ cur.display.meta }} · </template>
                来源：{{ cur.sourceLabel }}
              </span>
            </div>
            <NeuButton
              v-if="cur.display.canLogout"
              variant="danger"
              :loading="cur.busy"
              @click="cur.doLogout()"
            >
              退出
            </NeuButton>
          </div>

          <!-- 未登录 / 正在扫码 -->
          <template v-else>
            <p v-if="cur.status?.source === 'env'" class="note neu-t2">
              环境变量里配了 Cookie，但校验未通过 —— 这等同于没登录。请在这里扫码，或补全服务端配置。
            </p>

            <div v-if="cur.qr" class="auth-qr" data-role="auth-qr">
              <img v-if="cur.qr.image" class="auth-qr-img" :src="cur.qr.image" :alt="`${cur.tab} 登录二维码`" />
              <p v-else class="note neu-t2">
                登录地址超出本机二维码编码能力，没能画出来。请用下面的按钮打开页面扫码。
              </p>
              <p class="auth-qr-state" data-role="auth-qr-state" :data-state="cur.qrState ?? ''">
                {{ cur.tone }}<template v-if="cur.qrMessage"> · {{ cur.qrMessage }}</template>
              </p>
              <div class="auth-qr-actions">
                <a
                  v-if="isTouchDevice || !cur.qr.image"
                  class="auth-link"
                  :href="cur.qr.url"
                  target="_blank"
                  rel="noreferrer noopener"
                  data-role="auth-open-link"
                >
                  {{ cur.openLabel }}
                </a>
                <button type="button" class="kick" @click="cur.resetQr()">取消</button>
              </div>
            </div>

            <div v-else class="auth-cta">
              <NeuButton variant="primary" :loading="cur.busy" @click="cur.startLogin()">
                扫码登录 {{ cur.tab }}
              </NeuButton>
            </div>

            <p v-if="cur.status?.configured && !cur.display.canLogout" class="note neu-t2">
              当前凭证来自服务端环境变量，界面无法删除。扫码登录后以界面那份为准；点「退出」则回落到环境变量。
            </p>
          </template>

          <p v-if="!cur.loading && !cur.status" class="note neu-t2">
            没取到 {{ cur.tab }} 账号状态。若其余设置项正常，可能是该接口不可达。
          </p>
        </template>
      </section>

      <section class="card neu-raised-md" data-section="models">
        <div class="card-head">
          <h2 class="card-title">AI 模型配置与分工</h2>
          <p class="current-model-summary neu-t2">
            {{ activeModelSummary }}
          </p>
        </div>

        <div v-if="aiLoading" class="sessions">
          <NeuSkeleton :lines="3" height="36px" />
        </div>

        <div v-else class="models-mgmt">
          <!-- 已配置的模型列表 -->
          <div class="models-list">
            <div
              v-for="p in aiConfig.profiles"
              :key="p.id"
              class="model-item neu-inset-deep"
            >
              <div class="model-info">
                <div class="model-header-row">
                  <div class="model-title-group">
                    <span class="model-name">{{ p.name }}</span>
                    <span v-if="p.name !== p.model" class="model-slug neu-t2">{{ p.model }}</span>
                  </div>
                  <div class="role-badges">
                    <span
                      v-if="aiConfig.decideProfileId === p.id"
                      class="role-badge role-decide"
                      title="选歌 DJ 主理人"
                    >
                      主理人
                    </span>
                    <span
                      v-if="aiConfig.reviewProfileId === p.id"
                      class="role-badge role-review"
                      title="复核审核员"
                    >
                      审核员
                    </span>
                  </div>
                </div>

                <div class="model-meta-row neu-t2">
                  <span class="model-url neu-ellipsis" :title="p.baseUrl">{{ p.baseUrl }}</span>
                  <span class="meta-dot">·</span>
                  <span class="model-key-mask">{{ p.apiKeyMasked || (p.apiKey ? '已设新密钥' : '未设置') }}</span>
                </div>

                <!-- 连通性测试结果提示 -->
                <div v-if="modelTestStatus[p.id]" class="model-test-status">
                  <span
                    v-if="modelTestStatus[p.id]?.testing"
                    class="test-testing neu-t2"
                  >
                    测试连通性中…
                  </span>
                  <span
                    v-else-if="modelTestStatus[p.id]?.result"
                    class="test-ok"
                  >
                    {{ modelTestStatus[p.id]?.result }}
                  </span>
                  <span
                    v-else-if="modelTestStatus[p.id]?.error"
                    class="test-fail"
                  >
                    连通失败：{{ modelTestStatus[p.id]?.error }}
                  </span>
                </div>
              </div>

              <div class="model-actions">
                <button
                  type="button"
                  class="kick kick-sm"
                  :disabled="modelTestStatus[p.id]?.testing"
                  @click="testProfileItem(p)"
                >
                  测试
                </button>
                <button
                  type="button"
                  class="kick kick-sm"
                  @click="startEditProfile(p)"
                >
                  编辑
                </button>
                <button
                  type="button"
                  class="kick kick-sm kick-danger"
                  @click="removeProfile(p.id)"
                >
                  删除
                </button>
              </div>
            </div>

            <div v-if="aiConfig.profiles.length === 0" class="note neu-t2">
              尚未添加任何模型。
            </div>
          </div>

          <!-- 添加模型按钮 -->
          <div v-if="!editingProfile" class="add-model-wrap">
            <NeuButton variant="default" @click="startAddProfile">
              <NeuIcon name="plus" :size="16" />
              添加模型
            </NeuButton>
          </div>

          <!-- 新建 / 编辑模型内联表单 -->
          <div v-else class="model-edit-card neu-inset-sm">
            <h3 class="model-edit-title">
              {{ isCreatingProfile ? '添加模型' : '编辑模型：' + editingProfile.name }}
            </h3>

            <div class="form">
              <NeuInput
                v-model="editingProfile.name"
                label="模型备注名称"
              />
              <NeuInput
                v-model="editingProfile.baseUrl"
                label="Base URL"
              />
              <NeuInput
                v-model="editingProfile.apiKey"
                type="password"
                label="API Key"
                :placeholder="editingProfile.hasApiKey ? '留空表示保持原有密钥' : ''"
                :revealable="true"
              />
              <NeuInput
                v-model="editingProfile.model"
                label="Model 标识符"
              />

              <p v-if="editProfileError" class="err" role="alert">{{ editProfileError }}</p>
              <p v-if="editProfileTestSuccess" class="test-ok" role="status">{{ editProfileTestSuccess }}</p>

              <div class="edit-actions">
                <NeuButton
                  variant="ghost"
                  :loading="editProfileTesting"
                  @click="testCurrentEditProfile"
                >
                  测试单模型连通
                </NeuButton>
                <div class="edit-btn-group">
                  <NeuButton variant="ghost" @click="cancelEditProfile">取消</NeuButton>
                  <NeuButton variant="primary" @click="saveCurrentEditProfile">确认保存到列表</NeuButton>
                </div>
              </div>
            </div>
          </div>

          <div class="divider" />

          <!-- 角色分工选择 -->
          <div class="role-assignment">
            <h3 class="assignment-title">任务分工指派</h3>
            <p class="assignment-desc neu-t2">
              为系统中的各环节指定执行模型。支持选择相同或不同的模型。
            </p>

            <div class="assignment-grid">
              <div class="assignment-field">
                <label class="lbl">选歌 DJ 主理人模型</label>
                <div class="select-wrap neu-inset-deep">
                  <select
                    v-model="aiConfig.decideProfileId"
                    class="neu-select"
                    :disabled="aiConfig.profiles.length === 0"
                  >
                    <option v-if="aiConfig.profiles.length === 0" value="">请先添加模型</option>
                    <option
                      v-for="p in aiConfig.profiles"
                      :key="p.id"
                      :value="p.id"
                    >
                      {{ p.name }} ({{ p.model }})
                    </option>
                  </select>
                  <NeuIcon name="chevron-down" :size="16" class="select-arrow" />
                </div>
                <span class="field-hint neu-t2">负责结合画像遴选候选曲目，并构思走心推荐短评。</span>
              </div>

              <div class="assignment-field">
                <label class="lbl">复核审核员模型</label>
                <div class="select-wrap neu-inset-deep">
                  <select
                    v-model="aiConfig.reviewProfileId"
                    class="neu-select"
                    :disabled="aiConfig.profiles.length === 0"
                  >
                    <option v-if="aiConfig.profiles.length === 0" value="">请先添加模型</option>
                    <option
                      v-for="p in aiConfig.profiles"
                      :key="p.id"
                      :value="p.id"
                    >
                      {{ p.name }} ({{ p.model }})
                    </option>
                  </select>
                  <NeuIcon name="chevron-down" :size="16" class="select-arrow" />
                </div>
                <span class="field-hint neu-t2">负责二审复核，严查曲风匹配、排查禁忌并修正文案口吻。</span>
              </div>
            </div>
          </div>

          <p v-if="aiError" class="err" role="alert">{{ aiError }}</p>

          <div class="actions save-ai-row">
            <p class="note neu-t2">
              保存或切换模型时，系统将自动校验激活模型的连通性与可用性，校验通过后持久化生效。
            </p>
            <NeuButton
              variant="primary"
              :loading="aiSaving"
              :disabled="aiConfig.profiles.length === 0 || !aiConfig.decideProfileId"
              @click="submitAiConfig"
            >
              保存模型配置与分工
            </NeuButton>
          </div>
        </div>
      </section>

      <section class="card neu-raised-md" data-section="persona">
        <div class="card-head">
          <div class="card-head-row">
            <h2 class="card-title">音乐画像</h2>
            <NeuButton
              variant="ghost"
              size="sm"
              :loading="personaRefreshing"
              :disabled="personaTuning || personaLoading"
              title="基于当前曲库与行为全量重构画像"
              @click="handleRefreshPersona"
            >
              <NeuIcon name="refresh" :size="14" />
              {{ personaRefreshing ? '重构中...' : '全量重构' }}
            </NeuButton>
          </div>
          <p class="card-desc neu-t2">
            AI 专属听歌品味记忆 · 每日专属推荐决策核心
          </p>
        </div>

        <div v-if="personaLoading" class="sessions">
          <NeuSkeleton :lines="4" height="28px" />
        </div>

        <div v-else class="persona-content">
          <!-- AI 摘要正文卡 -->
          <div class="persona-summary-box neu-inset-deep">
            <div class="persona-meta-bar">
              <span class="persona-tag-badge">AI 提炼洞察</span>
              <span v-if="persona?.updatedAt" class="persona-updated neu-t2">
                更新于 {{ formatRelative(persona.updatedAt) }}
              </span>
            </div>

            <div
              v-if="persona?.summary"
              class="persona-markdown"
              v-html="renderMarkdown(persona.summary)"
            />
            <div v-else class="persona-empty neu-t2">
              <p>尚未生成你的专属画像。</p>
              <p>在下方输入引导词或点击右上角「全量重构」，让 AI 提炼你的曲库偏好。</p>
            </div>
          </div>

          <!-- 折叠区：客观曲库标签分布 -->
          <details v-if="persona?.profileLines?.length" class="disclosure">
            <summary class="sum">
              <NeuIcon name="chevron-right" :size="16" class="chev" />
              曲库客观分布数据（{{ persona.profileLines.length }} 项）
            </summary>
            <div class="persona-objective-list">
              <div v-for="(line, idx) in persona.profileLines" :key="idx" class="persona-objective-row">
                <span class="neu-t2">{{ line }}</span>
              </div>
            </div>
          </details>

          <!-- 用户引导微调输入区 -->
          <div class="persona-tuning-section">
            <div class="tune-head">
              <span class="tune-title">引导式画像调优</span>
              <span class="tune-desc neu-t2">
                告诉 AI 你的听歌心境、曲风偏好或排斥项，AI 将以你的意志为准绳重构画像
              </span>
            </div>

            <div v-if="persona?.lastGuidance" class="last-guidance neu-t2">
              <span class="guidance-label">上一轮指令：</span>
              <span class="guidance-text">“{{ persona.lastGuidance }}”</span>
            </div>

            <div class="tune-input-wrap neu-inset-deep">
              <textarea
                v-model="personaGuidance"
                class="tune-textarea"
                rows="3"
                maxlength="300"
                placeholder="例如：最近想多听点抒情流行，避免快节奏说唱..."
                :disabled="personaTuning || personaRefreshing"
                @keydown.ctrl.enter="submitTunePersona"
                @keydown.meta.enter="submitTunePersona"
              />
            </div>

            <p v-if="personaError" class="err" role="alert">{{ personaError }}</p>

            <div class="tune-actions">
              <span class="char-count neu-t2">{{ personaGuidance.length }}/300</span>
              <NeuButton
                variant="primary"
                :disabled="!personaGuidance.trim() || personaTuning || personaRefreshing"
                :loading="personaTuning"
                @click="submitTunePersona"
              >
                <NeuIcon name="sparkles" :size="16" />
                {{ personaTuning ? 'AI 正在提炼重构画像...' : '提交给 AI 调优画像' }}
              </NeuButton>
            </div>
          </div>

        </div>
      </section>

      <section class="card neu-raised-md" data-section="playlist">
        <div class="card-head">
          <h2 class="card-title">数据与备份</h2>
          <p class="card-desc neu-t2">
            歌单导入、数据备份恢复及曲库智能去重
          </p>
        </div>

        <div class="playlist-mgmt-v2">
          <!-- 区块 1：外部歌单导入 -->
          <div class="playlist-block">
            <span class="block-label neu-t2">外部歌单导入</span>
            <div class="playlist-inline-input neu-inset-deep">
              <input
                v-model="importQqLink"
                type="text"
                class="inline-input-field"
                placeholder="QQ 音乐歌单链接或纯数字 ID"
                :disabled="importingQq"
                @keydown.enter="handleImportQq"
              />
              <NeuButton
                variant="primary"
                size="sm"
                :loading="importingQq"
                :disabled="!importQqLink.trim()"
                class="inline-input-btn"
                @click="handleImportQq"
              >
                导入
              </NeuButton>
            </div>
          </div>

          <!-- 区块 2：备份与恢复对称网格 -->
          <div class="playlist-block">
            <span class="block-label neu-t2">备份与恢复归档</span>
            <div class="playlist-duo-grid">
              <!-- 导出 -->
              <div class="action-tile neu-inset" @click="handleExportSm">
                <div class="tile-icon neu-raised-xs">
                  <NeuIcon name="download" :size="18" />
                </div>
                <div class="tile-info">
                  <span class="tile-title">导出备份</span>
                  <span class="tile-sub neu-t2">归档收藏与偏好记忆</span>
                </div>
                <NeuButton
                  variant="primary"
                  size="sm"
                  :loading="exportingSm"
                  class="tile-btn"
                  @click.stop="handleExportSm"
                >
                  导出 .sm
                </NeuButton>
              </div>

              <!-- 恢复 -->
              <div class="action-tile neu-inset" @click="smFileInput?.click()">
                <input
                  ref="smFileInput"
                  type="file"
                  accept=".sm"
                  style="display: none"
                  @change="handleSmFileSelect"
                />
                <div class="tile-icon neu-raised-xs">
                  <NeuIcon name="upload" :size="18" />
                </div>
                <div class="tile-info">
                  <span class="tile-title">恢复备份</span>
                  <span class="tile-sub neu-t2">选择 .sm 文件还原曲库</span>
                </div>
                <NeuButton
                  variant="default"
                  size="sm"
                  :loading="importingSm"
                  class="tile-btn"
                  @click.stop="smFileInput?.click()"
                >
                  选择文件
                </NeuButton>
              </div>
            </div>
          </div>

          <!-- 区块 3：智能曲库去重 -->
          <div class="playlist-block">
            <div class="dedup-strip neu-inset">
              <div class="dedup-strip-info">
                <div class="strip-icon-title">
                  <NeuIcon name="sparkles" :size="16" class="strip-icon" />
                  <span class="strip-title">曲库智能去重</span>
                </div>
                <span class="strip-desc neu-t2">
                  扫描清理重复收藏的歌曲，按歌名与歌手保留最早收藏版本
                </span>
              </div>
              <NeuButton
                variant="default"
                size="sm"
                :loading="dedupChecking"
                class="strip-btn"
                @click="handleCheckDedup"
              >
                检查重复
              </NeuButton>
            </div>
          </div>
        </div>
      </section>

      <section class="card neu-raised-md" data-section="logout">
        <div class="actions">
          <NeuButton variant="danger" block @click="doLogout">退出登录</NeuButton>
        </div>
      </section>

      <section class="card neu-raised-md" data-section="status">
        <div class="card-head">
          <h2 class="card-title">服务端运行状态</h2>
          <p class="card-desc neu-t2">服务端环境与注册安全参数</p>
        </div>

        <ul v-if="cfg" class="kv">
          <li>
            <span class="k neu-t2">开放注册</span>
            <span class="v">{{ cfg.registrationOpen ? '是' : '否' }}</span>
          </li>
          <li>
            <span class="k neu-t2">已存在账号</span>
            <span class="v">{{ cfg.hasUsers ? '是' : '否' }}</span>
          </li>
          <li>
            <span class="k neu-t2">口令最短长度</span>
            <span class="v neu-num">{{ cfg.passwordMinLength }}</span>
          </li>
        </ul>
        <p v-else class="note neu-t2">
          还没取到服务端状态。若一直为空，说明基地址不通。
        </p>
      </section>
    </template>

    <!-- ============ 歌单去重确认弹窗 ============ -->
    <Teleport to="body">
      <div v-if="showDedupModal" class="scrim" @click.self="showDedupModal = false">
        <section class="dialog neu-raised-lg" role="dialog" aria-label="歌单去重">
          <header class="dialog-head">
            <div class="dialog-head-text">
              <h2 class="dialog-title">歌单去重</h2>
              <p class="dialog-sub neu-t2">
                发现 {{ dedupPreviewData?.duplicateCount }} 首重复曲目（{{ dedupPreviewData?.duplicateGroups.length }} 组）
              </p>
            </div>
            <NeuButton variant="ghost" @click="showDedupModal = false">关闭</NeuButton>
          </header>

          <div class="dialog-body">
            <div class="dialog-tip neu-inset">
              <span>系统将为您保留最早收藏的曲目版本，清理多余的重复版本。</span>
            </div>

            <div class="dedup-group-list">
              <div
                v-for="(g, idx) in dedupPreviewData?.duplicateGroups"
                :key="idx"
                class="dedup-group-item neu-flat"
              >
                <div class="dedup-item-main">
                  <span class="dedup-song-name neu-ellipsis">{{ g.name }}</span>
                  <span class="dedup-artist neu-t2 neu-ellipsis">{{ g.artist }}</span>
                </div>
                <span class="dedup-tag neu-t2">共 {{ g.count }} 首，清理 {{ g.removeIds.length }} 首</span>
              </div>
            </div>
          </div>

          <footer class="dialog-foot">
            <NeuButton variant="ghost" @click="showDedupModal = false">取消</NeuButton>
            <NeuButton
              variant="primary"
              :loading="dedupExecuting"
              @click="handleExecuteDedup"
            >
              确认清理（{{ dedupPreviewData?.duplicateCount }} 首）
            </NeuButton>
          </footer>
        </section>
      </div>
    </Teleport>

    <!-- ============ 导入 .sm 备份确认弹窗 ============ -->
    <Teleport to="body">
      <div v-if="showSmModal" class="scrim" @click.self="showSmModal = false">
        <section class="dialog neu-raised-lg" role="dialog" aria-label="导入备份确认">
          <header class="dialog-head">
            <div class="dialog-head-text">
              <h2 class="dialog-title">确认恢复备份</h2>
              <p class="dialog-sub neu-t2">.sm 软加密备份文件预检成功</p>
            </div>
            <NeuButton variant="ghost" @click="showSmModal = false">关闭</NeuButton>
          </header>

          <div class="dialog-body">
            <div class="sm-summary-grid">
              <div class="sm-stat-box neu-inset">
                <span class="sm-stat-label neu-t2">包含收藏曲目</span>
                <span class="sm-stat-val">{{ smPreviewData?.totalTracks }} 首</span>
              </div>
              <div class="sm-stat-box neu-inset">
                <span class="sm-stat-label neu-t2">音乐口味画像</span>
                <span class="sm-stat-val">{{ smPreviewData?.hasPersona ? '已包含' : '未包含' }}</span>
              </div>
            </div>

            <template v-if="smPreviewData?.hasPersona">
              <div v-if="smPreviewData.personaSummary" class="dialog-tip neu-inset">
                <div class="sm-persona-preview neu-ellipsis-2 neu-t2">
                  {{ smPreviewData.personaSummary }}
                </div>
              </div>

              <label class="sm-checkbox-row neu-flat">
                <input
                  v-model="smImportPersona"
                  type="checkbox"
                  class="neu-checkbox"
                />
                <div class="sm-checkbox-info">
                  <span class="sm-checkbox-title">同时恢复音乐记忆</span>
                  <span class="sm-checkbox-hint neu-t2">恢复归档中的音乐口味画像</span>
                </div>
              </label>

              <div v-if="smImportPersona" class="dialog-warning neu-inset">
                <span>⚠️ 恢复音乐记忆将覆盖当前账号已有的口味画像，无法撤回。</span>
              </div>
            </template>

            <div v-else class="dialog-tip neu-inset">
              <span>该备份文件中未包含音乐画像，将仅恢复收藏曲目。</span>
            </div>
          </div>

          <footer class="dialog-foot">
            <NeuButton variant="ghost" @click="showSmModal = false">取消</NeuButton>
            <NeuButton
              variant="primary"
              :loading="importingSm"
              @click="handleConfirmSmImport"
            >
              确认导入
            </NeuButton>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  max-width: 760px;
  padding-top: var(--sp-5);
  padding-bottom: var(--sp-7);
}
@media (max-width: 767px) {
  /* 底部避让交给壳的 .tail，页面自身不再叠加，避免“最后一片空白” */
  .settings {
    padding-bottom: 0;
  }
}
.h1 {
  font-size: var(--fs-2xl);
  color: var(--t1);
}

.main-tabs-wrap {
  display: flex;
  margin-top: calc(-1 * var(--sp-2));
  margin-bottom: var(--sp-1);
}
.main-tabs-wrap :deep(.neu-tabs) {
  width: 100%;
}
.main-tabs-wrap :deep(.neu-tabs-list) {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.h1-settings {
  margin: 0;
  font-size: 26px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.02em;
}

.card {
  /* 分区本身不是一张卡：标题 + 内容直接落在页面上。
     里面真正的控件组（主题、开关）才是唯一一级面板 —— 否则会出现"卡中卡"。 */
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
}

.card-head {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.card-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.card-title {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: 11px;
  letter-spacing: 0.18em;
  font-weight: var(--fw-medium);
  color: var(--t2);
}
/* 铭牌后面拖一条发丝线：分区的边界靠线，不靠卡片 */
.card-title::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--line);
}
.card-desc {
  font-size: var(--fs-xs);
  color: var(--t2);
}

.persona-content,
.models-mgmt {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
/* 服务端地址行：窄屏也不折行（输入框让位，保存按钮保持同行） */
.base-row {
  flex-wrap: nowrap;
}
.base-row .grow {
  flex: 1 1 auto;
}
.grow {
  flex: 1 1 260px;
  min-width: 0;
}

.note {
  font-size: var(--fs-xs);
  line-height: 1.7;
}
.note code {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 1px 5px;
  border-radius: var(--r-sm);
  background: var(--track);
}
.note-inline {
  font-size: var(--fs-xs);
}

/* 折叠区：用原生 details，白送键盘与屏幕阅读器支持 */
.disclosure {
  border-radius: var(--r-lg);
}
.sum {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  cursor: pointer;
  padding: var(--sp-3) var(--sp-2);
  border-radius: var(--r-md);
  color: var(--t1);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  list-style: none;
}
.sum::-webkit-details-marker {
  display: none;
}
.sum:hover {
  box-shadow:
    inset 1px 1px 2px var(--sd),
    inset -1px -1px 2px var(--sl);
}
.chev {
  transition: transform var(--dur-fast) var(--ease);
}
details[open] .chev {
  transform: rotate(90deg);
}

/* ============ 歌单与数据管理（移动端专属重塑布局） ============ */
.playlist-mgmt-v2 {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.playlist-block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.block-label {
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  letter-spacing: 0.02em;
}

/* 外部歌单单行内嵌输入框 */
.playlist-inline-input {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 4px 6px 4px var(--sp-3-5, 14px);
  border-radius: var(--r-pill);
  box-sizing: border-box;
}
.inline-input-field {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-size: var(--fs-sm);
  color: var(--t1);
  padding: var(--sp-1) 0;
}
.inline-input-field::placeholder {
  color: var(--t2);
  font-size: var(--fs-xs);
}
.inline-input-btn {
  flex-shrink: 0;
}

/* 对称备份/恢复网格 */
.playlist-duo-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.action-tile {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3-5, 14px);
  border-radius: var(--r-lg);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.action-tile:active {
  transform: scale(0.985);
}
.tile-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-text);
  flex-shrink: 0;
}
.tile-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tile-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.tile-sub {
  font-size: 11px;
  line-height: 1.4;
}
.tile-btn {
  align-self: flex-start;
}

/* 智能去重条目 */
.dedup-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-3-5, 14px);
  border-radius: var(--r-lg);
}
.dedup-strip-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.strip-icon-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.strip-icon {
  color: var(--accent-text);
  flex-shrink: 0;
}
.strip-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.strip-desc {
  font-size: var(--fs-xs);
  line-height: 1.4;
}
.strip-btn {
  flex-shrink: 0;
}

@media (max-width: 540px) {
  .playlist-duo-grid {
    grid-template-columns: 1fr;
    gap: var(--sp-2-5, 10px);
  }
  .action-tile {
    flex-direction: row;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3);
  }
  .tile-btn {
    align-self: center;
    flex-shrink: 0;
  }
  .dedup-strip {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-2-5, 10px);
  }
  .strip-btn {
    align-self: flex-end;
  }
}

/* 设备与更新：两个紧凑行，替代原先各占一张卡片 */
.quick-toggles {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
}
.qt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}
.qt-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.qt-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.qt-hint {
  font-size: var(--fs-xs);
  word-break: break-word;
}
.qt-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 0 0 auto;
}

/* ============ 外观微调组件（通用账号卡片内） ============ */
.appearance-widget {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
}
.appearance-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.appearance-lbl {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
}
.accent-picker-row {
  padding-top: var(--sp-1);
}

/* ============ 系统运维专属横幅提示 ============ */
.system-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3-5, 14px) var(--sp-4);
  border-radius: var(--r-lg);
}
.banner-icon {
  color: var(--accent-text);
  flex-shrink: 0;
  margin-top: 2px;
}
.banner-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.banner-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
.banner-desc {
  font-size: var(--fs-xs);
  line-height: 1.5;
  margin: 0;
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-2) var(--sp-2);
}

.err {
  font-size: var(--fs-sm);
  color: #b3261e;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}
:root[data-theme='dark'] .err {
  color: #ff9a92;
}

.divider {
  height: 1px;
  background: var(--sl);
  margin: var(--sp-1) 0;
}

.sessions {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.srow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}
.sinfo {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sname {
  font-size: var(--fs-sm);
  color: var(--t1);
  font-weight: var(--fw-medium);
}
.smeta {
  font-size: var(--fs-xs);
}
.srow-current {
  border: 1px solid var(--accent);
  box-shadow:
    inset 1px 1px 4px var(--sd),
    inset -1px -1px 4px var(--sl),
    0 0 0 1px var(--accent);
}
.sname-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.current-tag {
  font-size: 10px;
  font-weight: var(--fw-bold);
  color: var(--accent-text);
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--bg);
  letter-spacing: 0.03em;
  flex-shrink: 0;
}
.kick {
  flex: none;
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  color: var(--accent-text);
  background: var(--bg);
  box-shadow:
    1px 1px 3px var(--sd),
    -1px -1px 3px var(--sl);
}
.kick:active {
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}
.kick-current {
  color: #b3261e;
}
:root[data-theme='dark'] .kick-current {
  color: #ff9a92;
}

.kv {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.kv li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  font-size: var(--fs-sm);
  padding: var(--sp-2) 0;
}
.k {
  font-size: var(--fs-sm);
}
.v {
  color: var(--t1);
  font-weight: var(--fw-medium);
}

/* ---------- 音源授权（B 站 + 网易云共用，紧凑单卡片） ---------- */
/* tab：两个音源的切换按钮。小号胶囊，不做大按钮 —— 卡片要轻 */
.auth-tabs {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.auth-tab {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px 14px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  letter-spacing: 0.04em;
  color: var(--t2);
  background: var(--bg);
  box-shadow:
    2px 2px 5px var(--sd),
    -2px -2px 5px var(--sl);
  transition: color 0.15s ease;
}
.auth-tab:hover {
  color: var(--t1);
}
.auth-tab.active {
  color: var(--accent-text);
  box-shadow:
    inset 2px 2px 5px var(--sd),
    inset -2px -2px 5px var(--sl);
}
/* 已授权小圆点：绿点表示该音源已有凭证 —— 不点开也能一眼看到两边的状态 */
.auth-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--track);
}
.auth-dot.on {
  background: var(--accent-text);
}

/* 凹陷：这是"当前生效的身份"，读作状态而不是可点区域 */
.auth-account {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-3);
  border-radius: var(--r-lg);
  box-shadow:
    inset 1px 1px 4px var(--sd),
    inset -1px -1px 4px var(--sl);
}
.auth-face {
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: var(--r-pill);
  overflow: hidden;
  display: grid;
  place-items: center;
  background: var(--track);
}
.auth-face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.auth-face-fallback {
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--t2);
}
.auth-who {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 长昵称不能把「退出」按钮挤出去：flex 子项默认 min-width:auto */
  min-width: 0;
  flex: 1 1 auto;
}
.auth-name {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.auth-vip {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  font-size: 10px;
  font-weight: var(--fw-medium);
  color: #fff;
  background: var(--accent);
}
:root[data-theme='dark'] .auth-vip {
  color: #2b1a0e;
}
.auth-meta {
  font-size: var(--fs-xs);
}

.auth-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border-radius: var(--r-lg);
  box-shadow:
    inset 1px 1px 4px var(--sd),
    inset -1px -1px 4px var(--sl);
}
/*
 * 二维码必须是白底方图。不加 pixelated：本图是 SVG，
 * 栅格化再放大反而会把模块边缘糊成灰，那正是扫不出来的原因。
 * 清晰度靠 SVG 自身的 crispEdges。
 */
.auth-qr-img {
  width: 200px;
  height: 200px;
  border-radius: var(--r-md);
  background: #fff;
}
.auth-qr-state {
  font-size: var(--fs-sm);
  color: var(--t1);
  text-align: center;
  line-height: 1.6;
}
.auth-qr-state[data-state='scanned'] {
  color: var(--accent-text);
}
.auth-qr-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}
.auth-link {
  font-size: var(--fs-sm);
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.auth-cta {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
}

/* ---- 网易云账号密码登录 ---- */
.actions {
  display: flex;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

/* 强调色色板 */
.accent-label {
  flex: none;
  font-size: var(--fs-sm);
}
.accents {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--sw);
  box-shadow:
    2px 2px 5px var(--sd),
    -2px -2px 5px var(--sl);
  transition: box-shadow 0.15s ease;
}
.swatch.active {
  box-shadow:
    inset 2px 2px 5px rgba(0, 0, 0, 0.25),
    inset -2px -2px 5px rgba(255, 255, 255, 0.2);
  outline: 2px solid var(--accent-text);
  outline-offset: 2px;
}
.swatch:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: 2px;
}

/* 偏好管理 */
.dislike-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.dislike-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}
.d-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--t1);
}

@media (max-width: 767px) {
  .h1 {
    font-size: var(--fs-xl);
  }
  .h1-settings {
  margin: 0;
  font-size: 26px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.02em;
}

.card {
    padding: var(--sp-4);
  }
  .actions {
    flex-direction: column;
  }
  .actions :deep(.neu-btn) {
    width: 100%;
  }
  /* 偏好管理的两个 tab 标签带计数，窄屏下换成上下两行的紧凑排布 */
  .auth-tabs {
    flex-wrap: wrap;
  }
  .dislike-row {
    gap: var(--sp-2);
  }
}
/* ============ 模型配置卡片样式 ============ */
.current-model-summary {
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--t2);
  white-space: pre-line;
}
.disclosure-inner {
  padding: var(--sp-3) var(--sp-2) var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.persona-top-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.persona-top-hint {
  font-size: var(--fs-xs);
}

.persona-summary-box {
  padding: var(--sp-4);
  border-radius: var(--r-lg);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.persona-meta-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.persona-tag-badge {
  font-size: 11px;
  font-weight: var(--fw-bold);
  color: var(--accent-text);
  background: var(--bg);
  padding: 2px 8px;
  border-radius: var(--r-pill);
  box-shadow:
    1px 1px 2px var(--sd),
    -1px -1px 2px var(--sl);
}
.persona-updated {
  font-size: var(--fs-xs);
}

.persona-markdown {
  font-size: var(--fs-sm);
  color: var(--t1);
  line-height: 1.7;
}
.persona-markdown :deep(strong) {
  color: var(--accent-text);
  font-weight: var(--fw-bold);
}
.persona-markdown :deep(.persona-list) {
  margin: var(--sp-2) 0;
  padding-left: var(--sp-4);
  list-style: disc;
}
.persona-markdown :deep(.persona-list li) {
  margin: 3px 0;
}
.persona-markdown :deep(.persona-heading) {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  margin: var(--sp-3) 0 var(--sp-1);
  color: var(--t1);
}
.persona-markdown :deep(.persona-p) {
  margin: var(--sp-2) 0;
}
.persona-empty {
  font-size: var(--fs-sm);
  text-align: center;
  padding: var(--sp-4) 0;
  line-height: 1.6;
}

.persona-objective-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
}
.persona-objective-row {
  font-size: var(--fs-xs);
  word-break: break-all;
  line-height: 1.6;
}

.persona-tuning-section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.tune-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tune-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--t1);
}
.tune-desc {
  font-size: var(--fs-xs);
}
.last-guidance {
  font-size: var(--fs-xs);
  font-style: italic;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--bg-soft, rgba(0, 0, 0, 0.02));
  box-shadow:
    inset 1px 1px 2px var(--sd),
    inset -1px -1px 2px var(--sl);
}
.guidance-label {
  font-weight: var(--fw-medium);
}
.tune-input-wrap {
  border-radius: var(--r-md);
  padding: var(--sp-2) var(--sp-3);
}
.tune-textarea {
  width: 100%;
  background: transparent;
  border: none;
  resize: vertical;
  outline: none;
  font-size: var(--fs-sm);
  color: var(--t1);
  font-family: inherit;
  line-height: 1.5;
}
.tune-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.char-count {
  font-size: var(--fs-xs);
}

/* AI 模型卡片 */
.models-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.model-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-3-5, 14px) var(--sp-4);
  border-radius: var(--r-lg);
}
.model-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}
.model-header-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.model-title-group {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  flex-wrap: wrap;
  min-width: 0;
}
.model-name {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  color: var(--t1);
  word-break: break-word;
}
.model-slug {
  font-size: var(--fs-xs);
  font-family: var(--font-mono);
  word-break: break-all;
}
.role-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.role-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: var(--r-pill);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  flex-shrink: 0;
  line-height: 1.4;
}
.role-decide {
  background: var(--accent);
  color: #fff;
}
:root[data-theme='dark'] .role-decide {
  color: #1a1a1a;
}
.role-review {
  background: var(--bg);
  color: var(--accent-text);
  box-shadow:
    1px 1px 2px var(--sd),
    -1px -1px 2px var(--sl);
}
.model-meta-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-xs);
  min-width: 0;
}
.model-url {
  max-width: 260px;
}
.meta-dot {
  opacity: 0.6;
  flex-shrink: 0;
}
.model-key-mask {
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}
.model-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}
.kick-sm {
  padding: 4px 12px;
  font-size: var(--fs-xs);
}
.kick-danger {
  color: #b3261e;
}
:root[data-theme='dark'] .kick-danger {
  color: #ff9a92;
}

.model-test-status {
  margin-top: 2px;
}
.test-ok {
  font-size: var(--fs-xs);
  color: #2e7d32;
  font-weight: var(--fw-medium);
}
:root[data-theme='dark'] .test-ok {
  color: #81c784;
}
.test-fail {
  font-size: var(--fs-xs);
  color: #b3261e;
  word-break: break-all;
}
:root[data-theme='dark'] .test-fail {
  color: #ff9a92;
}

.add-model-wrap {
  margin-top: 2px;
}

.model-edit-card {
  padding: var(--sp-4);
  border-radius: var(--r-lg);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.model-edit-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
.edit-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
}
.edit-btn-group {
  display: flex;
  gap: var(--sp-2);
}

.role-assignment {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.assignment-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
.assignment-desc {
  font-size: var(--fs-xs);
}
.assignment-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4);
  margin-top: var(--sp-2);
}
@media (max-width: 600px) {
  .assignment-grid {
    grid-template-columns: 1fr;
  }
}
.assignment-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.select-wrap {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: var(--r-md);
  padding: 0 var(--sp-3);
  height: 40px;
}
.neu-select {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--t1);
  font-size: var(--fs-sm);
  outline: none;
  cursor: pointer;
  appearance: none;
  padding-right: var(--sp-5);
}
.select-arrow {
  position: absolute;
  right: var(--sp-3);
  pointer-events: none;
  color: var(--t2);
}
.field-hint {
  font-size: var(--fs-xs);
  line-height: 1.5;
}
.save-ai-row {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
}

@media (max-width: 767px) {
  .settings {
    gap: var(--sp-4);
  }
  .model-item {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: var(--sp-3);
  }
  .model-header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--sp-2);
  }
  .model-title-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .model-meta-row {
    flex-wrap: wrap;
    gap: 4px var(--sp-2);
  }
  .model-url {
    max-width: 100%;
    word-break: break-all;
  }
  .model-actions {
    display: flex;
    justify-content: flex-end;
    width: 100%;
    padding-top: var(--sp-2);
    border-top: 1px solid var(--sl);
    gap: var(--sp-2);
  }
  .edit-actions {
    flex-direction: column;
    align-items: stretch;
  }
  .edit-btn-group {
    width: 100%;
  }
  .edit-btn-group > * {
    flex: 1;
  }
}

/* 模态弹窗与遮罩 */
.scrim {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-overlay, 100) + 10);
  background: var(--scrim, rgba(0, 0, 0, 0.45));
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5, 20px);
}

.dialog {
  width: min(100%, 520px);
  max-height: min(85dvh, 640px);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4, 16px);
  padding: var(--sp-5, 20px);
  border-radius: var(--r-xl, 20px);
  background: var(--bg);
  box-sizing: border-box;
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3, 12px);
}

.dialog-head-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dialog-title {
  margin: 0;
  font-size: var(--fs-lg, 18px);
  font-weight: var(--fw-bold, 700);
  color: var(--t1);
}

.dialog-sub {
  margin: 0;
  font-size: var(--fs-sm, 13px);
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3, 12px);
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}

.dialog-tip {
  display: flex;
  align-items: center;
  gap: var(--sp-2, 8px);
  padding: var(--sp-2-5, 10px) var(--sp-3, 12px);
  border-radius: var(--r-md, 12px);
  font-size: var(--fs-xs, 12px);
  color: var(--t2);
  line-height: 1.4;
}

.dialog-warning {
  display: flex;
  align-items: center;
  gap: var(--sp-2, 8px);
  padding: var(--sp-2-5, 10px) var(--sp-3, 12px);
  border-radius: var(--r-md, 12px);
  font-size: var(--fs-xs, 12px);
  color: var(--accent, #e54d2e);
  line-height: 1.4;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-3, 12px);
  padding-top: var(--sp-2, 8px);
}

.dedup-group-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2, 8px);
  max-height: 280px;
  overflow-y: auto;
}

.dedup-group-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3, 12px);
  padding: var(--sp-2-5, 10px) var(--sp-3, 12px);
  border-radius: var(--r-md, 12px);
}

.dedup-item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dedup-song-name {
  font-size: var(--fs-sm, 13px);
  font-weight: var(--fw-medium, 500);
  color: var(--t1);
}

.dedup-artist {
  font-size: var(--fs-xs, 11px);
}

.dedup-tag {
  flex-shrink: 0;
  font-size: var(--fs-xs, 11px);
}

.sm-summary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3, 12px);
}

.sm-stat-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--sp-3, 12px);
  border-radius: var(--r-md, 12px);
}

.sm-stat-label {
  font-size: var(--fs-xs, 11px);
}

.sm-stat-val {
  font-size: var(--fs-base, 15px);
  font-weight: var(--fw-bold, 700);
  color: var(--t1);
}

.sm-checkbox-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3, 12px);
  padding: var(--sp-3, 12px);
  border-radius: var(--r-md, 12px);
  cursor: pointer;
}

.neu-checkbox {
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: var(--accent);
}

.sm-checkbox-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sm-checkbox-title {
  font-size: var(--fs-sm, 13px);
  font-weight: var(--fw-medium, 500);
  color: var(--t1);
}

.sm-checkbox-hint {
  font-size: var(--fs-xs, 11px);
}

.neu-ellipsis-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
