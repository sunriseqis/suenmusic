<script setup lang="ts">
/**
 * 管理员：运维日志。三 tab（服务器 / Cookie 账号 / AI 工作结果），
 * 级别 / 时间范围 / 关键字筛选，每页 50 条分页，点击展开 detail。
 * 契约见 server/src/routes/ops-log.ts。
 */
import { computed, onMounted, ref, watch } from 'vue';
import NeuTabs from '@/components/neu/NeuTabs.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import { fetchOpsLogs, fetchOpsLogFacets, type OpsLogItem, type OpsLevel } from '@/api/ops-log.ts';

const PAGE_SIZE = 50;

const tabs = ref([
  { value: 'server', label: '服务器' },
  { value: 'cookie', label: 'Cookie 账号' },
  { value: 'ai', label: 'AI 工作结果' },
]);
const dimension = ref('server');
const level = ref<'' | OpsLevel>('');
const range = ref<'' | 'today' | '3d' | '7d'>('');
const keyword = ref('');
const page = ref(0);
const items = ref<OpsLogItem[]>([]);
const total = ref(0);
const loading = ref(false);
const failed = ref(false);
const expandedId = ref<number | null>(null);
const expandedJson = ref<string | null>(null);
const searchSeq = ref(0);

const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

function rangeStart(): number | undefined {
  const now = Date.now();
  if (range.value === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range.value === '3d') return now - 3 * 86400_000;
  if (range.value === '7d') return now - 7 * 86400_000;
  return undefined;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function load(): Promise<void> {
  loading.value = true;
  failed.value = false;
  try {
    const res = await fetchOpsLogs({
      dimension: dimension.value as 'server' | 'cookie' | 'ai',
      level: level.value || undefined,
      from: rangeStart(),
      q: keyword.value.trim() || undefined,
      limit: PAGE_SIZE,
      offset: page.value * PAGE_SIZE,
    });
    items.value = res.items;
    total.value = res.total;
    expandedId.value = null;
    expandedJson.value = null;
  } catch {
    items.value = [];
    total.value = 0;
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

async function loadFacets(): Promise<void> {
  const facets = await fetchOpsLogFacets();
  if (!facets) return;
  const c = facets.counts;
  tabs.value = tabs.value.map((t, i) => ({ ...t, count: [c.server, c.cookie, c.ai][i] }));
}

function toggleExpand(item: OpsLogItem): void {
  if (expandedId.value === item.id) {
    expandedId.value = null;
    expandedJson.value = null;
    return;
  }
  expandedId.value = item.id;
  try {
    expandedJson.value = item.detail ? JSON.stringify(JSON.parse(item.detail), null, 2) : item.detail ?? '';
  } catch {
    expandedJson.value = item.detail ?? '';
  }
}

watch([dimension, level, range], () => {
  page.value = 0;
  void load();
});

let searchTimer: number | undefined;
watch(keyword, () => {
  const seq = ++searchSeq.value;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    if (seq !== searchSeq.value) return;
    page.value = 0;
    void load();
  }, 300);
});

onMounted(() => {
  void load();
  void loadFacets();
});
</script>

<template>
  <div class="ops">
    <NeuTabs v-model="dimension" :items="tabs" block />

    <div class="filters">
      <select v-model="level" class="sel">
        <option value="">全部级别</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
      <select v-model="range" class="sel">
        <option value="">全部时间</option>
        <option value="today">今天</option>
        <option value="3d">近 3 天</option>
        <option value="7d">近 7 天</option>
      </select>
      <NeuInput v-model="keyword" type="search" placeholder="搜索摘要" class="kw" />
    </div>

    <div v-if="failed" class="state">读取失败，请稍后重试</div>
    <div v-else-if="loading && items.length === 0" class="state">加载中…</div>
    <div v-else-if="items.length === 0" class="state">暂无日志</div>

    <div v-else class="list">
      <div v-for="item in items" :key="item.id" class="item" :class="'lv-' + item.level">
        <button type="button" class="head" @click="toggleExpand(item)">
          <span class="lv">{{ item.level }}</span>
          <span class="time">{{ fmtTime(item.ts) }}</span>
          <span class="summary">{{ item.summary }}</span>
        </button>
        <pre v-if="expandedId === item.id" class="detail">{{ expandedJson || '（无 detail）' }}</pre>
      </div>
    </div>

    <div v-if="pages > 1" class="pager">
      <button type="button" class="pg" :disabled="page === 0 || loading" @click="page--; load()">上一页</button>
      <span class="pginfo">{{ page + 1 }} / {{ pages }}</span>
      <button type="button" class="pg" :disabled="page >= pages - 1 || loading" @click="page++; load()">下一页</button>
    </div>
  </div>
</template>

<style scoped>
.ops {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.filters {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
}
.sel {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
  color: var(--t1);
  font-size: var(--fs-sm);
  min-height: 36px;
  padding: 0 var(--sp-2);
}
.kw {
  flex: 1 1 auto;
  min-width: 0;
}
.state {
  padding: var(--sp-5) 0;
  text-align: center;
  color: var(--t2);
  font-size: var(--fs-sm);
}
.list {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
}
.item + .item {
  border-top: 1px solid var(--line);
}
.head {
  display: flex;
  width: 100%;
  align-items: center;
  gap: var(--sp-3);
  min-height: 44px;
  padding: var(--sp-2) var(--sp-4);
  border: 0;
  background: transparent;
  color: var(--t1);
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
}
.lv {
  flex: none;
  font-size: var(--fs-xs);
  padding: 1px var(--sp-2);
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--t2);
}
.lv-warn .lv,
.lv-warn .summary {
  color: var(--warn-text, #b45309);
}
.lv-error .lv,
.lv-error .summary {
  color: var(--danger-text, #b91c1c);
}
.time {
  flex: none;
  color: var(--t2);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}
.summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail {
  margin: 0;
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--line);
  background: var(--panel-2);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--fs-xs);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow: auto;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
}
.pg {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--t1);
  font-size: var(--fs-sm);
  min-height: 32px;
  padding: 0 var(--sp-3);
  cursor: pointer;
}
.pg:disabled {
  opacity: 0.5;
  cursor: default;
}
.pginfo {
  color: var(--t2);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}
</style>
