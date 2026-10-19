<script setup lang="ts">
/**
 * 音源锚定弹窗（低置信曲目的人工兜底）。
 *
 * 解析失败时 player.anchorCandidate 会自动置上，本弹窗随之打开：
 *   1. 关键词默认「歌名 + 主歌手」，可改后重新搜
 *   2. B 站候选列表：标题 / UP 主 / 时长 / 置信分，逐条可试听
 *   3. 试听满意 → 「锚定」：把「这首曲 = 这个视频」永久入库，
 *      之后播放直接按锚点取流，不再走匹配
 *
 * 挂在 App.vue 根部（全局唯一），播放条 / 全屏播放页都不用各自实现。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import {
  anchorTrack,
  fetchBiliCandidates,
  fetchTrackAnchor,
  unanchorTrack,
  type TrackAnchorInfo,
} from '@/api/playback.ts';
import type { AnchorTrackMeta, BiliCandidate } from '@/api/playback.ts';
import { getBaseUrl, resolveUrl } from '@/api/client.ts';
import { biliResolveAudio } from '@/api/direct/upstream.ts';
import {
  getLocalAnchor,
  removeLocalAnchor,
  searchLocalCandidates,
  setLocalAnchor,
} from '@/api/direct/anchor.ts';
import { usePlayerStore } from '@/stores/player.ts';
import { useUiStore } from '@/stores/ui.ts';
import { blurActiveInput, registerBackHandler } from '@/native/back.ts';
import { formatDuration } from '@/utils/format.ts';

const player = usePlayerStore();

/** 没配服务端 = 直连模式：候选搜索、锚点存取全部走本机 */
function isLocal(): boolean {
  return !getBaseUrl().trim();
}
const ui = useUiStore();

const track = computed(() => player.anchorCandidate);

const keyword = ref('');
const candidates = ref<BiliCandidate[]>([]);
/** 曲目自己的 Q 音元数据（原版参照：封面 / 专辑 / 时长） */
const trackMeta = ref<AnchorTrackMeta | null>(null);
const searching = ref(false);
/** 风控 / 空结果等说明文字 */
const searchNote = ref('');
/** 正在试听的候选。null = 没有在放 */
const previewingBvid = ref<string | null>(null);
/** 正在提交锚定的候选 */
const anchoringBvid = ref<string | null>(null);
/** 该曲目已存在的锚点（回显 + 可解除） */
const currentAnchor = ref<TrackAnchorInfo | null>(null);
const removingAnchor = ref(false);

/**
 * 「当前音源」。
 *
 * 播放器上的音源指示灯已经去掉，用户在这里看不到这首到底走的哪条路，
 * 也就无法判断"要不要锚定"。三种状态：
 *   已锚定 → 走 B 站的那个视频；播放中 → 本次解析出的源；否则 → 未解析。
 * 只用 currentSource 不够：它换曲时不会立刻清空，所以要按曲目 id 对齐。
 */
const currentSourceLabel = computed(() => {
  const t = track.value;
  if (!t) return '';
  if (currentAnchor.value) return 'B 站 · 已锚定';
  if (player.currentSourceTrackId === t.id && player.currentSource) {
    return player.currentSource === 'netease' ? '网易云' : 'B 站';
  }
  return '未解析';
});

/** 试听用的 <audio>。单实例：换曲即换 URI，关弹窗即停 */
let previewAudio: HTMLAudioElement | null = null;

/**
 * 候选时长与曲目差太多 → 大概率不是同一录音（live / 合集 / 不同编曲）。
 *
 * 为什么必须提示：锚定是**最高权威**，会绕过自动匹配的置信度与时长校验。
 * 实测踩过 —— 把 6 分钟的视频锚到 3:16 的歌上，播放器会老老实实播 6 分钟的内容，
 * 界面上时长也变成 6 分钟，用户只觉得"时长怎么不对"却找不到原因。
 * 阈值 20 秒：正常版本差异（前奏长短、淡入淡出）不会超。
 */
function durationMismatch(c: BiliCandidate): boolean {
  return Math.abs(c.durationDiff) > 20;
}

/** 服务端给的 durationDiff 是**绝对值**，所以这里不声称长/短方向 */
function durationDiffText(c: BiliCandidate): string {
  return `差 ${Math.round(Math.abs(c.durationDiff))} 秒`;
}

function stopPreview(): void {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.removeAttribute('src');
    previewAudio.load();
  }
  previewingBvid.value = null;
}

async function togglePreview(c: BiliCandidate): Promise<void> {
  if (previewingBvid.value === c.bvid) {
    stopPreview();
    return;
  }
  stopPreview();
  try {
    /**
     * 服务端模式下 previewUrl 是带令牌的代理流；
     * 直连模式没有代理，按需现场解析这一条的真实地址。
     */
    const url = c.previewUrl ? resolveUrl(c.previewUrl) : (await biliResolveAudio(c.bvid)).url;
    previewAudio = previewAudio ?? new Audio();
    previewAudio.src = url;
    previewAudio.volume = 0.9;
    previewingBvid.value = c.bvid;
    await previewAudio.play();
  } catch {
    ui.err('试听加载失败，请稍后重试');
    previewingBvid.value = null;
  }
}

