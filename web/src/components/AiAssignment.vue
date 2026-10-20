<script setup lang="ts">
/**
 * AI 分配：决策 / 复核两个下拉。
 *
 * 按 2026-10-18 边界文档，客户端只做分配、不碰增删改——所以这个区块
 * 对任何登录用户、任何渠道开放；模型清单的增删改在 Web 面板的「AI 模型」
 * （原生壳看不到那块，接口层也有渠道闸）。
 *
 * 改动即存：下拉一改就打 PATCH，不设「保存」按钮——
 * 分配是二选一的操作，不该让用户记着还要点保存。
 */
import { onMounted, ref } from 'vue';
import { fetchAiAssignment, saveAiAssignment } from '@/api/ai.ts';
import { ApiError } from '@/api/client.ts';
import { useUiStore } from '@/stores/ui.ts';
import type { AiAssignmentView } from '@/api/types.ts';

const ui = useUiStore();
const view = ref<AiAssignmentView | null>(null);
const decide = ref('');
const review = ref('');
const saving = ref(false);

async function load(): Promise<void> {
  try {
    view.value = await fetchAiAssignment();
    decide.value = view.value.decideProfileId;
    review.value = view.value.reviewProfileId;
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '读取分配失败');
  }
}

async function change(which: 'decide' | 'review', id: string): Promise<void> {
  if (which === 'decide') decide.value = id;
  else review.value = id;
  if (saving.value) return;
  saving.value = true;
  try {
    const res = await saveAiAssignment(decide.value, review.value);
    view.value = res.assignment;
    ui.ok('已保存');
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '保存失败');
    await load();
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="assign">
    <div class="row">
      <span class="row-name">决策</span>
      <span v-if="!view || view.profiles.length === 0" class="row-val">尚未配置模型</span>
      <select
        v-else
        class="select"
        :value="decide"
        :disabled="saving"
        @change="change('decide', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="p in view.profiles" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
      </select>
    </div>
    <div class="row">
      <span class="row-name">复核</span>
      <span v-if="!view || view.profiles.length === 0" class="row-val">尚未配置模型</span>
      <select
        v-else
        class="select"
        :value="review"
        :disabled="saving"
        @change="change('review', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="p in view.profiles" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
.assign {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  min-height: 44px;
  /* 与全站行节奏一致：没有内边距时文字会贴着面板边框（真机截图问题） */
  padding: 0 var(--sp-4);
  min-width: 0;
}
.row + .row {
  border-top: 1px solid var(--line);
}
.row-name {
  /* 不伸缩：标签就那几个字，长出来的是下拉 */
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--fs-sm);
}
.row-val {
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--t2);
}
.select {
  /*
   * 关键：flex 0 1 auto + max-width + min-width 0。
   * 之前是 flex:none + width:180 —— 原生 <select> 在安卓 WebView 里
   * 不收缩，窄容器下直接顶破面板右边界（真机截图验证过）。
   */
  flex: 0 1 auto;
  width: 180px;
  max-width: 60%;
  min-width: 0;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--panel-2);
  color: var(--t1);
  padding: 0 8px;
  font-size: var(--fs-sm);
  font-family: inherit;
  text-align: left;
}
</style>
