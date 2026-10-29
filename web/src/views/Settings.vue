<script setup lang="ts">
/**
 * 设置。
 *
 * 无服务端：单页（无 tab）
 *   播放   蓝牙歌词 / 缓存
 *   资料库 黑名单 / 歌单导入 / 去重 / 数据备份
 *   设备   应用更新 / 主题
 *   账号   登入
 * 有服务端：本机 / 智能 / 高级
 *
 * 一次性任务（登入、黑名单、导入、去重、备份、缓存、主题）走底部弹层。
 * 服务端只负责数据同步、AI、cookie 下发；业务功能一律在客户端。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { renderMarkdown } from '@/utils/markdown.ts';
import { kugouVerifyState, refreshKugouVerifyState } from '@/utils/kugouVerify.ts';
import { fetchKugouStatus, startKugouQr, pollKugouQr, logoutKugou } from '@/api/kugou.ts';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import NeuSwitch from '@/components/neu/NeuSwitch.vue';
import NeuTabs from '@/components/neu/NeuTabs.vue';
import OfflineCachePanel from '@/components/OfflineCachePanel.vue';
import ServerListEditor from '@/components/ServerListEditor.vue';
import AdminUsers from '@/components/AdminUsers.vue';
import AdminMaintenance from '@/components/AdminMaintenance.vue';
import AdminUpdateChannel from '@/components/AdminUpdateChannel.vue';
import AdminAiModels from '@/components/AdminAiModels.vue';
import Sheet from '@/components/Sheet.vue';
import { isAndroid, isNativeShell, isWebPanel } from '@/native/update.ts';
import {
  isBluetoothLyricsEnabled,
  isNativeAudio,
  setBluetoothLyricsEnabled,
} from '@/native/audio.ts';
import { useUiStore } from '@/stores/ui.ts';
import { usePlayerStore } from '@/stores/player.ts';
import { http, ApiError } from '@/api/client.ts';
import { hasBackend } from '@/api/client.ts';
import { useSessionStore } from '@/stores/session.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { useDislikesStore } from '@/stores/dislikes.ts';
import { useUpdateStore } from '@/stores/update.ts';
import { applyDedupe, previewDedupe, type DupGroup } from '@/offline/dedupe.ts';
import { applyBackup, buildBackup, downloadBackup } from '@/offline/backup.ts';
import {
  createLocalBackup,
  downloadLocalBackup,
  fetchBackupStatus,
  fetchWebdavFiles,
  pullWebdavBackup,
  restoreFromBase64,
  rotateLocalBackups,
  saveWebdavConfig,
  setBackupPassword,
  uploadWebdavBackup,
  type BackupStatus,
  type RestoreResponse,
  type WebdavRemoteFile,
} from '@/api/backup.ts';
import { downloadBlob } from '@/utils/download.ts';
import { importQQPlaylist } from '@/api/library.ts';
import { fetchPersona, tunePersona } from '@/api/ai.ts';
import {
  fetchBilibiliStatus,
  logoutBilibili,
  pollBilibiliQr,
  startBilibiliQr,
} from '@/api/bilibili.ts';
import {
  fetchNeteaseStatus,
  logoutNetease,
  pollNeteaseQr,
  startNeteaseQr,
} from '@/api/netease.ts';
import type { PersonaDetail, KugouState } from '@/api/types.ts';

const ui = useUiStore();
const session = useSessionStore();
const favorites = useFavoritesStore();
const dislikes = useDislikesStore();
const update = useUpdateStore();
const player = usePlayerStore();
const router = useRouter();

type SheetName =
  | 'login'
  | 'dislikes'
  | 'import'
  | 'dedupe'
  | 'backup'
  | 'theme'
  | 'cache'
  | 'auth'
  | 'persona'
  | 'ai-models'
  | 'admin-users'
  | 'admin-update'
  | 'admin-anchors'
  | 'admin-maint';
const sheet = ref<SheetName | null>(null);

// ---------------------------------------------------------------- 主题
const THEME_TABS = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];
const themeValue = computed({
  get: () => ui.themeMode,
  set: v => ui.setTheme(v as 'system' | 'light' | 'dark'),
});
const themeLabel = computed(
  () => THEME_TABS.find(t => t.value === ui.themeMode)?.label ?? '跟随系统'
);

// ---------------------------------------------------------------- 蓝牙歌词
const btLyrics = ref(isBluetoothLyricsEnabled());
function toggleBtLyrics(v: boolean): void {
  btLyrics.value = v;
  setBluetoothLyricsEnabled(v);
}

// ---------------------------------------------------------------- 黑名单
const prefTab = ref<'track' | 'artist'>('track');
const dislikeRows = computed(() =>
  prefTab.value === 'track' ? dislikes.trackItems : dislikes.artistItems
);
async function undoDislike(type: 'track' | 'artist', id: string): Promise<void> {
  await dislikes.remove(type, id);
}

// ---------------------------------------------------------------- 歌单导入
const playlistLink = ref('');
const importing = ref(false);
const importMsg = ref('');
async function importPlaylist(): Promise<void> {
  const raw = playlistLink.value.trim();
  if (!raw || importing.value) return;
  importing.value = true;
  importMsg.value = '';
  try {
    const res = await importQQPlaylist(raw);
    void favorites.ensureLoaded();
    importMsg.value = `${res.playlistName} · 新增 ${res.added} 首（共 ${res.total} 首）`;
    playlistLink.value = '';
  } catch (e) {
    importMsg.value = e instanceof Error ? e.message : '导入失败';
  } finally {
    importing.value = false;
  }
}

// ---------------------------------------------------------------- 去重
const dupGroups = ref<DupGroup[]>([]);
const dupBusy = ref(false);
const dupMsg = ref('');
async function previewDup(): Promise<void> {
  if (dupBusy.value) return;
  dupBusy.value = true;
  dupMsg.value = '';
  try {
    const res = await previewDedupe();
    dupGroups.value = res.groups;
    dupMsg.value = res.duplicateCount ? `发现 ${res.duplicateCount} 首重复` : '没有重复';
  } catch (e) {
    dupMsg.value = e instanceof Error ? e.message : '检查失败';
  } finally {
    dupBusy.value = false;
  }
}
/**
 * 点「去重」这一行就直接开查，弹层只负责显示结果。
 *
 * 之前弹层里还有一个「检查重复」按钮：进弹层要再点一次才出结果，
 * 等于把同一个动作拆成两步。现在行本身就是触发点。
 */
async function openDedupe(): Promise<void> {
  dupGroups.value = [];
  dupMsg.value = '';
  sheet.value = 'dedupe';
  await previewDup();
}

async function runDedup(): Promise<void> {
  if (dupBusy.value || dupGroups.value.length === 0) return;
  dupBusy.value = true;
  try {
    const removed = await applyDedupe(dupGroups.value);
    dupGroups.value = [];
    dupMsg.value = `已清理 ${removed} 首`;
    await favorites.reload();
  } catch (e) {
    dupMsg.value = e instanceof Error ? e.message : '清理失败';
  } finally {
    dupBusy.value = false;
  }
}

