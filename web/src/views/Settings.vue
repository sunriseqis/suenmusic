<script setup lang="ts">
/**
 * 设置。
 *
 * 无服务端：单页（无 tab）—— 蓝牙歌词 / 缓存 / 黑名单 / 歌单导入 / 去重 /
 *           数据备份 / 应用更新 / 主题 / 登入
 * 有服务端：本机 / 智能 / 高级
 *
 * 原则：服务端只负责数据同步、AI、cookie 下发；业务功能一律在客户端。
 * 界面不写说明文案；每项只有名称与必要状态。
 */
import { computed, onMounted, ref } from 'vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import NeuSwitch from '@/components/neu/NeuSwitch.vue';
import NeuTabs from '@/components/neu/NeuTabs.vue';
import OfflineCachePanel from '@/components/OfflineCachePanel.vue';
import ServerListEditor from '@/components/ServerListEditor.vue';
import { isAndroid } from '@/native/update.ts';
import {
  isBluetoothLyricsEnabled,
  isNativeAudio,
  setBluetoothLyricsEnabled,
} from '@/native/audio.ts';
import { useUiStore } from '@/stores/ui.ts';
import { useSessionStore } from '@/stores/session.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { useDislikesStore } from '@/stores/dislikes.ts';
import { useUpdateStore } from '@/stores/update.ts';
import { applyDedupe, previewDedupe, type DupGroup } from '@/offline/dedupe.ts';
import { applyBackup, buildBackup, downloadBackup } from '@/offline/backup.ts';
import { loadWebdav, saveWebdav, webdavGet, webdavPut } from '@/offline/webdav.ts';
import { directQQPlaylist } from '@/api/direct/playlist.ts';
import { fetchAiModels, fetchPersona, saveAiModels, tunePersona } from '@/api/ai.ts';
import { fetchBilibiliStatus } from '@/api/bilibili.ts';
import { fetchNeteaseStatus } from '@/api/netease.ts';
import type { AiSettingsConfigView, PersonaDetail } from '@/api/types.ts';

const ui = useUiStore();
const session = useSessionStore();
const favorites = useFavoritesStore();
const dislikes = useDislikesStore();
const update = useUpdateStore();

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
    const pl = await directQQPlaylist(raw);
    const added = await favorites.batchAdd(pl.tracks);
    importMsg.value = `${pl.name} · 新增 ${added} 首`;
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
async function runDedup(): Promise<void> {
  if (dupBusy.value || dupGroups.value.length === 0) return;
  dupBusy.value = true;
  try {
    const removed = await applyDedupe(dupGroups.value);
    dupGroups.value = [];
    dupMsg.value = `已清理 ${removed} 首`;
    await favorites.ensureLoaded();
  } catch (e) {
    dupMsg.value = e instanceof Error ? e.message : '清理失败';
  } finally {
    dupBusy.value = false;
  }
}

// ---------------------------------------------------------------- 备份
const backupBusy = ref(false);
const backupMsg = ref('');
const webdav = ref(loadWebdav());
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
    await favorites.ensureLoaded();
    await dislikes.ensureLoaded();
  } catch (e) {
    backupMsg.value = e instanceof Error ? e.message : '下载失败';
  } finally {
    backupBusy.value = false;
  }
}
const fileInput = ref<HTMLInputElement | null>(null);
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
    await favorites.ensureLoaded();
    await dislikes.ensureLoaded();
  } catch (e) {
    backupMsg.value = e instanceof Error ? e.message : '导入失败';
  } finally {
    backupBusy.value = false;
  }
}

// ---------------------------------------------------------------- 服务端 / 登录
const serverConfigured = computed(() => ui.baseUrl.trim().length > 0);
const TABS = computed(() => {
  const tabs = [{ value: 'local', label: '本机' }];
  if (serverConfigured.value) {
    tabs.push({ value: 'smart', label: '智能' }, { value: 'advanced', label: '高级' });
  }
  return tabs;
});
const activeTab = ref('local');

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
    const addr = loginAddr.value.trim().replace(/\/+$/, '');
    if (!addr) throw new Error('请填写服务端地址');
    if (addr !== ui.baseUrl) ui.setBaseUrl(addr);
    await session.login(loginUser.value, loginPass.value);
    loginPass.value = '';
    await loadServerData();
  } catch (e) {
    loginErr.value = e instanceof Error ? e.message : '登录失败';
  } finally {
    loginBusy.value = false;
  }
}
async function doLogout(): Promise<void> {
  await session.logout();
}