async function search(): Promise<void> {
  const t = track.value;
  if (!t || searching.value) return;
  searching.value = true;
  searchNote.value = '';
  stopPreview();
  try {
    const res = isLocal()
      ? await searchLocalCandidates(t, keyword.value.trim())
      : await fetchBiliCandidates(t.id, keyword.value.trim());
    candidates.value = res.candidates;
    // Q 音侧的原版参照：封面 / 专辑 / 时长，对着它挑 B 站视频
    trackMeta.value = res.track ?? null;
    if (res.rejected) {
      searchNote.value = res.message ?? 'B 站搜索被风控拦截，请稍后重试';
    } else if (res.candidates.length === 0) {
      searchNote.value = '没有搜到候选视频，换个关键词试试';
    }
  } catch (e) {
    searchNote.value = e instanceof Error ? e.message : '候选搜索失败，请稍后重试';
  } finally {
    searching.value = false;
  }
}

async function doAnchor(c: BiliCandidate): Promise<void> {
  const t = track.value;
  if (!t || anchoringBvid.value) return;
  anchoringBvid.value = c.bvid;
  try {
    if (isLocal()) {
      setLocalAnchor(t.id, {
        bvid: c.bvid,
        title: c.title,
        author: c.author,
        durationSec: c.durationSec,
      });
    } else {
      await anchorTrack(t.id, {
        bvid: c.bvid,
        title: c.title,
        author: c.author,
        durationSec: c.durationSec,
      });
    }
    stopPreview();
    ui.ok('已锚定，开始播放');
    // 服务端锚定时已清解析缓存，这里直接重装当前曲目
    await player.retryAfterAnchor(t);
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '锚定失败，请稍后重试');
  } finally {
    anchoringBvid.value = null;
  }
}

function close(): void {
  stopPreview();
  player.dismissAnchorDialog();
}

/**
 * 返回手势：开着就关掉（等同点遮罩）。
 *
 * 但**先让键盘这一下**：弹窗里的关键词是用户手改过的，正在输入时一次返回
 * 就把整个弹窗关掉会把他改了一半的词扔掉（也和外层"返回先关键盘"的
 * 约定不一致）；收完键盘再按一次才关。
 */
let offBack: (() => void) | null = null;
watch(
  () => !!track.value,
  open => {
    if (open) {
      offBack = registerBackHandler(() => {
        if (blurActiveInput()) return true;
        if (!track.value) return false;
        close();
        return true;
      });
    } else {
      offBack?.();
      offBack = null;
    }
  },
  { immediate: true }
);
onBeforeUnmount(() => offBack?.());

// 弹窗打开时：重置关键词（默认「歌名 + 主歌手」）并自动搜一轮
watch(track, t => {
  if (!t) return;
  keyword.value = [t.name, t.ar?.[0]?.name ?? ''].join(' ').trim();
  candidates.value = [];
  currentAnchor.value = null;
  searchNote.value = '';
  void search();
  void loadCurrentAnchor();
});

async function loadCurrentAnchor(): Promise<void> {
  const t = track.value;
  if (!t) return;
  if (isLocal()) {
    const a = getLocalAnchor(t.id);
    currentAnchor.value = a
      ? {
          bvid: a.bvid,
          title: a.title,
          author: a.author,
          durationSec: a.durationSec,
          pinned: a.pinned,
        }
      : null;
    return;
  }
  try {
    const res = await fetchTrackAnchor(t.id);
    currentAnchor.value = res.anchor;
  } catch {
    currentAnchor.value = null;
  }
}

async function removeCurrentAnchor(): Promise<void> {
  const t = track.value;
  if (!t || removingAnchor.value) return;
  removingAnchor.value = true;
  try {
    if (isLocal()) {
      removeLocalAnchor(t.id);
    } else {
      await unanchorTrack(t.id);
    }
    currentAnchor.value = null;
    ui.ok('已解除锚定，该曲目回到自动匹配');
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '解除失败，请稍后重试');
  } finally {
    removingAnchor.value = false;
  }
}

onBeforeUnmount(stopPreview);
</script>

