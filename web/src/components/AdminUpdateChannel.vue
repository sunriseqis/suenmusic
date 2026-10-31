<script setup lang="ts">
/**
 * 管理员：更新通道设置（GitHub 源 + 出站代理）。
 *
 * 后端：`GET/PATCH /api/admin/update-settings`（只认 Web cookie 会话，与其它管理操作同一渠道闸）。
 * 区分部署方式：
 *   - 飞牛原生套件（fnos）：服务端缓存最新 .fpk，提供一键下载与覆盖安装指引；
 *   - Docker 容器（docker）：仅检测并提示新版本，引导用户更新镜像，不拉取 .fpk。
 */
import { onMounted, ref } from 'vue';
import { http, ApiError } from '@/api/client.ts';
import { useUiStore } from '@/stores/ui.ts';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuInput from '@/components/neu/NeuInput.vue';

interface UpdateSettings {
  source: 'github' | 'off';
  /** none 直连（proxyUrl 空）/ http 出站代理 */
  proxyKind: 'none' | 'http';
  /** 代理地址，如 http://127.0.0.1:7890（可含凭据） */
  proxyUrl: string;
  currentVersion?: string;
  deployMode?: 'fnos' | 'docker';
}

interface ServerUpdateReply {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  deployMode: 'fnos' | 'docker';
  artifact: {
    fileName: string;
    size: number;
    downloadToken: string;
    downloadPath: string;
  } | null;
}

const ui = useUiStore();
const loading = ref(true);
const saving = ref(false);
const source = ref<'github' | 'off'>('github');
const proxyKind = ref<'none' | 'http'>('none');
const proxyUrl = ref('');
const currentVersion = ref('2.0.0');
const deployMode = ref<'fnos' | 'docker'>('docker');
const checking = ref(false);
const updResult = ref<ServerUpdateReply | null>(null);

function dirty(): boolean {
  return (
    source.value !== snapshotSource ||
    proxyKind.value !== snapshotKind ||
    proxyUrl.value.trim() !== snapshotUrl
  );
}
let snapshotSource: 'github' | 'off' = 'github';
let snapshotKind: 'none' | 'http' = 'none';
let snapshotUrl = '';

function takeSnapshot(s: UpdateSettings): void {
  snapshotSource = s.source;
  snapshotKind = s.proxyKind;
  snapshotUrl = s.proxyUrl;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const s = await http.get<UpdateSettings>('/api/admin/update-settings');
    source.value = s.source;
    proxyKind.value = s.proxyKind;
    proxyUrl.value = s.proxyUrl;
    if (s.currentVersion) currentVersion.value = s.currentVersion;
    if (s.deployMode) deployMode.value = s.deployMode;
    takeSnapshot(s);
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '读取更新通道设置失败');
  } finally {
    loading.value = false;
  }
}

async function checkServerUpdate(): Promise<void> {
  checking.value = true;
  updResult.value = null;
  try {
    let res: ServerUpdateReply;
    try {
      res = await http.get<ServerUpdateReply>('/api/admin/server-update?force=1');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // 兼容老版本服务端（未暴露 /api/admin/server-update）
        const q = `?platform=fnos&version_name=${encodeURIComponent(currentVersion.value)}&version_code=0&force=1`;
        const legacy = await http.get<{
          available: boolean;
          latest: { versionName: string; size: number; fileName: string } | null;
          downloadToken: string | null;
          downloadPath: string | null;
        }>(`/api/update/check${q}`);
        res = {
          available: legacy.available,
          currentVersion: currentVersion.value,
          latestVersion: legacy.latest?.versionName || currentVersion.value,
          deployMode: deployMode.value,
          artifact: legacy.available && legacy.latest ? {
            fileName: legacy.latest.fileName,
            size: legacy.latest.size,
            downloadToken: legacy.downloadToken || '',
            downloadPath: legacy.downloadPath || '/api/update/download',
          } : null,
        };
      } else {
        throw err;
      }
    }
    updResult.value = res;
    if (res.deployMode) deployMode.value = res.deployMode;
    if (res.available) {
      ui.ok?.(`发现新版本 v${res.latestVersion}`);
    } else {
      ui.ok?.('当前已是最新版本');
    }
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '检查更新失败');
  } finally {
    checking.value = false;
  }
}