// ---------------------------------------------------------------- 数据备份（管理员）
/**
 * 四块：备份口令 / 本地 / WebDAV / 恢复（外加收藏导出导入）。
 *
 * 全部走服务端 `server/src/routes/backup.ts`（requireWebAdmin）——浏览器不再直连
 * WebDAV：那条路撞 CORS，浏览器端的 WebDAV 模块已整体删除。口令只上行，
 * 界面只读 `hasPassword`，**任何地方都不回显口令本身**。
 */
const backupBusy = ref(false);
const backupMsg = ref('');
const backupErr = ref(false);
const backupStatus = ref<BackupStatus | null>(null);

const passwordDraft = ref('');
const passwordEditing = ref(false);

const davUrl = ref('');
const davUser = ref('');
const davPass = ref('');
const davAuto = ref(false);

/** 远端文件列表（服务端 PROPFIND 的结果）与当前选中项 */
const davFiles = ref<WebdavRemoteFile[]>([]);
const davSelected = ref('');
const davListBusy = ref(false);
const davListMsg = ref('');

const restoreFileInput = ref<HTMLInputElement | null>(null);
const restoreFileName = ref('');
const restoreFileBase64 = ref('');
const restorePassword = ref('');

const favoritesFileInput = ref<HTMLInputElement | null>(null);

function say(text: string, err = false): void {
  backupMsg.value = text;
  backupErr.value = err;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function formatTime(ms: number | null): string {
  if (!ms) return '从未运行';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadBackupStatus(): Promise<void> {
  try {
    const st = await fetchBackupStatus();
    backupStatus.value = st;
    davUrl.value = st.webdav.url;
    davUser.value = st.webdav.username;
    davAuto.value = st.webdav.enabled;
    davPass.value = '';
    passwordEditing.value = !st.hasPassword;
  } catch (e) {
    say(e instanceof Error ? e.message : '读取备份状态失败', true);
  }
}

/**
 * 拉一次远端文件列表（打开弹层 / 点「刷新远端列表」/ 刚保存完配置时）。
 *
 * 未配置或拉取失败都只落在 `davListMsg`（可读提示），不塞进顶部的 `say`：
 * 列表本身有独立的空态行，顶部那条留给"保存/备份/恢复"这类主动操作。
 */
async function loadDavFiles(): Promise<void> {
  if (!backupStatus.value?.webdav.configured) {
    davFiles.value = [];
    davSelected.value = '';
    davListMsg.value = '';
    return;
  }
  if (davListBusy.value) return;
  davListBusy.value = true;
  davListMsg.value = '';
  try {
    const res = await fetchWebdavFiles();
    davFiles.value = res.files;
    // 刷新后旧选中项可能已不在列表里（被远端轮转删掉）
    if (!res.files.some(f => f.name === davSelected.value)) davSelected.value = '';
  } catch (e) {
    davFiles.value = [];
    davSelected.value = '';
    davListMsg.value = e instanceof Error ? e.message : '读取远端列表失败';
  } finally {
    davListBusy.value = false;
  }
}

/** 列表空态/失败态的提示文案：任何时候都不留一块空白控件 */
const davEmptyHint = computed(() => {
  if (davListBusy.value) return '读取远端列表…';
  if (!backupStatus.value?.webdav.configured) return '未配置 WebDAV：填好地址/账号/口令并保存后可读取远端列表';
  if (davListMsg.value) return davListMsg.value;
  return '远端目录里没有 .sm 备份';
});

function openBackup(): void {
  sheet.value = 'backup';
  backupMsg.value = '';
  backupErr.value = false;
  void loadBackupStatus().then(loadDavFiles);
}

async function savePassword(): Promise<void> {
  if (backupBusy.value) return;
  const pwd = passwordDraft.value;
  if (pwd.length < 4) {
    say('备份口令至少 4 个字符', true);
    return;
  }
  backupBusy.value = true;
  try {
    await setBackupPassword(pwd);
    passwordDraft.value = '';
    await loadBackupStatus();
    say('备份口令已保存');
  } catch (e) {
    say(e instanceof Error ? e.message : '保存口令失败', true);
  } finally {
    backupBusy.value = false;
  }
}

async function runLocalBackup(): Promise<void> {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    const res = await createLocalBackup();
    say(`已生成 ${res.fileName}（${formatBytes(res.size)}），本地保留 ${res.kept} 份`);
    await loadBackupStatus();
  } catch (e) {
    say(e instanceof Error ? e.message : '备份失败', true);
  } finally {
    backupBusy.value = false;
  }
}

async function rotateLocal(): Promise<void> {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    const res = await rotateLocalBackups();
    say(`已清理 ${res.removed.length} 份，保留 ${res.kept.length} 份`);
    await loadBackupStatus();
  } catch (e) {
    say(e instanceof Error ? e.message : '清理失败', true);
  } finally {
    backupBusy.value = false;
  }
}

async function downloadArchive(name: string): Promise<void> {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    const via = await downloadBlob(await downloadLocalBackup(name), name);
    if (via === 'failed') throw new Error('下载失败：系统没有保存文件');
    say(`已下载 ${name}`);
  } catch (e) {
    say(e instanceof Error ? e.message : '下载失败', true);
  } finally {
    backupBusy.value = false;
  }
}

async function saveDav(): Promise<void> {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    const res = await saveWebdavConfig({
      url: davUrl.value,
      username: davUser.value,
      password: davPass.value || undefined,
      enabled: davAuto.value,
    });
    davPass.value = '';
    say(res.webdav.enabled ? 'WebDAV 已保存，自动备份每天 00:00 执行' : 'WebDAV 已保存（自动备份关闭）');
    await loadBackupStatus();
    await loadDavFiles();
  } catch (e) {
    say(e instanceof Error ? e.message : '保存 WebDAV 配置失败', true);
  } finally {
    backupBusy.value = false;
  }
}

async function uploadDav(): Promise<void> {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    const res = await uploadWebdavBackup();
    say(`已上传 ${res.fileName}（${formatBytes(res.size)}）`);
    await loadBackupStatus();
  } catch (e) {
    say(e instanceof Error ? e.message : '上传失败', true);
  } finally {
    backupBusy.value = false;
  }
}

/** 整库恢复成功后服务端已吊销全部登录态：本地清 token / cookie，回登录页 */
async function finishRestore(res: RestoreResponse): Promise<void> {
  restoreFileName.value = '';
  restoreFileBase64.value = '';
  restorePassword.value = '';
  sheet.value = null;
  ui.toast(res.message || '恢复成功，请用备份里的管理员账号登录', 'ok', 6000);
  await session.logout();
  await router.replace('/login');
}

async function pullDav(): Promise<void> {
  const name = davSelected.value;
  if (!name) {
    say('请先选择要恢复的远端备份文件', true);
    return;
  }
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    await finishRestore(await pullWebdavBackup(name, restorePassword.value.trim() || undefined));
  } catch (e) {
    say(e instanceof Error ? e.message : '远端恢复失败', true);
  } finally {
    backupBusy.value = false;
  }
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取备份文件失败'));
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const comma = text.indexOf(',');
      resolve(comma >= 0 ? text.slice(comma + 1) : '');
    };
    reader.readAsDataURL(file);
  });
}

function pickRestoreFile(): void {
  restoreFileInput.value?.click();
}