<template>
  <Teleport to="body">
    <div v-if="track" class="scrim" @click.self="close">
      <section class="dialog neu-raised-lg" role="dialog" aria-label="手动锚定音源">
        <header class="head">
          <div class="head-text">
            <h2 class="title">手动锚定音源</h2>
            <p class="sub neu-t2 neu-ellipsis">{{ track.name }}</p>
          </div>
          <NeuButton variant="ghost" @click="close">关闭</NeuButton>
        </header>

        <!-- 当前音源：去掉播放器指示灯后，这里是唯一能看出来的地方 -->
        <div class="src-row" data-role="current-source">
          <span class="src-k">当前音源</span>
          <span class="src-v">{{ currentSourceLabel }}</span>
        </div>

        <!-- 已有锚点：回显并可解除（锚错了随时推翻重来） -->
        <div v-if="currentAnchor" class="cur-anchor" data-role="cur-anchor">
          <span class="neu-t2 neu-ellipsis">
            当前锚点：{{ currentAnchor.title || currentAnchor.bvid }}
            <template v-if="currentAnchor.author">· {{ currentAnchor.author }}</template>
          </span>
          <NeuButton variant="ghost" :loading="removingAnchor" @click="removeCurrentAnchor">
            解除锚定
          </NeuButton>
        </div>

        <div class="search-row">
          <NeuInput
            v-model="keyword"
            label="B 站搜索词"
            placeholder="歌名 歌手"
            @enter="search"
          />
          <NeuButton variant="primary" :loading="searching" @click="search">搜索</NeuButton>
        </div>

        <p v-if="searchNote" class="note neu-t2">{{ searchNote }}</p>

        <!-- 原版参照：Q 音侧的专辑与时长元数据，帮用户认出正确的视频 -->
        <div v-if="trackMeta" class="ref-card" data-role="anchor-ref">
          <div class="ref-meta">
            <span class="ref-name neu-ellipsis">{{ trackMeta.name }}</span>
            <span class="neu-t2 neu-ellipsis">
              {{ trackMeta.artists.join(' / ') }}
              <template v-if="trackMeta.albumName"> · {{ trackMeta.albumName }}</template>
            </span>
            <span class="neu-t2 neu-num">参考时长 {{ formatDuration(trackMeta.durationMs) }}</span>
          </div>
        </div>

        <ul class="list" data-role="anchor-candidates">
          <li v-for="c in candidates" :key="c.bvid" class="row">
            <div class="meta">
              <span class="c-title" :title="c.title">{{ c.title }}</span>
              <span class="c-sub neu-t2 neu-ellipsis">
                {{ c.author }} · {{ formatDuration(c.durationSec * 1000) }} · 置信 {{ Math.round(c.score) }}
              </span>
              <span v-if="durationMismatch(c)" class="c-warn">
                ⚠ 时长与曲目差得多（{{ durationDiffText(c) }}），可能不是同一版本
              </span>
            </div>
            <div class="ops">
              <NeuButton
                size="sm"
                :variant="previewingBvid === c.bvid ? 'default' : 'ghost'"
                @click="togglePreview(c)"
              >
                {{ previewingBvid === c.bvid ? '停止' : '试听' }}
              </NeuButton>
              <NeuButton
                size="sm"
                variant="primary"
                :loading="anchoringBvid === c.bvid"
                @click="doAnchor(c)"
              >
                锚定
              </NeuButton>
            </div>
          </li>
        </ul>
    </section>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-overlay) + 10);
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
}

.dialog {
  width: min(100%, 560px);
  max-height: min(80dvh, 640px);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-5);
  border-radius: var(--r-lg);
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
}
.head-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
.sub {
  margin: 0;
  font-size: var(--fs-sm);
}

.search-row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-3);
}
.search-row > :first-child {
  flex: 1 1 auto;
  min-width: 0;
}

.note {
  margin: 0;
  font-size: var(--fs-sm);
  text-align: center;
}

.src-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.src-k {
  font-size: 11px;
  letter-spacing: 0.16em;
  color: var(--t2);
}
.src-v {
  font-size: var(--fs-sm);
  color: var(--t1);
}

.cur-anchor {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--panel-2);
  font-size: var(--fs-xs);
}

/* 原版参照卡：Q 音侧元数据信息（歌名 / 歌手 / 专辑 / 参考时长） */
.ref-card {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--panel-2);
}
.ref-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--fs-xs);
}
.ref-name {
  font-size: var(--fs-sm);
  color: var(--t1);
  font-weight: var(--fw-medium);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  min-height: 120px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  /* 与全站一致：不显示滚动条 */
  scrollbar-width: none;
}
.list::-webkit-scrollbar {
  display: none;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border-radius: 0;
  border-top: 1px solid var(--line);
}
.row:first-child {
  border-top: 0;
}
.meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.c-title {
  font-size: var(--fs-sm);
  color: var(--t1);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.c-sub {
  font-size: var(--fs-xs);
}
/* 时长不符的警告：用强调色文字 + ⚠ 字形（不新增主题色 token） */
.c-warn {
  font-size: var(--fs-xs);
  line-height: 1.4;
  color: var(--accent-text);
}
.ops {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: none;
}

@media (max-width: 600px) {
  .scrim {
    padding: var(--sp-2);
  }
  .dialog {
    width: 100%;
    max-height: 88dvh;
    padding: var(--sp-3-5, 14px);
    gap: var(--sp-3);
  }
  .row {
    padding: var(--sp-2);
    gap: var(--sp-2);
  }
  .ops {
    gap: var(--sp-1);
  }
  .ops :deep(.neu-btn) {
    padding: 3px 8px;
    font-size: var(--fs-xs);
  }
}
</style>
