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
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import NeuSwitch from '@/components/neu/NeuSwitch.vue';
import NeuTabs from '@/components/neu/NeuTabs.vue';
import OfflineCachePanel from '@/components/OfflineCachePanel.vue';
import ServerListEditor from '@/components/ServerListEditor.vue';
import AdminUsers from '@/components/AdminUsers.vue';
import AdminMaintenance from '@/components/AdminMaintenance.vue';
import AdminAiModels from '@/components/AdminAiModels.vue';
import Sheet from '@/components/Sheet.vue';
import { isAndroid, isWebPanel } from '@/native/update.ts';
import {
  isBluetoothLyricsEnabled,
  isNativeAudio,
  setBluetoothLyricsEnabled,
} from '@/native/audio.ts';
import { useUiStore } from '@/stores/ui.ts';
import { hasBackend } from '@/api/client.ts';
import { useSessionStore } from '@/stores/session.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { useDislikesStore } from '@/stores/dislikes.ts';
import { useUpdateStore } from '@/stores/update.ts';
import { applyDedupe, previewDedupe, type DupGroup } from '@/offline/dedupe.ts';
import { applyBackup, buildBackup, downloadBackup } from '@/offline/backup.ts';
import { loadWebdav, saveWebdav, webdavGet, webdavPut } from '@/offline/webdav.ts';
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
import type { PersonaDetail } from '@/api/types.ts';

const ui = useUiStore();
const session = useSessionStore();
const favorites = useFavoritesStore();
const dislikes = useDislikesStore();
const update = useUpdateStore();

type SheetName = 'login' | 'dislikes' | 'import' | 'dedupe' | 'backup' | 'theme' | 'cache' | 'auth';
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