async function onRestoreFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    restoreFileBase64.value = await readAsBase64(file);
    restoreFileName.value = file.name;
    say(`已选择 ${file.name}（${formatBytes(file.size)}）`);
  } catch (e) {
    say(e instanceof Error ? e.message : '读取备份文件失败', true);
  }
}

async function submitRestore(): Promise<void> {
  if (!restoreFileBase64.value) {
    say('请先选择 .sm 备份文件', true);
    return;
  }
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    await finishRestore(
      await restoreFromBase64(restoreFileBase64.value, restorePassword.value.trim() || undefined)
    );
  } catch (e) {
    say(e instanceof Error ? e.message : '恢复失败', true);
  } finally {
    backupBusy.value = false;
  }
}

// ---------------------------------------------------------------- 收藏导出 / 导入
async function exportFavorites(): Promise<void> {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    const via = await downloadBackup(await buildBackup());
    say(via === 'native' ? '已导出到系统下载目录' : '已交给浏览器下载');
  } catch (e) {
    say(e instanceof Error ? e.message : '导出失败', true);
  } finally {
    backupBusy.value = false;
  }
}

function pickFavoritesFile(): void {
  favoritesFileInput.value?.click();
}

async function onFavoritesFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    const res = await applyBackup(await file.text());
    say(`收藏已合并：新增 ${res.added} 首 · 跳过 ${res.skipped} 首`);
    await favorites.reload();
  } catch (e) {
    say(e instanceof Error ? e.message : '导入失败', true);
  } finally {
    backupBusy.value = false;
  }
}

// ---------------------------------------------------------------- 服务端 / 登录
/* 浏览器同源即后端；原生必须显式配置地址 */
const serverConfigured = computed(() => hasBackend());
const TABS = computed(() => {
  const tabs = [{ value: 'local', label: '本机' }];
  if (serverConfigured.value) {
    tabs.push({ value: 'smart', label: '智能' }, { value: 'advanced', label: '高级' });
  }
  return tabs;
});
const activeTab = ref('local');

/**
 * 桌面浏览器不分 tab：一屏足够放下「本机 / 智能 / 高级」。
 * 移动端仍保留分段，避免一页滚到底。
 */
const desktopMq = typeof window !== 'undefined'
  ? window.matchMedia('(min-width: 1024px)')
  : null;
const isDesktop = ref(desktopMq?.matches ?? false);
function onDesktopChange(e: MediaQueryListEvent): void {
  isDesktop.value = e.matches;
}


const loginAddr = ref(ui.baseUrl);
const loginUser = ref('');
const loginPass = ref('');
const loginBusy = ref(false);
const loginErr = ref('');

async function doLogin(): Promise<void> {
  if (loginBusy.value) return;
  loginBusy.value = true;
  loginErr.value = '';
  try {
    /* 浏览器同源，不需要地址；只有原生壳才读这一栏。
       判据必须是 isNativeShell（Capacitor ∪ 鸿蒙）：鸿蒙没有 Capacitor 音频插件，
       用 isNativeAudio 会让它在设置页永远没有填地址的入口（2026-10-21 重审 R-6）。 */
    if (isNativeShell) {
      const addr = loginAddr.value.trim().replace(/\/+$/, '');
      if (!addr) throw new Error('请填写服务端地址');
      if (addr !== ui.baseUrl) ui.setBaseUrl(addr);
    }
    await session.login(loginUser.value, loginPass.value);
    loginPass.value = '';
    sheet.value = null;
    ui.ok('已登入');
    await loadServerData();
  } catch (e) {
    loginErr.value = e instanceof Error ? e.message : '登录失败';
  } finally {
    loginBusy.value = false;
  }
}
async function doLogout(): Promise<void> {
  await session.logout();
  activeTab.value = 'local';
}

// ---------------------------------------------------------------- 智能
const persona = ref<PersonaDetail | null>(null);
const guidance = ref('');
const tuning = ref(false);

const renderedPersonaSummary = computed(() => {
  return renderMarkdown(persona.value?.summary);
});


async function loadPersona(): Promise<void> {
  try {
    persona.value = await fetchPersona();
  } catch {
    persona.value = null;
  }
}

async function submitTune(): Promise<void> {
  const text = guidance.value.trim();
  if (!text || tuning.value) return;
  tuning.value = true;
  try {
    const res = await tunePersona(text);
    persona.value = res.persona;
    guidance.value = '';
    ui.ok('画像已更新');
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '调优失败');
  } finally {
    tuning.value = false;
  }
}


// ---------------------------------------------------------------- 音源 / 运行情况
const biliName = ref('');
const neteaseName = ref('');
const biliOn = ref(false);
const neteaseOn = ref(false);
const kugouOn = ref(false);
const kugouName = ref('');
// ---------------------------------------------------------------- 音源锚点
/** 锚点概况：自动沉淀的会压过取流链，手动锚定永远最高优先 */
const anchorStats = ref<{ auto: number; manual: number }>({ auto: 0, manual: 0 });
const purging = ref(false);

async function loadAnchorStats(): Promise<void> {
  try {
    anchorStats.value = await http.get<{ auto: number; manual: number }>('/api/admin/anchors');
  } catch {
    // 非管理员或接口不可用：保持 0，不打扰
  }
}

async function purgeAutoAnchors(): Promise<void> {
  if (purging.value) return;
  purging.value = true;
  try {
    const r = await http.post<{ removed: number; auto: number; manual: number }>('/api/admin/anchors/purge-auto', {});
    anchorStats.value = { auto: r.auto, manual: r.manual };
    // 批量清锚点会改变正在播这首的解析结果 → 角标跟着刷新
    void player.refreshCurrentSource();
    ui.ok(`已清理 ${r.removed} 条自动锚点，手动锚定保留 ${r.manual} 条`);
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '清理失败，请稍后重试');
  } finally {
    purging.value = false;
  }
}

/** 酷狗登录态（服务端统一给 label：未登录 / 已失效 / 会员到期 / 正常） */
const kugouState = ref<KugouState>('logged_out');
const kugouLabel = ref('未登录');
/** 与另两行同构：有账号名就先显示账号名，再跟登录态 */
const kugouVal = computed(() =>
  kugouOn.value && kugouName.value && !kugouName.value.startsWith('uid ')
    ? `${kugouName.value} · ${kugouLabel.value}`
    : kugouLabel.value
);
const kugouInvalid = computed(() => kugouState.value === 'invalid');

/** 服务端说「酷狗现在需要过人机验证」—— 只有它为真才显示提示与按钮 */
const kugouVerifyNeeded = computed(() => kugouVerifyState.value?.needed === true);

/**
 * 打开验证流程。
 *
 * 用新标签页：验证过程会离开设置页（手机端还会跳系统浏览器），
 * 留一个原页面回来更顺手；被弹窗拦截时退回同页跳转，保证手机也能用。
 */
function openKugouVerify(): void {
  const url = (kugouVerifyState.value?.verifyUrl || '').trim() || '/verify/kugou';
  const tab = window.open(url, '_blank');
  if (tab) {
    try {
      tab.opener = null;
    } catch {
      /* 跨域时拿不到 opener，忽略 */
    }
    return;
  }
  if (url.startsWith('/')) void router.push(url);
  else window.location.href = url;
}

