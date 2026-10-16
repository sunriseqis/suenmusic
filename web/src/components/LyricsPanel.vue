<script setup lang="ts">
/**
 * 歌词面板（桌面详情页右栏 / 移动全屏页共用）。
 *
 * - 跟随 player.currentTrack：切歌自动重拉 `/api/lyrics/:id`（abort 旧请求，
 *   返回后校验曲目没再变才落地，防止慢歌词追上快切歌）
 * - 按 player.positionMs 高亮当前行（activeLineIndex 二分，无需滚动节流）
 * - 点击行 seek 到该行（store.seek 单位是毫秒）
 * - 无歌词 / 加载失败给出明确文案，不空着装死
 *
 * 自动滚动用 scrollTop 手动算而不是 scrollIntoView：后者在嵌套滚动容器里
 * 会连带滚动页面其它祖先，详情页 overlay 里行为不可控。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useLyricsStore } from '@/stores/lyrics.ts';
import { usePlayerStore } from '@/stores/player.ts';
import type { LyricLine } from '@/utils/lyric.ts';

const player = usePlayerStore();
const lyrics = useLyricsStore();

/**
 * dense 模式（移动全屏页用）：上下留白收窄 —— 桌面右栏需要"当前行滚到
 * 居中"的大留白，移动端竖排空间宝贵，没必要。
 *
 * seekable = 点击歌词行是否跳转进度（默认 true）。移动端翻转卡里歌词
 * 点击被"翻回封面"占用，传 false 关掉行点击，避免想翻面却把歌跳走。
 */
const props = withDefaults(
  defineProps<{ dense?: boolean; seekable?: boolean }>(),
  { dense: false, seekable: true }
);

const box = ref<HTMLElement | null>(null);
const lines = computed(() => lyrics.lines);
const loading = computed(() => lyrics.loading);
const failed = computed(() => lyrics.failed);
const activeIdx = computed(() => lyrics.activeIdx);

onMounted(() => lyrics.init());

// 高亮行变化 → 滚到容器垂直居中。蓝牙同步由全局 lyrics store 负责。
watch(activeIdx, idx => {
  const el = box.value;
  if (!el || idx < 0) return;
  const row = el.querySelector<HTMLElement>(`[data-line="${idx}"]`);
  if (!row) return;
  el.scrollTo({
    top: row.offsetTop - el.clientHeight / 2 + row.clientHeight / 2,
    behavior: 'smooth',
  });
});

function seekLine(line: LyricLine) {
  void player.seek(line.time);
}
</script>

<template>
  <div ref="box" class="lyrics neu-scroll" :class="{ dense }" data-role="lyrics">
    <!-- 首尾弹性 spacer：不活动时把歌词块顶到垂直居中；歌词超长时
         各保留约一半屏的空程，保证"当前行滚到容器中心"永远成立。
         （不能用 padding 百分比：padding 相对的是容器**宽度**，左右栏一变宽
         上下留白就失控 —— 这正是之前详情页歌词错位的原因） -->
    <span class="spacer" aria-hidden="true" />
    <p v-if="loading" class="state neu-t2">歌词加载中…</p>
    <p v-else-if="failed" class="state neu-t2">歌词加载失败，切歌后会自动重试</p>
    <p v-else-if="!lines.length" class="state neu-t2" data-role="no-lyric">这首歌暂无歌词</p>
    <template v-else>
      <button
        v-for="(line, i) in lines"
        :key="i"
        type="button"
        class="line"
        :class="{ active: i === activeIdx, static: !props.seekable }"
        :data-line="i"
        :aria-label="props.seekable ? `跳到歌词：${line.text}` : line.text"
        @click="props.seekable && seekLine(line)"
      >
        <span class="l1">{{ line.text }}</span>
        <span v-if="line.trans" class="l2 neu-t2">{{ line.trans }}</span>
      </button>
    </template>
    <span class="spacer" aria-hidden="true" />
  </div>
</template>

<style scoped>
.lyrics {
  overflow-y: auto;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: 0 var(--sp-4);
  /* 必须自成 offsetParent：滚动居中用 row.offsetTop 计算，
     不加这条 offsetTop 会相对更外层的定位祖先（详情页 fixed 浮层）去量，
     结果整体滚过头、当前行偏到中心下方 */
  position: relative;
  /* 歌词是氛围元素：滚动条藏掉（滚轮/触摸照常），上下渐隐淡出 */
  scrollbar-width: none;
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 56px,
    #000 calc(100% - 64px),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 56px,
    #000 calc(100% - 64px),
    transparent 100%
  );
}
.lyrics::-webkit-scrollbar {
  display: none;
}

/* 弹性空程：flex-basis 按容器**高度**解析（父容器高度固定），宽度无关 */
.spacer {
  flex: 1 0 42%;
  min-height: 40px;
}

.state {
  text-align: center;
  margin: 0;
}

.line {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--sp-1) var(--sp-2);
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  border-radius: var(--r-md);
  color: var(--t2);
  transition:
    color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
/* 不可点击模式（移动端翻转卡）：整个歌词面只负责翻回封面 */
.line.static {
  cursor: default;
}
.line:hover {
  color: var(--t1);
}
.line .l1 {
  font-size: var(--fs-lg);
  line-height: var(--lh-tight);
  white-space: pre-line;
}
.line .l2 {
  font-size: var(--fs-sm);
  white-space: pre-line;
}
.line.active {
  color: var(--accent-text);
  font-weight: var(--fw-medium);
  transform: translateX(4px);
}
.line.active .l2 {
  color: var(--accent-text);
  opacity: 0.75;
}
.line:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: -1px;
}

.lyrics.dense {
  gap: var(--sp-2);
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 28px,
    #000 calc(100% - 32px),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 28px,
    #000 calc(100% - 32px),
    transparent 100%
  );
}
.lyrics.dense .spacer {
  flex-basis: 12%;
  min-height: 16px;
}
.lyrics.dense .line .l1 {
  font-size: var(--fs-sm);
}
</style>
