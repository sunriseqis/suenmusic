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