// ---------------------------------------------------------------- 音源授权
type SourceKind = 'bilibili' | 'netease' | 'kugou';
const qrSource = ref<SourceKind>('bilibili');
const qrImage = ref<string | null>(null);
const qrKey = ref('');
const qrMsg = ref('');
const qrBusy = ref(false);
let qrTimer: ReturnType<typeof setInterval> | undefined;

function stopQrPolling(): void {
  if (qrTimer) {
    clearInterval(qrTimer);
    qrTimer = undefined;
  }
}

function closeQr(): void {
  stopQrPolling();
  sheet.value = null;
  qrImage.value = null;
  qrKey.value = '';
  qrMsg.value = '';
}

async function pollOnce(): Promise<void> {
  if (!qrKey.value && qrSource.value !== 'kugou') return;
  try {
    const res = qrSource.value === 'bilibili'
      ? await pollBilibiliQr(qrKey.value)
      : qrSource.value === 'kugou'
        ? await (async () => {
            const r = await pollKugouQr();
            // ⚠️ 服务端字段是 `status`（waiting/confirmed/expired），不是 state。
            //    之前读 r.state 恒 undefined → 扫码确认后仍卡在「等待扫码」，刷新才显示已授权。
            const st = r.status;
            return {
              state: st === 'confirmed' ? 'confirmed' : st === 'expired' ? 'expired' : 'waiting',
              message: st === 'confirmed' ? '已授权' : st === 'expired' ? '二维码已过期，请重新获取' : '等待扫码',
            };
          })()
        : await pollNeteaseQr(qrKey.value);
    qrMsg.value = res.message;
    if (res.state === 'confirmed') {
      stopQrPolling();
      closeQr();
      ui.ok('已授权');
      await loadSources();
    } else if (res.state === 'expired' || res.state === 'failed') {
      stopQrPolling();
    }
  } catch (e) {
    qrMsg.value = e instanceof Error ? e.message : '轮询失败';
    stopQrPolling();
  }
}

async function openQr(source: SourceKind): Promise<void> {
  if (qrBusy.value) return;
  qrBusy.value = true;
  qrSource.value = source;
  qrImage.value = null;
  qrKey.value = '';
  qrMsg.value = '正在获取二维码…';
  sheet.value = 'auth';
  try {
    if (source === 'kugou') {
      const res = await startKugouQr();
      qrImage.value = res.pngBase64;
      qrKey.value = '';   // 酷狗：key 在服务端会话里，poll 不需要 key
      qrMsg.value = '等待扫码（用酷狗概念版 App）';
      stopQrPolling();
      qrTimer = setInterval(() => void pollOnce(), 2000);
      return;
    }
    const res = source === 'bilibili' ? await startBilibiliQr() : await startNeteaseQr();
    qrImage.value = res.qrImage;
    qrKey.value = res.qrcodeKey;
    qrMsg.value = '等待扫码';
    stopQrPolling();
    qrTimer = setInterval(() => void pollOnce(), 2000);
  } catch (e) {
    qrMsg.value = e instanceof Error ? e.message : '获取二维码失败';
  } finally {
    qrBusy.value = false;
  }
}

async function logoutSource(source: SourceKind): Promise<void> {
  try {
    if (source === 'bilibili') await logoutBilibili();
    else if (source === 'kugou') await logoutKugou();
    else await logoutNetease();
    ui.ok('已退出授权');
    await loadSources();
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '退出失败');
  }
}

async function loadSources(): Promise<void> {
  if (!serverConfigured.value) return;
  try {
    const st = await fetchBilibiliStatus();
    biliOn.value = !!st.account;
    biliName.value = st.account?.name || '';
  } catch {
    biliOn.value = false;
  }
  try {
    const st = await fetchNeteaseStatus();
    neteaseOn.value = !!st.account;
    neteaseName.value = st.account?.name || '';
  } catch {
    neteaseOn.value = false;
  }
  try {
    const st = await fetchKugouStatus();
    kugouState.value = st.state;
    kugouLabel.value = st.label;
    kugouOn.value = st.state !== 'logged_out';
    kugouName.value = st.nickname ? st.nickname : (st.userid ? 'uid ' + st.userid : '');
  } catch {
    kugouOn.value = false;
    kugouState.value = 'logged_out';
    kugouLabel.value = '未登录';
  }
  // 每次打开设置页（以及授权 / 退出后）都重新探测一次「酷狗是否需要人机验证」
  void refreshKugouVerifyState(true);
}

async function loadServerData(): Promise<void> {
  if (!serverConfigured.value) return;
  void session.loadAuthConfig();
  void loadSources();
  if (session.isLoggedIn) {
    void loadPersona();
    // 锚点统计只在管理员面板可见；非管理员 403 时静默
    if (isWebPanel && session.user?.role === 'admin') void loadAnchorStats();
  }
}

onMounted(() => {
  desktopMq?.addEventListener('change', onDesktopChange);
  void dislikes.ensureLoaded();
  void favorites.ensureLoaded();
  void loadServerData();
});

onBeforeUnmount(() => {
  desktopMq?.removeEventListener('change', onDesktopChange);
  stopQrPolling();
});
</script>