// ---------------------------------------------------------------- 智能
const persona = ref<PersonaDetail | null>(null);
const personaOpen = ref(false);
const guidance = ref('');
const tuning = ref(false);
const aiConfig = ref<AiSettingsConfigView | null>(null);
const assigning = ref(false);

async function loadPersona(): Promise<void> {
  try {
    persona.value = await fetchPersona();
  } catch {
    persona.value = null;
  }
}
async function loadAi(): Promise<void> {
  try {
    aiConfig.value = await fetchAiModels();
  } catch {
    aiConfig.value = null;
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
async function assign(task: 'decide' | 'review', id: string): Promise<void> {
  const cfg = aiConfig.value;
  if (!cfg || !id) return;
  assigning.value = true;
  try {
    const res = await saveAiModels({
      profiles: cfg.profiles.map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
      })),
      decideProfileId: task === 'decide' ? id : cfg.decideProfileId,
      reviewProfileId: task === 'review' ? id : cfg.reviewProfileId,
    });
    aiConfig.value = res.config;
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '保存失败');
  } finally {
    assigning.value = false;
  }
}

// ---------------------------------------------------------------- 音源 / 运行情况
const biliName = ref('');
const neteaseName = ref('');
const biliOn = ref(false);
const neteaseOn = ref(false);

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
    void loadAi();
  }
}

onMounted(() => {
  void dislikes.ensureLoaded();
  void favorites.ensureLoaded();
  void loadServerData();
});
</script>

