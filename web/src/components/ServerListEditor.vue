<script setup lang="ts">
/**
 * 多路径服务端列表编辑器（设置页与登录页共用）。
 *
 * 交互约定：
 *   - **顺序即优先级**（第 1 条是首选）：内网 → 反代 → FRP → 隧道
 *   - 保存后立即按优先级选路（`selectBestServer`），并逐条探测回显可达状态
 *   - 「测试」只探测不改动；顶部会标出**当前生效**的那条
 *   - 空地址条目在保存时被过滤（见 servers.ts 的 sanitize）
 */
import { onMounted, ref } from 'vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuIconButton from '@/components/neu/NeuIconButton.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import { getBaseUrl } from '@/api/client.ts';
import {
  getServerList,
  probeAll,
  selectBestServer,
  setServerList,
  type ServerCandidate,
} from '@/api/servers.ts';
import { useSessionStore } from '@/stores/session.ts';
import { useUiStore } from '@/stores/ui.ts';

const ui = useUiStore();
const session = useSessionStore();

const draft = ref<ServerCandidate[]>([]);
const active = ref(getBaseUrl());
const status = ref<Array<boolean | undefined>>([]);
const probing = ref(false);

function load(): void {
  draft.value = getServerList().map(c => ({ ...c }));
  active.value = getBaseUrl();
  status.value = draft.value.map(() => undefined);
}

onMounted(load);

function add(): void {
  draft.value.push({ label: '', url: '' });
  status.value.push(undefined);
}

function remove(i: number): void {
  draft.value.splice(i, 1);
  status.value.splice(i, 1);
}

function move(i: number, dir: -1 | 1): void {
  const j = i + dir;
  if (j < 0 || j >= draft.value.length) return;
  const a = draft.value[i];
  const b = draft.value[j];
  if (!a || !b) return;
  draft.value[i] = b;
  draft.value[j] = a;
  const sa = status.value[i];
  status.value[i] = status.value[j];
  status.value[j] = sa;
}

async function save(): Promise<void> {
  setServerList(draft.value);
  load();
  await selectBestServer();
  active.value = getBaseUrl();
  void session.loadAuthConfig();
  ui.ok('服务器列表已保存');
  await testAll();
}

async function testAll(): Promise<void> {
  if (probing.value) return;
  probing.value = true;
  // 先落盘再探测，保证测的就是将要使用的那份
  setServerList(draft.value);
  const list = getServerList();
  const results = await probeAll();
  status.value = list.map((_, i) => results[i]?.ok);
  active.value = getBaseUrl();
  probing.value = false;
}
</script>

<template>
  <div class="srv-editor" data-role="server-editor">
    <p class="neu-t2 srv-hint">
      顺序即优先级：第 1 条是首选（建议内网），失败时自动往下切。当前生效：
      <code>{{ active || '（同源）' }}</code>
    </p>

    <div v-for="(item, i) in draft" :key="i" class="srv-row">
      <span class="srv-prio neu-num" :title="`优先级 ${i + 1}`">{{ i + 1 }}</span>

      <div class="srv-input">
        <NeuInput v-model="item.url" placeholder="http://192.168.1.10:3210" />
      </div>

      <span
        class="srv-dot"
        :class="{
          ok: status[i] === true,
          bad: status[i] === false,
          unknown: status[i] === undefined,
        }"
        :title="
          status[i] === true ? '可达' : status[i] === false ? '不可达' : '未测试'
        "
        aria-hidden="true"
      />

      <div class="srv-ops">
        <NeuIconButton
          icon="chevron-up"
          label="上移（提高优先级）"
          size="sm"
          :disabled="i === 0"
          @click="move(i, -1)"
        />
        <NeuIconButton
          icon="chevron-down"
          label="下移（降低优先级）"
          size="sm"
          :disabled="i === draft.length - 1"
          @click="move(i, 1)"
        />
        <NeuIconButton
          icon="trash"
          label="删除这条"
          size="sm"
          :disabled="draft.length <= 1"
          @click="remove(i)"
        />
      </div>
    </div>

    <p v-if="draft.length === 0" class="neu-t2 srv-hint">
      还没有配置服务器地址。浏览器同源部署时可留空（前端与 API 同域）。
    </p>

    <div class="srv-actions">
      <NeuButton variant="ghost" @click="add">
        <span class="srv-add">＋ 添加服务器</span>
      </NeuButton>
      <NeuButton variant="ghost" :loading="probing" @click="testAll">测试连通性</NeuButton>
      <NeuButton variant="primary" @click="save">保存并选路</NeuButton>
    </div>
  </div>
</template>

<style scoped>
.srv-editor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.srv-hint {
  font-size: var(--fs-sm);
  margin: 0;
}
.srv-hint code {
  font-size: var(--fs-xs);
}
.srv-row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
}
.srv-prio {
  flex: none;
  width: 18px;
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--t2);
  padding-bottom: 12px;
}
.srv-input {
  flex: 1 1 auto;
  min-width: 0;
}
.srv-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-bottom: 16px;
}
.srv-dot.ok {
  background: var(--ok, #3a9d5d);
}
.srv-dot.bad {
  background: var(--danger, #c0392b);
}
.srv-dot.unknown {
  background: var(--track, #cbd2da);
}
.srv-ops {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-bottom: 6px;
}
.srv-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  align-items: center;
}
.srv-add {
  white-space: nowrap;
}
</style>