<template>
  <div class="settings neu-container">
    <h1 class="page-title">设置</h1>
    <p v-if="session.isLoggedIn && ui.serverDown" class="offline">服务端已断开</p>

    <div v-if="serverConfigured && !isDesktop" class="tabs-wrap">
      <NeuTabs v-model="activeTab" :items="TABS" />
    </div>

    <!-- ==================== 本机 ==================== -->
    <template v-if="!serverConfigured || isDesktop || activeTab === 'local'">
      <!-- 浏览器里蓝牙歌词与缓存都不存在，整块会是空的 -->
      <section v-if="isAndroid || isNativeAudio" class="sec">
        <h2 class="label">播放</h2>
        <div class="panel">
          <div v-if="isAndroid" class="row">
            <span class="row-name">蓝牙歌词</span>
            <NeuSwitch
              :model-value="btLyrics"
              aria-label="蓝牙歌词"
              @update:model-value="toggleBtLyrics"
            />
          </div>
          <button v-if="isNativeAudio" type="button" class="row row-btn" @click="sheet = 'cache'">
            <span class="row-name">缓存</span>
            <span class="row-val">管理</span>
          </button>
        </div>
      </section>

      <section class="sec">
        <h2 class="label">资料库</h2>
        <div class="panel">
          <button type="button" class="row row-btn" @click="sheet = 'dislikes'">
            <span class="row-name">黑名单</span>
            <span class="row-val">
              歌曲 {{ dislikes.trackItems.length }} · 歌手 {{ dislikes.artistItems.length }}
            </span>
          </button>
          <button type="button" class="row row-btn" @click="sheet = 'import'">
            <span class="row-name">歌单导入</span>
            <span class="row-val">QQ 歌单</span>
          </button>
          <button type="button" class="row row-btn" @click="openDedupe">
            <span class="row-name">去重</span>
            <span class="row-val">本机收藏</span>
          </button>
          <!-- 备份/恢复全是 requireWebAdmin 的同源 cookie 接口：非管理员连入口都不显示 -->
          <button
            v-if="isWebPanel && session.user?.role === 'admin'"
            type="button"
            class="row row-btn"
            @click="openBackup"
          >
            <span class="row-name">数据备份</span>
            <span class="row-val">口令 · 本地 · WebDAV</span>
          </button>
        </div>
      </section>

      <!-- 桌面端主题由左下角按钮切换；浏览器也没有应用更新 -->
      <section v-if="!isDesktop || isNativeAudio" class="sec">
        <h2 class="label">设备</h2>
        <div class="panel">
          <div v-if="isNativeAudio" class="row">
            <span class="row-name">应用更新</span>
            <div class="row-actions">
              <span class="row-val">
                {{ update.appVersion ? `v${update.appVersion.versionName}` : '—' }}
                <template v-if="update.latest">· 最新 v{{ update.latest.versionName }}</template>
              </span>
              <NeuButton size="sm" :loading="update.checking" @click="update.check(false)">
                检查
              </NeuButton>
              <NeuButton
                v-if="update.available"
                size="sm"
                variant="primary"
                :loading="update.installing"
                @click="update.open()"
              >
                更新
              </NeuButton>
            </div>
          </div>
          <button v-if="!isDesktop" type="button" class="row row-btn" @click="sheet = 'theme'">
            <span class="row-name">主题</span>
            <span class="row-val">{{ themeLabel }}</span>
          </button>
        </div>
      </section>

      <section class="sec">
        <h2 class="label">账号</h2>
        <div class="panel">
          <button
            v-if="!session.isLoggedIn"
            type="button"
            class="row row-btn"
            @click="sheet = 'login'"
          >
            <span class="row-name">登入</span>
            <span class="row-val">未登录</span>
          </button>
          <div v-else class="row">
            <span class="row-name">{{ session.displayName }}</span>
            <NeuButton size="sm" variant="danger" @click="doLogout">登出</NeuButton>
          </div>
        </div>
      </section>
    </template>

    <!-- ==================== 智能 ==================== -->
    <template v-if="serverConfigured && (isDesktop || activeTab === 'smart')">
      <section class="sec">
        <h2 class="label">画像</h2>
        <div class="panel">
          <button type="button" class="row row-btn" @click="sheet = 'persona'">
            <span class="row-name">音乐画像</span>
            <span class="row-val">{{ persona?.summary ? '查看画像' : '尚未生成' }}</span>
          </button>
        </div>
      </section>

      <section class="sec">
        <h2 class="label">调优</h2>
        <div class="panel pad">
          <NeuInput v-model="guidance" placeholder="例如：少一点电音" />
          <div class="actions">
            <NeuButton
              variant="primary"
              :loading="tuning"
              :disabled="!guidance.trim()"
              @click="submitTune"
            >
              提交
            </NeuButton>
          </div>
        </div>
      </section>

      <!-- 模型增删改 + 决策/复核分配：收缩为弹层入口 -->
      <section v-if="isWebPanel && session.user?.role === 'admin'" class="sec">
        <h2 class="label">AI 模型</h2>
        <div class="panel">
          <button type="button" class="row row-btn" @click="sheet = 'ai-models'">
            <span class="row-name">AI 模型配置</span>
            <span class="row-val">查看与配置</span>
          </button>
        </div>
      </section>
    </template>

    <!-- ==================== 高级 ==================== -->
    <template v-if="serverConfigured && (isDesktop || activeTab === 'advanced')">
      <!-- 多服务端：门禁用 isNativeShell（Capacitor ∪ 鸿蒙），不能用 isNativeAudio -->
      <section v-if="isNativeShell" class="sec">
        <h2 class="label">多服务端</h2>
        <ServerListEditor />
      </section>

      <!-- 音源授权：状态全员只读；扫码/退出仅 Web 面板管理员 -->
      <section class="sec">
        <h2 class="label">音源授权</h2>
        <div class="panel">
          <div class="row">
            <span class="row-name">B 站</span>
            <span class="row-val">{{ biliOn ? biliName || '已授权' : '未授权' }}</span>
            <template v-if="isWebPanel && session.user?.role === 'admin'">
              <NeuButton v-if="!biliOn" size="sm" @click="openQr('bilibili')">授权</NeuButton>
              <NeuButton v-else size="sm" variant="ghost" @click="logoutSource('bilibili')">退出</NeuButton>
            </template>
          </div>
          <div class="row">
            <span class="row-name">网易云</span>
            <span class="row-val">{{ neteaseOn ? neteaseName || '已授权' : '未授权' }}</span>
            <template v-if="isWebPanel && session.user?.role === 'admin'">
              <NeuButton v-if="!neteaseOn" size="sm" @click="openQr('netease')">授权</NeuButton>
              <NeuButton v-else size="sm" variant="ghost" @click="logoutSource('netease')">退出</NeuButton>
            </template>
          </div>
          <div class="row">
            <span class="row-name">酷狗</span>
            <span class="row-val">{{ kugouVal }}</span>
            <span v-if="kugouVerifyNeeded" class="row-tag">需要验证</span>
            <NeuButton v-if="kugouVerifyNeeded" size="sm" variant="ghost" @click="openKugouVerify">
              解除验证
            </NeuButton>
            <template v-if="isWebPanel && session.user?.role === 'admin'">
              <NeuButton v-if="!kugouOn || kugouInvalid" size="sm" @click="openQr('kugou')">授权</NeuButton>
              <NeuButton v-else size="sm" variant="ghost" @click="logoutSource('kugou')">退出</NeuButton>
            </template>
          </div>
        </div>
      </section>

      <!-- 系统运维：合并管理员管理项为统一面板，收缩为弹层 -->
      <section v-if="isWebPanel && session.user?.role === 'admin'" class="sec">
        <h2 class="label">系统运维</h2>
        <div class="panel">
          <button type="button" class="row row-btn" @click="sheet = 'admin-users'">
            <span class="row-name">账号管理</span>
            <span class="row-val">用户与权限</span>
          </button>
          <button type="button" class="row row-btn" @click="sheet = 'admin-update'">
            <span class="row-name">更新通道</span>
            <span class="row-val">服务端与双端更新</span>
          </button>
          <button type="button" class="row row-btn" @click="sheet = 'admin-anchors'">
            <span class="row-name">音源锚点</span>
            <span class="row-val">自动 {{ anchorStats.auto }} · 手动 {{ anchorStats.manual }}</span>
          </button>
          <button type="button" class="row row-btn" @click="sheet = 'admin-maint'">
            <span class="row-name">数据维护</span>
            <span class="row-val">备份与完整性</span>
          </button>
        </div>
      </section>
    </template>

    <!-- ==================== 弹层 ==================== -->
    <Sheet :open="sheet === 'cache'" title="缓存" @close="sheet = null">
      <OfflineCachePanel />
    </Sheet>

    <Sheet :open="sheet === 'dislikes'" title="黑名单" @close="sheet = null">
      <div class="seg">
        <button
          type="button"
          class="seg-tab"
          :class="{ on: prefTab === 'track' }"
          @click="prefTab = 'track'"
        >
          歌曲 {{ dislikes.trackItems.length }}
        </button>
        <button
          type="button"
          class="seg-tab"
          :class="{ on: prefTab === 'artist' }"
          @click="prefTab = 'artist'"
        >
          歌手 {{ dislikes.artistItems.length }}
        </button>
      </div>
      <div class="sheet-list">
        <div v-for="d in dislikeRows" :key="d.targetId" class="row">
          <span class="row-name ellipsis">{{ d.name || d.targetId }}</span>
          <NeuButton size="sm" variant="ghost" @click="undoDislike(prefTab, d.targetId)">
            恢复
          </NeuButton>
        </div>
        <div v-if="dislikeRows.length === 0" class="row empty">没有记录</div>
      </div>
    </Sheet>

    <Sheet :open="sheet === 'import'" title="歌单导入" @close="sheet = null">
      <NeuInput v-model="playlistLink" placeholder="QQ 歌单链接或 id" />
      <NeuButton variant="primary" block :loading="importing" @click="importPlaylist">
        导入
      </NeuButton>
      <p v-if="importMsg" class="hint">{{ importMsg }}</p>
    </Sheet>

    <Sheet :open="sheet === 'dedupe'" title="去重" @close="sheet = null">
      <p v-if="dupBusy" class="hint">检查中…</p>
      <!-- 弹层里**不能**再套 activeTab 门禁：入口在「本机/资料库」分组，
           弹层正文却要求 advanced 页签 → 手机上点「去重」只闪一下"检查中…"，
           结果永远无处显示（重审 F）。这里只保留 serverConfigured。 -->
      <template v-if="serverConfigured">
        <p v-if="dupMsg" class="hint">{{ dupMsg }}</p>
        <NeuButton
          v-if="dupGroups.length > 0"
          variant="primary"
          :loading="dupBusy"
          @click="runDedup"
        >
          清理 {{ dupGroups.reduce((n, g) => n + g.removeIds.length, 0) }} 首
        </NeuButton>
      </template>
    </Sheet>

    <!-- 数据备份：口令 / 本地 / WebDAV / 恢复 + 收藏导出导入 -->
    <Sheet :open="sheet === 'backup'" title="数据备份" @close="sheet = null">
      <input ref="restoreFileInput" type="file" accept=".sm" hidden @change="onRestoreFile" />
      <input
        ref="favoritesFileInput"
        type="file"
        accept=".json,application/json"
        hidden
        @change="onFavoritesFile"
      />

      <p v-if="!backupStatus && !backupMsg" class="hint">读取备份状态…</p>
      <p v-if="backupMsg" class="hint" :class="{ err: backupErr }">{{ backupMsg }}</p>

      <!-- a) 备份口令：只显示"是否已设置"，口令本身从不回显 -->
      <h3 class="persona-subhead">备份口令</h3>
      <div class="field">
        <span class="field-name">状态</span>
        <div class="row-actions">
          <span class="row-val">
            {{ backupStatus?.hasPassword ? '已设置' : '首次使用需设定备份口令' }}
          </span>
          <NeuButton
            v-if="backupStatus?.hasPassword && !passwordEditing"
            size="sm"
            variant="ghost"
            @click="passwordEditing = true"
          >
            更换
          </NeuButton>
        </div>
      </div>
      <template v-if="passwordEditing || !backupStatus?.hasPassword">
        <div class="field">
          <span class="field-name">口令</span>
          <NeuInput
            v-model="passwordDraft"
            type="password"
            placeholder="至少 4 个字符"
            autocomplete="new-password"
          />
        </div>
        <div class="actions">
          <NeuButton
            variant="primary"
            :loading="backupBusy"
            :disabled="passwordDraft.length < 4"
            @click="savePassword"
          >
            保存口令
          </NeuButton>
        </div>
      </template>

      <!-- b) 本地备份 -->
      <div class="divider" />
      <h3 class="persona-subhead">本地备份</h3>
      <div class="field">
        <span class="field-name">目录</span>
        <span class="row-val ellipsis">{{ backupStatus?.localDir || '—' }}</span>
      </div>
      <div class="actions">
        <NeuButton
          variant="primary"
          :loading="backupBusy"
          :disabled="!backupStatus?.hasPassword"
          @click="runLocalBackup"
        >
          立即备份
        </NeuButton>
        <NeuButton variant="ghost" :loading="backupBusy" @click="rotateLocal">清理旧备份</NeuButton>
      </div>
      <p class="hint">整库加密归档（.sm），服务端自动只保留最新 2 份。</p>
      <div class="sheet-list">
        <div v-for="f in backupStatus?.localFiles ?? []" :key="f.name" class="row">
          <span class="row-name ellipsis">{{ f.name }}</span>
          <span class="row-val">{{ formatBytes(f.size) }} · {{ formatTime(f.mtimeMs) }}</span>
          <NeuButton size="sm" variant="ghost" @click="downloadArchive(f.name)">下载</NeuButton>
        </div>
        <div v-if="(backupStatus?.localFiles.length ?? 0) === 0" class="row empty">
          还没有本地备份
        </div>
      </div>

      <!-- c) WebDAV -->
      <div class="divider" />
      <h3 class="persona-subhead">WebDAV</h3>
      <div class="field">
        <span class="field-name">地址</span>
        <NeuInput v-model="davUrl" placeholder="https://dav.example.com/music" />
      </div>
      <div class="field">
        <span class="field-name">账号</span>
        <NeuInput v-model="davUser" autocomplete="username" />
      </div>
      <div class="field">
        <span class="field-name">口令</span>
        <NeuInput
          v-model="davPass"
          type="password"
          autocomplete="current-password"
          :placeholder="backupStatus?.webdav.hasPassword ? '已保存，留空表示不修改' : 'WebDAV 口令'"
        />
      </div>
      <div class="field">
        <span class="field-name">自动</span>
        <div class="row-actions">
          <span class="row-val">自动备份（每天 00:00）</span>
          <NeuSwitch v-model="davAuto" aria-label="自动备份（每天 00:00）" />
        </div>
      </div>
      <div class="actions">
        <NeuButton :loading="backupBusy" @click="saveDav">保存配置</NeuButton>
        <NeuButton
          variant="primary"
          :loading="backupBusy"
          :disabled="!backupStatus?.webdav.configured"
          @click="uploadDav"
        >
          立即上传
        </NeuButton>
      </div>
      <p class="hint">
        上次运行：{{ formatTime(backupStatus?.webdav.lastRunAt ?? null) }}
        <template v-if="backupStatus?.webdav.lastResult">
          · {{ backupStatus.webdav.lastResult }}
        </template>
      </p>
      <div class="field">
        <span class="field-name">远端文件</span>
        <div class="row-actions">
          <span class="row-val ellipsis">
            {{ davSelected || (backupStatus?.webdav.configured ? '未选择' : '—') }}
          </span>
          <NeuButton
            size="sm"
            variant="ghost"
            :loading="davListBusy"
            :disabled="!backupStatus?.webdav.configured"
            @click="loadDavFiles"
          >
            刷新远端列表
          </NeuButton>
        </div>
      </div>
      <!-- 落成"可选列表"而不是手输文件名：条目直接来自服务端 PROPFIND（只有 name/时间，
           没有 size），点一行即选中，选中的行带 .dot 标记（与主题弹层同一套样式） -->
      <div class="sheet-list" role="radiogroup" aria-label="远端备份文件">
        <button
          v-for="f in davFiles"
          :key="f.name"
          type="button"
          class="row row-btn"
          role="radio"
          :aria-checked="davSelected === f.name"
          @click="davSelected = f.name"
        >
          <span class="row-name ellipsis">{{ f.name }}</span>
          <span class="row-val">{{ formatTime(f.lastModified) }}</span>
          <span v-if="davSelected === f.name" class="dot" />
        </button>
        <div v-if="davFiles.length === 0" class="row empty">{{ davEmptyHint }}</div>
      </div>
      <div class="actions">
        <NeuButton
          variant="ghost"
          :loading="backupBusy"
          :disabled="!davSelected"
          @click="pullDav"
        >
          从远端恢复
        </NeuButton>
      </div>
      <p class="hint">远端恢复用下方「恢复」块的口令；留空则用服务端已保存的备份口令。</p>

      <!-- d) 恢复：成功后强制登出 -->
      <div class="divider" />
      <h3 class="persona-subhead">恢复</h3>
      <div class="field">
        <span class="field-name">文件</span>
        <div class="row-actions">
          <span class="row-val ellipsis">{{ restoreFileName || '未选择 .sm 文件' }}</span>
          <NeuButton size="sm" variant="ghost" @click="pickRestoreFile">选择</NeuButton>
        </div>
      </div>
      <div class="field">
        <span class="field-name">口令</span>
        <NeuInput
          v-model="restorePassword"
          type="password"
          placeholder="备份口令（留空用已保存的）"
          autocomplete="off"
        />
      </div>
      <div class="actions">
        <NeuButton
          variant="danger"
          :loading="backupBusy"
          :disabled="!restoreFileBase64"
          @click="submitRestore"
        >
          恢复并重新登录
        </NeuButton>
      </div>
      <p class="hint">整库覆盖：恢复成功后所有登录态失效，请用备份里的管理员账号重新登录。</p>

      <!-- 收藏导出 / 导入（纯收藏，不含账号、凭据、锚点、主题） -->
      <div class="divider" />
      <h3 class="persona-subhead">收藏</h3>
      <div class="actions">
        <NeuButton :loading="backupBusy" @click="exportFavorites">导出收藏</NeuButton>
        <NeuButton variant="ghost" :loading="backupBusy" @click="pickFavoritesFile">
          导入收藏
        </NeuButton>
      </div>
      <p class="hint">导出体只含收藏曲目；导入为增量合并，重复的跳过。</p>
    </Sheet>

    <Sheet :open="sheet === 'auth'" title="音源授权" @close="closeQr">
      <div class="qr">
        <img v-if="qrImage" :src="qrImage" alt="登录二维码" class="qr-img" />
        <p class="qr-msg">{{ qrMsg }}</p>
        <p class="qr-hint">
          用 {{ qrSource === 'bilibili' ? '哔哩哔哩' : qrSource === 'kugou' ? '酷狗概念版' : '网易云音乐' }} App 扫码
        </p>
      </div>
    </Sheet>

    <Sheet :open="sheet === 'theme'" title="主题" @close="sheet = null">
      <button
        v-for="t in THEME_TABS"
        :key="t.value"
        type="button"
        class="row row-btn"
        @click="themeValue = t.value as 'system' | 'light' | 'dark'"
      >
        <span class="row-name">{{ t.label }}</span>
        <span v-if="ui.themeMode === t.value" class="dot" />
      </button>
    </Sheet>

    <Sheet :open="sheet === 'login'" title="登入" @close="sheet = null">
      <!-- 同 doLogin 里的判据：原生壳（Capacitor ∪ 鸿蒙）才需要填地址 -->
      <div v-if="isNativeShell" class="field">
        <span class="field-name">服务端</span>
        <NeuInput v-model="loginAddr" placeholder="http://IP:端口 或 https://域名" />
      </div>
      <div class="field">
        <span class="field-name">账号</span>
        <NeuInput v-model="loginUser" autocomplete="username" />
      </div>
      <div class="field">
        <span class="field-name">口令</span>
        <NeuInput v-model="loginPass" type="password" autocomplete="current-password" />
      </div>
      <NeuButton variant="primary" block :loading="loginBusy" @click="doLogin">登入</NeuButton>
      <p v-if="loginErr" class="hint err">{{ loginErr }}</p>
    </Sheet>

    <!-- 音乐画像弹层 -->
    <Sheet :open="sheet === 'persona'" title="音乐画像" @close="sheet = null">
      <div class="sheet-pad persona-sheet-content">
        <div v-if="persona?.summary" class="persona-markdown" v-html="renderedPersonaSummary" />
        <p v-else class="empty-hint">暂无音乐画像，请先在客户端听歌并积累播放记录</p>
        <template v-if="persona?.profileLines?.length">
          <h3 class="persona-subhead">口味特征</h3>
          <ul class="md-ul">
            <li v-for="(l, i) in persona.profileLines" :key="i">{{ l }}</li>
          </ul>
        </template>
        <template v-if="persona?.ledgerLines?.length">
          <h3 class="persona-subhead">记忆账本</h3>
          <ul class="md-ul">
            <li v-for="(l, i) in persona.ledgerLines" :key="i">{{ l }}</li>
          </ul>
        </template>
      </div>
    </Sheet>

    <!-- AI 模型配置弹层 -->
    <Sheet :open="sheet === 'ai-models'" title="AI 模型配置" @close="sheet = null">
      <div class="sheet-pad">
        <AdminAiModels />
      </div>
    </Sheet>

    <!-- 账号管理弹层 -->
    <Sheet :open="sheet === 'admin-users'" title="账号管理" @close="sheet = null">
      <div class="sheet-pad">
        <AdminUsers />
      </div>
    </Sheet>

    <!-- 更新通道弹层 -->
    <Sheet :open="sheet === 'admin-update'" title="更新通道" @close="sheet = null">
      <div class="sheet-pad">
        <AdminUpdateChannel />
      </div>
    </Sheet>

    <!-- 音源锚点弹层 -->
    <Sheet :open="sheet === 'admin-anchors'" title="音源锚点管理" @close="sheet = null">
      <div class="sheet-pad">
        <div class="panel">
          <div class="row">
            <span class="row-name">自动锚点</span>
            <span class="row-val">{{ anchorStats.auto }} 条（优先于取流链）</span>
          </div>
          <div class="row">
            <span class="row-name">手动锚定</span>
            <span class="row-val">{{ anchorStats.manual }} 条（永远最高优先，清理不会动）</span>
          </div>
          <div class="row">
            <span class="row-name">清理自动锚点</span>
            <span class="row-val">清空后这些曲目回到自动判定（酷狗 → B 站）</span>
            <NeuButton size="sm" :loading="purging" :disabled="anchorStats.auto === 0" @click="purgeAutoAnchors">
              清理
            </NeuButton>
          </div>
        </div>
      </div>
    </Sheet>

    <!-- 数据维护弹层 -->
    <Sheet :open="sheet === 'admin-maint'" title="数据维护" @close="sheet = null">
      <div class="sheet-pad">
        <AdminMaintenance />
      </div>
    </Sheet>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding-top: var(--sp-4);
  padding-bottom: var(--sp-7);
}