// ---------------------------------------------------------------- 备份
const backupBusy = ref(false);
const backupMsg = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const webdav = ref(loadWebdav());
async function exportBackup(): Promise<void> {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    downloadBackup(await buildBackup());
    backupMsg.value = '已导出';
  } catch (e) {
    backupMsg.value = e instanceof Error ? e.message : '导出失败';
  } finally {
    backupBusy.value = false;
  }
}
function pickBackup(): void {
  fileInput.value?.click();
}
async function onBackupFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  backupBusy.value = true;
  try {
    const res = await applyBackup(await file.text());
    backupMsg.value = `新增 ${res.added} 首 · 跳过 ${res.skipped}`;
    webdav.value = loadWebdav();
    await favorites.reload();
    await dislikes.reload();
  } catch (e) {
    backupMsg.value = e instanceof Error ? e.message : '导入失败';
  } finally {
    backupBusy.value = false;
  }
}
async function uploadWebdav(): Promise<void> {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    saveWebdav(webdav.value);
    await webdavPut(webdav.value, JSON.stringify(await buildBackup()));
    backupMsg.value = '已上传';
  } catch (e) {
    backupMsg.value = e instanceof Error ? e.message : '上传失败';
  } finally {
    backupBusy.value = false;
  }
}
async function downloadWebdav(): Promise<void> {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    saveWebdav(webdav.value);
    const res = await applyBackup(await webdavGet(webdav.value));
    backupMsg.value = `新增 ${res.added} 首 · 跳过 ${res.skipped}`;
    webdav.value = loadWebdav();
    await favorites.reload();
    await dislikes.reload();
  } catch (e) {
    backupMsg.value = e instanceof Error ? e.message : '下载失败';
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
    /* 浏览器同源，不需要地址；只有原生壳才读这一栏 */
    if (isNativeAudio) {
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
const personaOpen = ref(false);
const guidance = ref('');
const tuning = ref(false);


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

// ---------------------------------------------------------------- 音源授权
type SourceKind = 'bilibili' | 'netease';
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
  if (!qrKey.value) return;
  try {
    const res = qrSource.value === 'bilibili'
      ? await pollBilibiliQr(qrKey.value)
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
}

async function loadServerData(): Promise<void> {
  if (!serverConfigured.value) return;
  void session.loadAuthConfig();
  void loadSources();
  if (session.isLoggedIn) {
    void loadPersona();
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
          <button type="button" class="row row-btn" @click="sheet = 'backup'">
            <span class="row-name">数据备份</span>
            <span class="row-val">文件 · WebDAV</span>
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
          <button type="button" class="row row-btn" @click="personaOpen = !personaOpen">
            <span class="row-name">{{ persona?.summary ? '音乐画像' : '尚未生成' }}</span>
            <NeuIcon :name="personaOpen ? 'chevron-up' : 'chevron-down'" :size="16" />
          </button>
          <div v-if="personaOpen" class="pad">
            <p class="para">{{ persona?.summary || '暂无' }}</p>
            <ul class="lines">
              <li v-for="(l, i) in persona?.profileLines ?? []" :key="i">{{ l }}</li>
            </ul>
            <ul class="lines">
              <li v-for="(l, i) in persona?.ledgerLines ?? []" :key="i">{{ l }}</li>
            </ul>
          </div>
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

      <!-- 模型增删改 + 决策/复核分配：仅 Web 面板的管理员（接口层有渠道闸） -->
      <section v-if="isWebPanel && session.user?.role === 'admin'" class="sec">
        <h2 class="label">AI 模型</h2>
        <AdminAiModels />
      </section>
    </template>

    <!-- ==================== 高级 ==================== -->
    <template v-if="serverConfigured && (isDesktop || activeTab === 'advanced')">
      <section v-if="isNativeAudio" class="sec">
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
        </div>
      </section>

      <section v-if="isWebPanel && session.user?.role === 'admin'" class="sec">
        <h2 class="label">账号管理</h2>
        <AdminUsers />
      </section>

      <section v-if="isWebPanel && session.user?.role === 'admin'" class="sec">
        <h2 class="label">数据维护</h2>
        <AdminMaintenance />
      </section>

      <section v-if="isWebPanel" class="sec">
        <h2 class="label">运行情况</h2>
        <div class="panel">
          <div class="row">
            <span class="row-name">注册</span>
            <span class="row-val">{{ session.authConfig?.registrationOpen ? '开放' : '关闭' }}</span>
          </div>
          <div class="row">
            <span class="row-name">已有账号</span>
            <span class="row-val">{{ session.authConfig?.hasUsers ? '是' : '否' }}</span>
          </div>
          <div class="row">
            <span class="row-name">口令最短</span>
            <span class="row-val">{{ session.authConfig?.passwordMinLength ?? '—' }}</span>
          </div>
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
      <template v-if="serverConfigured && (isDesktop || activeTab === 'advanced')">
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

    <Sheet :open="sheet === 'backup'" title="数据备份" @close="sheet = null">
      <input ref="fileInput" type="file" accept=".sm,.json" hidden @change="onBackupFile" />
      <div class="actions">
        <NeuButton :loading="backupBusy" @click="exportBackup">导出文件</NeuButton>
        <NeuButton variant="ghost" :loading="backupBusy" @click="pickBackup">导入文件</NeuButton>
      </div>
      <p v-if="backupMsg" class="hint">{{ backupMsg }}</p>
      <div class="divider" />
      <div class="field">
        <span class="field-name">WebDAV</span>
        <NeuInput v-model="webdav.url" placeholder="https://dav.example.com/music" />
      </div>
      <div class="field">
        <span class="field-name">账号</span>
        <NeuInput v-model="webdav.user" autocomplete="username" />
      </div>
      <div class="field">
        <span class="field-name">口令</span>
        <NeuInput v-model="webdav.pass" type="password" autocomplete="current-password" />
      </div>
      <div class="actions">
        <NeuButton :loading="backupBusy" @click="uploadWebdav">上传</NeuButton>
        <NeuButton variant="primary" :loading="backupBusy" @click="downloadWebdav">下载</NeuButton>
      </div>
    </Sheet>

    <Sheet :open="sheet === 'auth'" title="音源授权" @close="closeQr">
      <div class="qr">
        <img v-if="qrImage" :src="qrImage" alt="登录二维码" class="qr-img" />
        <p class="qr-msg">{{ qrMsg }}</p>
        <p class="qr-hint">
          用 {{ qrSource === 'bilibili' ? '哔哩哔哩' : '网易云音乐' }} App 扫码
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
      <div v-if="isNativeAudio" class="field">
        <span class="field-name">服务端</span>
        <NeuInput v-model="loginAddr" placeholder="http://192.168.1.10:3210" />
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
.row-val {
  font-size: var(--fs-xs);
  color: var(--t2);
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
</style>
