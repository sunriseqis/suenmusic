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

// ---------------------------------------------------------------- 手势
/**
 * 两种手势：
 *  - 行上横滑：**右滑**露出「删除」，松手超过阈值即删除
 *  - 序号上竖拖：拖动改优先级
 *
 * 页面的纵向滚动不能被吃掉，所以行本身是 `touch-action: pan-y`，
 * 只有序号把手是 `touch-action: none`。
 */
type PressMode = 'swipe' | 'drag';
const listEl = ref<HTMLElement | null>(null);
const dragIndex = ref<number | null>(null);
const swipe = ref<{ i: number; dx: number } | null>(null);
let press: { i: number; x: number; y: number; mode: PressMode; axis: 'x' | 'y' | null } | null =
  null;

function startSwipe(i: number, e: PointerEvent): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  press = { i, x: e.clientX, y: e.clientY, mode: 'swipe', axis: null };
}
function startDrag(i: number, e: PointerEvent): void {
  e.stopPropagation();
  press = { i, x: e.clientX, y: e.clientY, mode: 'drag', axis: null };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onMove(e: PointerEvent): void {
  if (!press) return;
  const dx = e.clientX - press.x;
  const dy = e.clientY - press.y;

  if (press.mode === 'swipe') {
    if (!press.axis) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) press.axis = 'x';
      else if (Math.abs(dy) > 10) return; // 交给页面滚动
      else return;
    }
    swipe.value = { i: press.i, dx: Math.max(0, Math.min(88, dx)) };
    return;
  }

  // 拖动排序：按指针所在的半区计算目标位置
  dragIndex.value = press.i;
  const list = listEl.value;
  if (!list) return;
  const rows = [...list.querySelectorAll<HTMLElement>('.srv-row')];
  const target = rows.findIndex(r => {
    const b = r.getBoundingClientRect();
    return e.clientY < b.top + b.height / 2;
  });
  const to = target === -1 ? rows.length - 1 : target;
  const from = press.i;
  if (to !== from) {
    const [item] = draft.value.splice(from, 1);
    const [st] = status.value.splice(from, 1);
    if (!item) return;
    draft.value.splice(to, 0, item);
    status.value.splice(to, 0, st);
    press.i = to;
    dragIndex.value = to;
  }
}
function onUp(): void {
  if (swipe.value && swipe.value.dx > 56 && draft.value.length > 1) {
    remove(swipe.value.i);
  }
  swipe.value = null;
  dragIndex.value = null;
  press = null;
}
function rowStyle(i: number): Record<string, string> | undefined {
  if (swipe.value?.i !== i) return undefined;
  return { transform: `translateX(${swipe.value.dx}px)` };
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

    <div ref="listEl" class="srv-list">
    <div v-for="(item, i) in draft" :key="i" class="srv-wrap">
      <div class="srv-swipe" aria-hidden="true">删除</div>
      <div
        class="srv-row"
        :class="{ dragging: dragIndex === i }"
        :style="rowStyle(i)"
        @pointerdown="startSwipe(i, $event)"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
      <span
        class="srv-prio neu-num"
        :title="`优先级 ${i + 1}（拖动排序）`"
        @pointerdown="startDrag(i, $event)"
      >{{ i + 1 }}</span>

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

      </div>
    </div>
    </div>

    <div class="srv-actions">
      <NeuButton @click="add">添加服务器</NeuButton>
      <NeuButton :loading="probing" @click="testAll">测试连通性</NeuButton>
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
.srv-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
  box-shadow: inset 0 1px 0 var(--hi);
  overflow: hidden;
}

/* 行与右滑删除层叠在一起：行在上，删除在下面 */
.srv-wrap {
  position: relative;
  overflow: hidden;
}
.srv-wrap + .srv-wrap {
  border-top: 1px solid var(--line);
}
.srv-swipe {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-left: var(--sp-4);
  background: color-mix(in srgb, #d4564a 20%, var(--panel));
  color: #d4564a;
  font-size: var(--fs-xs);
  letter-spacing: 0.06em;
}
.srv-row {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px var(--sp-3) 6px var(--sp-2);
  background: var(--panel);
  touch-action: pan-y;
  transition: transform 180ms var(--ease), background-color 180ms var(--ease);
}
.srv-row.dragging {
  background: var(--panel-2);
  box-shadow: inset 0 1px 0 var(--hi);
}
.srv-prio {
  flex: none;
  width: 22px;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-sm);
  color: var(--t2);
  touch-action: none;
  cursor: grab;
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