.page-title {
  margin: 0;
  font-size: 26px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.02em;
  color: var(--t1);
}

.offline {
  margin: calc(var(--sp-3) * -1) 0 0;
  font-size: var(--fs-xs);
  color: #d4564a;
}

.tabs-wrap {
  margin-top: calc(var(--sp-2) * -1);
}

.sec {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.label {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.18em;
  font-weight: var(--fw-medium);
  color: var(--t2);
}
.label::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--line);
}

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: inset 0 1px 0 var(--hi);
  overflow: hidden;
}
.pad {
  padding: var(--sp-3) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.row {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 0 var(--sp-4);
}
.row + .row {
  border-top: 1px solid var(--line);
}
.row-btn {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--t1);
  cursor: pointer;
  font-size: var(--fs-md);
  text-align: left;
}
.row-btn:active {
  background: var(--panel-2);
}
.row-name {
  font-size: var(--fs-md);
  color: var(--t1);
  min-width: 0;
}

/* 音源授权行：三列对齐 —— 名称固定列宽、状态紧跟其后、按钮推到最右。
   space-between 会把三列均匀撑开，名称长短不一时状态列就参差了。
   限定在本节内：.row-name/.row-val 是全局类，别处（WebDAV 等）仍是旧布局。 */
.panel .row .row-name {
  flex: 0 0 8.5em;
}
.panel .row .row-val {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-val {
  font-size: var(--fs-xs);
  color: var(--t2);
}

/* 「需要验证」小标：只提示、不抢状态列的宽度（状态列自带省略号） */
.row-tag {
  flex: none;
  padding: 1px 8px;
  border: 1px solid rgba(232, 163, 61, 0.55);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  color: #e8a33d;
  white-space: nowrap;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.empty {
  color: var(--t2);
  font-size: var(--fs-sm);
}

.seg {
  display: flex;
  gap: var(--sp-4);
  border-bottom: 1px solid var(--line);
}
.seg-tab {
  position: relative;
  padding: 4px 0 10px;
  border: 0;
  background: transparent;
  color: var(--t2);
  font-family: inherit;
  font-size: var(--fs-xs);
  letter-spacing: 0.06em;
  cursor: pointer;
}
.seg-tab.on {
  color: var(--t1);
}
.seg-tab.on::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
}

.sheet-list {
  display: flex;
  flex-direction: column;
}
.sheet-list .row {
  padding: 0;
}
/* 可点选的列表行（远端备份文件）：.row 的 padding 被清成 0，按钮行补回竖向热区 */
.sheet-list .row-btn {
  padding: 6px 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.field {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.field-name {
  width: 56px;
  flex: none;
  font-size: var(--fs-sm);
  color: var(--t2);
}
.field > :last-child {
  flex: 1 1 auto;
  min-width: 0;
}
/* 输入框内部的 flex 容器也要能收缩，否则带「眼睛」图标时会顶出右边界 */
.field :deep(.wrap) {
  min-width: 0;
  width: 100%;
}

.select {
  width: 100%;
  min-height: 40px;
  padding: 0 var(--sp-3);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  color: var(--t1);
  font-family: inherit;
  font-size: var(--fs-md);
}

.divider {
  height: 1px;
  background: var(--line);
}

.hint {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--t2);
}
.hint.err {
  color: #d4564a;
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.para {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--t1);
}
.lines {
  margin: 0;
  padding-left: 18px;
  font-size: var(--fs-xs);
  color: var(--t2);
  line-height: 1.7;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 8px 0 4px;
}
.qr-img {
  width: 200px;
  height: 200px;
  border-radius: var(--r-sm);
  background: #fff;
  padding: 8px;
}
.qr-msg {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--t1);
}
.qr-hint {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--t2);
}

