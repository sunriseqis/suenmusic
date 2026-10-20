<script setup lang="ts">
/** 管理员：运行情况 + 数据库备份下载。 */
import { onMounted, ref } from 'vue';
import { http, ApiError } from '@/api/client.ts';
import { useUiStore } from '@/stores/ui.ts';

interface Health {
  version: string;
  uptimeSec: number;
  dbBytes: number;
  users: number;
}

const ui = useUiStore();
const health = ref<Health | null>(null);

// ---- 数据库恢复（覆盖式，高危）----
interface RestoreResult {
  ok: boolean;
  backupPath: string;
  users: number;
  tracks: number;
  schemaVersion: number | null;
}

const picked = ref<{ name: string; size: number } | null>(null);
const restoring = ref(false);
const restoreResult = ref<RestoreResult | null>(null);

function fmtSize(n: number): string {
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  restoreResult.value = null;
  picked.value = file ? { name: file.name, size: file.size } : null;
}

async function restore(): Promise<void> {
  const input = fileInput.value;
  const file = input?.files?.[0];
  if (!file) return;
  if (
    !window.confirm(
      `确定用「${file.name}」覆盖当前数据库？\n` +
        '当前全部数据会被替换（播放队列、登录态可能失效），\n' +
        '操作前会自动留一份兜底备份，但仍请谨慎。'
    )
  ) {
    return;
  }
  restoring.value = true;
  try {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? '');
        const comma = text.indexOf(',');
        resolve(comma >= 0 ? text.slice(comma + 1) : text);
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
    restoreResult.value = await http.post<RestoreResult>('/api/admin/db/restore', {
      dataBase64: base64,
    });
    ui.ok?.('数据库已恢复');
    await load();
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '恢复失败');
  } finally {
    restoring.value = false;
  }
}

const fileInput = ref<HTMLInputElement | null>(null);

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d} 天 ${h} 小时`;
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

async function load(): Promise<void> {
  try {
    health.value = await http.get<Health>('/api/admin/health');
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '读取运行情况失败');
  }
}

onMounted(load);
</script>

<template>
  <div class="maint">
    <div class="rows">
      <div class="row"><span>版本</span><b>{{ health?.version ?? '—' }}</b></div>
      <div class="row"><span>已运行</span><b>{{ health ? fmtUptime(health.uptimeSec) : '—' }}</b></div>
      <div class="row"><span>数据库</span><b>{{ health ? fmtBytes(health.dbBytes) : '—' }}</b></div>
      <div class="row"><span>账号</span><b>{{ health?.users ?? '—' }}</b></div>
    </div>
    <a class="download" href="/api/admin/backup" download>下载数据库备份</a>

    <div class="restore">
      <div class="restore-head">
        <span class="restore-title">恢复数据库</span>
        <span class="restore-hint">用此前的备份文件整体覆盖当前库</span>
      </div>
      <p class="warn">
        覆盖后当前全部数据被替换，播放队列与登录态可能失效；操作会自动留一份兜底备份。
      </p>
      <div class="restore-actions">
        <label class="pick">
          <input ref="fileInput" type="file" accept=".db,application/x-sqlite3" @change="onPick" />
          <span>选择 .db 文件</span>
        </label>
        <span v-if="picked" class="picked">{{ picked.name }} · {{ fmtSize(picked.size) }}</span>
        <button
          class="danger"
          type="button"
          :disabled="!picked || restoring"
          @click="restore"
        >
          {{ restoring ? '恢复中…' : '覆盖恢复' }}
        </button>
      </div>
      <div v-if="restoreResult" class="result">
        已恢复：{{ restoreResult.users }} 个账号 / {{ restoreResult.tracks }} 首曲目 /
        schema v{{ restoreResult.schemaVersion ?? '?' }}
        <div class="backup-path">兜底备份：{{ restoreResult.backupPath }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.maint {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.rows {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  padding: 0 var(--sp-4);
  font-size: var(--fs-sm);
}
.row + .row {
  border-top: 1px solid var(--line);
}
.row span {
  color: var(--t2);
}
.row b {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.restore {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line);
}
.restore-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}
.restore-title {
  font-size: var(--fs-sm);
  font-weight: 500;
}
.restore-hint {
  font-size: var(--fs-xs);
  color: var(--t2);
}
.warn {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--t2);
}
.restore-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.pick {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 34px;
  padding: 0 var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.pick input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.picked {
  font-size: var(--fs-xs);
  color: var(--t2);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.danger {
  display: inline-flex;
  align-items: center;
  height: 34px;
  padding: 0 var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: transparent;
  color: #c0573a;
  font-size: var(--fs-sm);
  cursor: pointer;
}
.danger:disabled {
  color: var(--t3);
  cursor: not-allowed;
}
.result {
  font-size: var(--fs-xs);
  line-height: 1.8;
  color: var(--t1);
}
.backup-path {
  color: var(--t2);
  word-break: break-all;
}
.download {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  height: 34px;
  padding: 0 var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
  color: var(--t1);
  font-size: var(--fs-sm);
  text-decoration: none;
}
</style>
