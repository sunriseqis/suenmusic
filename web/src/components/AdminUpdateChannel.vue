<script setup lang="ts">
/**
 * 管理员：更新通道设置（GitHub 源 + 下载代理）。
 *
 * 后端：`GET/PATCH /api/admin/update-settings`（只认 Web cookie 会话，与其它管理操作同一渠道闸）。
 * 字段与 `server/src/services/update-settings.ts` 的 `UpdateProxySettings` 一一对应：
 *   source        github | off
 *   downloadProxy 产物下载代理前缀（拼在 browser_download_url 前）；空 = 直连
 *   apiBase       GitHub API 反代基地址；空 = 官方 api.github.com
 *
 * ⚠️ 两个代理**不能互相替代**：API_BASE 管 `/repos/.../releases` 的 JSON 请求，
 *    PROXY 管 `.hap/.ipa/.apk` 二进制下载。用文件代理前缀去套 JSON API 通常会失败。
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
}

const ui = useUiStore();
const loading = ref(true);
const saving = ref(false);
const source = ref<'github' | 'off'>('github');
const proxyKind = ref<'none' | 'http'>('none');
const proxyUrl = ref('');


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
    takeSnapshot(s);
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '读取更新通道设置失败');
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const s = await http.patch<UpdateSettings>('/api/admin/update-settings', {
      source: source.value,
      proxyKind: proxyKind.value,
      proxyUrl: proxyUrl.value.trim(),
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
        <span class="row-name">检查更新</span>
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
      <p class="hint">服务端定时从 GitHub Releases 拉取新版本到本地，客户端从这里下载。</p>

      <div class="field">
        <label class="f-label" for="updch-proxy">出站代理</label>
        <NeuInput
          id="updch-proxy"
          v-model="proxyUrl"
          placeholder="http://127.0.0.1:7890（留空 = 直连）"
        />
        <p class="f-hint">填写后，GitHub 的检查与下载都经由该 HTTP 代理；清空保存即恢复直连。</p>
      </div>

      <div class="actions">
        <NeuButton variant="primary" size="sm" :loading="saving" :disabled="!dirty()" @click="save">
          {{ saving ? '保存中…' : '保存设置' }}
        </NeuButton>
        <NeuButton v-if="dirty()" size="sm" variant="ghost" :disabled="saving" @click="load">
          放弃更改
        </NeuButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.updch { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; align-items: center; gap: 12px; min-height: 32px; }
.row-name { width: 96px; flex: none; font-size: 13px; color: var(--t2); }
.switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.switch-ui {
  width: 36px; height: 20px; border-radius: 10px;
  background: var(--track); position: relative; transition: background 0.2s ease;
  flex: none;
}
.switch-ui::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--panel); transition: transform 0.2s ease;
  box-shadow: 0 1px 3px var(--sd);
}
.switch input:checked + .switch-ui { background: var(--accent); }
.switch input:checked + .switch-ui::after { transform: translateX(16px); }
.switch input:focus-visible + .switch-ui { outline: 2px solid var(--accent); outline-offset: 2px; }
.switch-label { font-size: 13px; color: var(--t1); }
.hint { margin: 0; font-size: 12px; color: var(--t2); line-height: 1.5; }
.field { display: flex; flex-direction: column; gap: 6px; }
.f-label { font-size: 12px; color: var(--t2); }
.f-hint { margin: 0; font-size: 11px; color: var(--t2); line-height: 1.5; }
.f-hint code { font-size: 11px; padding: 0 4px; background: var(--panel-2); border-radius: 4px; }
.actions { display: flex; gap: 8px; align-items: center; }
b { color: var(--accent-text); }
</style>
