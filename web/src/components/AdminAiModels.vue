<script setup lang="ts">
/**
 * 管理员：AI 模型增删改（Web 面板专属）。
 *
 * 决策/复核分配不在这里——按边界文档客户端只做分配，挪到了
 * AiAssignment.vue（任何登录用户、任何渠道都可见）。
 * 保存时不再提交分配字段：服务端会保留当前指派，删模型导致的
 * 失效指派由服务端归一化到第一个模型。
 *
 * API Key 只显示掩码；编辑时留空表示沿用原值（服务端按 id 合并）。
 */
import { onMounted, ref } from 'vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import { http, ApiError } from '@/api/client.ts';
import { fetchAiModels, saveAiModels } from '@/api/ai.ts';
import { useUiStore } from '@/stores/ui.ts';
import type { AiSettingsConfigView } from '@/api/types.ts';

interface DraftProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
}

const ui = useUiStore();
const rows = ref<DraftProfile[]>([]);
const busy = ref(false);
const testing = ref<number | null>(null);

async function load(): Promise<void> {
  try {
    const cfg: AiSettingsConfigView = await fetchAiModels();
    rows.value = cfg.profiles.map(p => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: '',
      apiKeyMasked: p.apiKeyMasked,
      hasApiKey: p.hasApiKey,
    }));
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '读取模型失败');
  }
}

function addRow(): void {
  rows.value.push({
    id: '',
    name: '',
    baseUrl: '',
    model: '',
    apiKey: '',
    apiKeyMasked: '',
    hasApiKey: false,
  });
}

function removeRow(i: number): void {
  rows.value.splice(i, 1);
}

async function testRow(i: number): Promise<void> {
  const p = rows.value[i];
  if (!p) return;
  testing.value = i;
  try {
    const res = await http.post<{ ok: boolean; latencyMs: number }>('/api/ai/models/test', {
      id: p.id,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
    });
    ui.ok(`连接正常 · ${res.latencyMs}ms`);
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '连接失败');
  } finally {
    testing.value = null;
  }
}

async function save(): Promise<void> {
  busy.value = true;
  try {
    const res = await saveAiModels({
      profiles: rows.value.map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        // 空串 = 沿用原 key；新模型必须填
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      })),
    });
    rows.value = res.config.profiles.map(p => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: '',
      apiKeyMasked: p.apiKeyMasked,
      hasApiKey: p.hasApiKey,
    }));
    ui.ok('已保存');
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="ai">
    <div v-for="(p, i) in rows" :key="p.id || i" class="item">
      <div class="grid">
        <NeuInput v-model="p.name" placeholder="名称" />
        <NeuInput v-model="p.model" placeholder="模型" />
        <NeuInput v-model="p.baseUrl" placeholder="Base URL" />
        <NeuInput
          v-model="p.apiKey"
          type="password"
          :placeholder="p.hasApiKey ? p.apiKeyMasked : 'API Key'"
        />
      </div>
      <div class="ops">
        <button type="button" class="link" :disabled="testing === i" @click="testRow(i)">
          {{ testing === i ? '测试中…' : '测试' }}
        </button>
        <button type="button" class="link danger" @click="removeRow(i)">删除</button>
      </div>
    </div>

    <button type="button" class="add" @click="addRow">+ 添加模型</button>

    <NeuButton variant="primary" :loading="busy" @click="save">保存配置</NeuButton>
  </div>
</template>

<style scoped>
.ai {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.item {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--sp-2);
}
.ops {
  display: flex;
  gap: var(--sp-4);
  justify-content: flex-end;
}
.link {
  border: 0;
  background: transparent;
  color: var(--accent-text);
  font-size: var(--fs-xs);
  cursor: pointer;
}
.link.danger {
  color: #c4554a;
}
.add {
  align-self: flex-start;
  height: 32px;
  padding: 0 var(--sp-3);
  border: 1px dashed var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--t2);
  font-size: var(--fs-xs);
  cursor: pointer;
}
</style>