@media (min-width: 1024px) {
  /*
   * 桌面改成一张「表单」：左侧标签列，右侧内容列，分区用发丝线分隔。
   * 不再用卡片网格 —— 卡片高低不一正是混乱的来源。
   */
  .settings {
    display: block;
    max-width: 980px;
    margin: 0 auto;
    padding-top: var(--sp-6);
    padding-bottom: var(--sp-6);
  }
  .page-title {
    margin-bottom: var(--sp-3);
  }
  .offline {
    margin-bottom: var(--sp-3);
  }
  .tabs-wrap {
    margin-bottom: var(--sp-4);
  }
  .sec {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    align-items: start;
    gap: 28px;
    padding: 22px 0;
    border-top: 1px solid var(--line);
    margin: 0;
  }
  .label {
    margin: 0;
    padding-top: 12px;
    font-size: 12px;
    letter-spacing: 0.14em;
    color: var(--t2);
  }
  /* 标签列不需要那条延伸线 */
  .label::after {
    display: none;
  }
  /*
   * 表单里不再套卡片：面板透明、去边框，行与行之间用发丝线分隔。
   * 之前每个分区都是一个盒子，盒子里再套面板，视觉上全是边框和空白。
   */
  .panel {
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    overflow: visible;
  }
  .panel > .row,
  .panel > .row-btn {
    padding-left: 0;
    padding-right: 0;
  }
  .panel > .row + .row,
  .panel > .row-btn + .row-btn {
    border-top: 1px solid var(--line);
  }
}