function downloadFnPackage(): void {
  if (!updResult.value?.artifact?.downloadToken) return;
  const token = updResult.value.artifact.downloadToken;
  const path = updResult.value.artifact.downloadPath || '/api/update/download';
  // 带上真实文件名：外部下载工具按 URL 后缀识别包类型
  const name = (updResult.value?.artifact?.fileName ?? '').trim();
  const filePart = name ? '/' + encodeURIComponent(name) : '';
  const url = `${path}${filePart}?platform=fnos&token=${encodeURIComponent(token)}`;
  window.open(url, '_blank');
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const trimmedUrl = proxyUrl.value.trim();
    const kind = trimmedUrl ? 'http' : 'none';
    const s = await http.patch<UpdateSettings>('/api/admin/update-settings', {
      source: source.value,
      proxyKind: kind,
      proxyUrl: trimmedUrl,
    });
    source.value = s.source;
    proxyKind.value = s.proxyKind;
    proxyUrl.value = s.proxyUrl;
    takeSnapshot(s);
    ui.ok?.('更新通道设置已保存');
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="updch">
    <div v-if="loading" class="hint">读取中…</div>
    <template v-else>
      <div class="row">
        <span class="row-name">当前版本</span>
        <div class="version-row">
          <span class="version-tag">v{{ currentVersion }}</span>
          <span class="mode-tag">{{ deployMode === 'fnos' ? '飞牛套件' : 'Docker 容器' }}</span>
          <NeuButton
            v-if="source === 'github'"
            size="sm"
            :loading="checking"
            @click="checkServerUpdate"
          >
            {{ checking ? '检查中…' : '检查更新' }}
          </NeuButton>
        </div>
      </div>

      <!-- 更新结果提示区 -->
      <div v-if="updResult" class="upd-card">
        <template v-if="updResult.available">
          <div class="upd-head">
            <span class="badge">发现新版本</span>
            <span class="new-ver">v{{ updResult.latestVersion }}</span>
            <span v-if="updResult.artifact?.size" class="pkg-size">
              ({{ (updResult.artifact.size / 1024 / 1024).toFixed(1) }} MB)
            </span>
          </div>

          <!-- 飞牛套件模式：提供直接下载与平滑覆盖安装指引 -->
          <template v-if="updResult.deployMode === 'fnos'">
            <p class="upd-desc">飞牛私有云（fnOS）原生套件安装包已在服务端缓存就绪，可直接下载。</p>
            <div v-if="updResult.artifact" class="upd-btn-row">
              <NeuButton
                variant="primary"
                size="sm"
                @click="downloadFnPackage"
              >
                下载飞牛套件更新包 (.fpk)
              </NeuButton>
            </div>
            <p class="f-hint">
              💡 升级方法：下载安装包后，在飞牛桌面打开「应用中心」并点击右上角「手动安装」，上传新安装包覆盖即可平滑升级。
            </p>
          </template>

          <!-- Docker 模式：仅提示更新，引导用户自行拉取最新镜像 -->
          <template v-else>
            <p class="upd-desc">当前运行于 Docker 容器环境。服务端检测到新版本镜像已发布，请更新 Docker 镜像完成升级。</p>
            <div class="cmd-box">
              <code>docker compose pull &amp;&amp; docker compose up -d</code>
            </div>
            <p class="f-hint">
              💡 升级提示：若通过群晖 Container Manager、飞牛 Docker 或 1Panel 等面板管理，在容器列表中对 suenmusic 执行「拉取最新镜像」并重启容器即可。
            </p>
          </template>
        </template>
        <template v-else>
          <div class="upd-latest">✔ 当前已是最新版本 (v{{ currentVersion }})</div>
        </template>
      </div>

      <div class="row">
        <span class="row-name">更新通道</span>
        <label class="switch">
          <input
            type="checkbox"
            :checked="source === 'github'"
            @change="source = ($event.target as HTMLInputElement).checked ? 'github' : 'off'"
          />
          <span class="switch-ui" aria-hidden="true"></span>
          <span class="switch-label">{{ source === 'github' ? '开启' : '关闭' }}</span>
        </label>
      </div>
      <p class="hint">开启后，服务端定时从 GitHub Releases 自动拉取全端最新构建到本地缓存，客户端与套件更新免去 GitHub 访问限制。</p>

      <div class="field">
        <label class="f-label" for="updch-proxy">出站代理</label>
        <NeuInput
          id="updch-proxy"
          v-model="proxyUrl"
          placeholder="http://127.0.0.1:7890（留空 = 直连）"
        />
        <p class="f-hint">
          仅在服务端无法直连 GitHub 时填写。支持标准 HTTP 代理（可带认证凭据，如 <code>http://user:pass@192.168.1.1:7890</code>）。
        </p>
      </div>

      <div class="actions">
        <NeuButton
          variant="primary"
          :disabled="!dirty() || saving"
          :loading="saving"
          @click="save"
        >
          保存设置
        </NeuButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.updch { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; align-items: center; gap: 12px; min-height: 32px; }
.row-name { width: 96px; flex: none; font-size: 13px; color: var(--t2); }
.version-row { display: flex; align-items: center; gap: 12px; }
.version-tag { font-size: 13px; font-weight: 600; color: var(--t1); font-family: var(--font-mono, monospace); }
.mode-tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--panel-2, rgba(0, 0, 0, 0.05));
  color: var(--t2);
  border: 1px solid var(--line, rgba(0, 0, 0, 0.08));
}
.switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.switch-ui {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--line);
  transition: background 0.2s;
}
.switch-ui::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}
.switch input:checked + .switch-ui {
  background: var(--accent);
}
.switch input:checked + .switch-ui::after {
  transform: translateX(16px);
}
.switch-label { font-size: 12px; color: var(--t2); }
.hint { margin: 0; font-size: 11px; color: var(--t3); line-height: 1.5; }
.field { display: flex; flex-direction: column; gap: 6px; }
.f-label { font-size: 12px; color: var(--t2); }
.f-hint { margin: 0; font-size: 11px; color: var(--t2); line-height: 1.5; }
.f-hint code { font-size: 11px; padding: 0 4px; background: var(--panel-2); border-radius: 4px; }
.actions { display: flex; gap: 8px; align-items: center; }

/* 更新卡片样式 */
.upd-card {
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--panel-2, rgba(0, 0, 0, 0.04));
  border: 1px solid var(--line, rgba(0, 0, 0, 0.08));
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.upd-head { display: flex; align-items: center; gap: 8px; }
.badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-weight: 500;
}
.new-ver { font-size: 13px; font-weight: 600; color: var(--t1); font-family: var(--font-mono, monospace); }
.pkg-size { font-size: 12px; color: var(--t2); }
.upd-desc { margin: 0; font-size: 12px; color: var(--t1); line-height: 1.4; }
.upd-btn-row { margin-top: 4px; display: flex; }
.cmd-box {
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--panel, #f3f4f6);
  border: 1px solid var(--line, rgba(0, 0, 0, 0.08));
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--t1);
  user-select: all;
  display: inline-block;
  align-self: flex-start;
}
.upd-latest { margin: 0; font-size: 12px; color: var(--accent, #10b981); font-weight: 500; }
</style>