<template>
  <div class="settings neu-container">
    <h1 class="page-title">设置</h1>

    <div v-if="serverConfigured" class="tabs-wrap">
      <NeuTabs v-model="activeTab" :items="TABS" />
    </div>

    <!-- ==================== 本机 ==================== -->
    <template v-if="!serverConfigured || activeTab === 'local'">
      <section v-if="isAndroid" class="sec">
        <h2 class="label">播放</h2>
        <div class="panel">
          <div class="row">
            <span class="row-name">蓝牙歌词</span>
            <NeuSwitch
              :model-value="btLyrics"
              aria-label="蓝牙歌词"
              @update:model-value="toggleBtLyrics"
            />
          </div>
        </div>
      </section>

      <section v-if="isNativeAudio" class="sec">
        <h2 class="label">缓存</h2>
        <OfflineCachePanel />
      </section>

      <section class="sec">
        <h2 class="label">黑名单</h2>
        <div class="panel">
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
          <div v-for="d in dislikeRows" :key="d.targetId" class="row">
            <span class="row-name ellipsis">{{ d.name || d.targetId }}</span>
            <NeuButton size="sm" variant="ghost" @click="undoDislike(prefTab, d.targetId)">
              恢复
            </NeuButton>
          </div>
          <div v-if="dislikeRows.length === 0" class="row empty">没有记录</div>
        </div>
      </section>

      <section class="sec">
        <h2 class="label">歌单导入</h2>
        <div class="panel pad">
          <NeuInput v-model="playlistLink" placeholder="QQ 歌单链接或 id" />
          <div class="actions">
            <NeuButton variant="primary" :loading="importing" @click="importPlaylist">导入</NeuButton>
            <span v-if="importMsg" class="hint">{{ importMsg }}</span>
          </div>
        </div>
      </section>

      <section class="sec">
        <h2 class="label">去重</h2>
        <div class="panel pad">
          <div class="actions">
            <NeuButton :loading="dupBusy" @click="previewDup">检查重复</NeuButton>
            <NeuButton
              v-if="dupGroups.length > 0"
              variant="primary"
              :loading="dupBusy"
              @click="runDedup"
            >
              清理 {{ dupGroups.reduce((n, g) => n + g.removeIds.length, 0) }} 首
            </NeuButton>
            <span v-if="dupMsg" class="hint">{{ dupMsg }}</span>
          </div>
        </div>
      </section>

      <section class="sec">
        <h2 class="label">数据备份</h2>
        <div class="panel pad">
          <input ref="fileInput" type="file" accept=".sm,.json" hidden @change="onBackupFile" />
          <div class="actions">
            <NeuButton :loading="backupBusy" @click="exportBackup">导出</NeuButton>
            <NeuButton :loading="backupBusy" @click="pickBackup">导入</NeuButton>
            <span v-if="backupMsg" class="hint">{{ backupMsg }}</span>
          </div>
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
            <NeuButton :loading="backupBusy" @click="downloadWebdav">下载</NeuButton>
          </div>
        </div>
      </section>

      <section v-if="isNativeAudio" class="sec">
        <h2 class="label">应用更新</h2>
        <div class="panel">
          <div class="row">
            <span class="row-name">
              {{ update.appVersion ? `v${update.appVersion.versionName}` : '—' }}
              <template v-if="update.latest">· 最新 v{{ update.latest.versionName }}</template>
            </span>
            <div class="actions">
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
        </div>
      </section>

      <section class="sec">
        <h2 class="label">主题</h2>
        <div class="panel">
          <div class="row">
            <span class="row-name">外观</span>
            <NeuTabs v-model="themeValue" :items="THEME_TABS" />
          </div>
        </div>
      </section>

      <section class="sec">
        <h2 class="label">账号</h2>
        <div v-if="!session.isLoggedIn" class="panel pad">
          <div class="field">
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
          <div class="actions">
            <NeuButton variant="primary" :loading="loginBusy" @click="doLogin">登入</NeuButton>
            <span v-if="loginErr" class="hint err">{{ loginErr }}</span>
          </div>
        </div>
        <div v-else class="panel">
          <div class="row">
            <span class="row-name">{{ session.displayName }}</span>
            <NeuButton size="sm" variant="danger" @click="doLogout">登出</NeuButton>
          </div>
        </div>
      </section>
    </template>

    <!-- ==================== 智能 ==================== -->
    <template v-else-if="activeTab === 'smart'">
      <section class="sec">
        <h2 class="label">画像</h2>
        <div class="panel">
          <button type="button" class="row row-btn" @click="personaOpen = !personaOpen">
            <span class="row-name">{{ persona?.summary ? '已生成' : '尚未生成' }}</span>
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

      <section class="sec">
        <h2 class="label">AI 分配</h2>
        <div class="panel pad">
          <div class="field">
            <span class="field-name">决策</span>
            <select
              class="select"
              :value="aiConfig?.decideProfileId ?? ''"
              :disabled="assigning"
              @change="assign('decide', ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="p in aiConfig?.profiles ?? []" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
          </div>
          <div class="field">
            <span class="field-name">复核</span>
            <select
              class="select"
              :value="aiConfig?.reviewProfileId ?? ''"
              :disabled="assigning"
              @change="assign('review', ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="p in aiConfig?.profiles ?? []" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
          </div>
        </div>
      </section>
    </template>

    <!-- ==================== 高级 ==================== -->
    <template v-else>
      <section class="sec">
        <h2 class="label">多服务端</h2>
        <ServerListEditor />
      </section>

      <section class="sec">
        <h2 class="label">音源授权</h2>
        <div class="panel">
          <div class="row">
            <span class="row-name">B 站</span>
            <span class="hint">{{ biliOn ? biliName || '已授权' : '未授权' }}</span>
          </div>
          <div class="row">
            <span class="row-name">网易云</span>
            <span class="hint">{{ neteaseOn ? neteaseName || '已授权' : '未授权' }}</span>
          </div>
        </div>
      </section>

      <section class="sec">
        <h2 class="label">运行情况</h2>
        <div class="panel">
          <div class="row">
            <span class="row-name">注册</span>
            <span class="hint">{{ session.authConfig?.registrationOpen ? '开放' : '关闭' }}</span>
          </div>
          <div class="row">
            <span class="row-name">已有账号</span>
            <span class="hint">{{ session.authConfig?.hasUsers ? '是' : '否' }}</span>
          </div>
          <div class="row">
            <span class="row-name">口令最短</span>
            <span class="hint">{{ session.authConfig?.passwordMinLength ?? '—' }}</span>
          </div>
        </div>
      </section>
    </template>
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
}
.row-name {
  font-size: var(--fs-md);
  color: var(--t1);
  min-width: 0;
}
.empty {
  color: var(--t2);
  font-size: var(--fs-sm);
}

.seg {
  display: flex;
  gap: var(--sp-4);
  padding: 0 var(--sp-4);
  border-bottom: 1px solid var(--line);
}
.seg-tab {
  position: relative;
  padding: 12px 0 10px;
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
  margin: var(--sp-1) 0;
}

.hint {
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
</style>