.sheet-pad {
  padding: 1.25rem 0.5rem;
}

.persona-sheet-content {
  max-height: 70vh;
  overflow-y: auto;
}

.persona-subhead {
  font-size: 1rem;
  font-weight: 600;
  margin: 1.5rem 0 0.5rem;
  color: var(--t1);
}

.empty-hint {
  color: var(--t2);
  font-size: 0.875rem;
  text-align: center;
  padding: 2rem 0;
}

.persona-markdown {
  font-size: 0.9375rem;
  line-height: 1.7;
  color: var(--t1);
}

.persona-markdown :deep(.md-h1),
.persona-markdown :deep(.md-h2) {
  font-size: 1.125rem;
  font-weight: 600;
  margin: 1.25rem 0 0.5rem;
  color: var(--t1);
}

.persona-markdown :deep(.md-h3),
.persona-markdown :deep(.md-h4) {
  font-size: 1rem;
  font-weight: 600;
  margin: 1rem 0 0.375rem;
  color: var(--t1);
}

.persona-markdown :deep(.md-p) {
  margin: 0.6rem 0;
}

.persona-markdown :deep(.md-ul),
.persona-markdown :deep(.md-ol),
.md-ul {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}

.persona-markdown :deep(li),
.md-ul li {
  margin: 0.25rem 0;
  color: var(--t2);
}

.persona-markdown :deep(.md-hr) {
  border: none;
  border-top: 1px solid var(--line);
  margin: 1rem 0;
}

.persona-markdown :deep(.md-quote) {
  margin: 0.75rem 0;
  padding: 0.5rem 0.75rem;
  border-left: 3px solid var(--accent);
  background: var(--panel);
  border-radius: 4px;
}

.persona-markdown :deep(strong) {
  color: var(--accent);
  font-weight: 600;
}

.persona-markdown :deep(.md-code) {
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
  background: var(--panel);
  font-size: 0.85em;
}
</style>
