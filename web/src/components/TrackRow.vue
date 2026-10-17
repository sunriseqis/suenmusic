<script setup lang="ts">
/**
 * 曲目行。
 *
 * 密集列表的关键决策：**当前播放项用「凹陷」表达，不给每行加凸起**。
 * 给每行都加凸起阴影，几十行叠在一起会糊成一片（PLAN.md 3.4 的已知代价）。
 * 所以整行是平的，只有 hover 与“当前项”才有形态变化。
 *
 * 移动端独有：整行**右滑**切换收藏 —— 手机上行内红心列是隐藏的
 * （见文件末尾的 media query），没有手势就只能先把歌播起来才能收藏。
 */
import { computed, onMounted, ref } from 'vue';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import { usePlayerStore } from '@/stores/player.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { useUiStore } from '@/stores/ui.ts';
import { artistNames, coverUrl, formatDuration } from '@/utils/format.ts';
import type { Track } from '@/api/types.ts';

const props = withDefaults(
  defineProps<{
    track: Track;
    /** 序号，从 1 开始。不传则不显示序号列 */
    index?: number;
    /** 播放时把整个列表作为队列 */
    list?: Track[];
    showAlbum?: boolean;
    showCover?: boolean;
    /**
     * 显示"不喜欢"入口（每日推荐专用）：
     * 两个图标 = 不喜欢这首 / 不喜欢该歌手，点击后由父级处理移除与上报。
     */
    dislikeable?: boolean;
    /**
     * 收藏页专用：取消收藏后这一行会从列表里消失（父级按 store 的 id 集合剪枝），
     * 所以滑动手势改成「滑出后移除」，观感与播放队列的右滑删除一致。
     * 普通页（主页/搜索/合集/每日推荐）保持 false：行留在原地，弹回即可。
     */
    swipeRemoveOnUnfavorite?: boolean;
  }>(),
  { showAlbum: true, showCover: true, dislikeable: false, swipeRemoveOnUnfavorite: false }
);

const emit = defineEmits<{
  (e: 'dislike-track', track: Track): void;
  (e: 'dislike-artist', track: Track): void;
}>();

const player = usePlayerStore();
const favorites = useFavoritesStore();
const ui = useUiStore();

const isCurrent = computed(() => player.currentTrack?.id === props.track.id);
const artist = computed(() => artistNames(props.track.ar));
const cover = computed(() => coverUrl(props.track.al?.picUrl, 150));
const isFav = computed(() => favorites.contains(props.track.id));

/** 右滑动作区上的文字：动作取决于当前状态 */
const swipeLabel = computed(() => (isFav.value ? '取消收藏' : '收藏'));

/**
 * 手势结束后浏览器补发的合成 click 必须吞掉：它可能落在行上（→ 误切歌），
 * 也可能落在行内的按钮上（→ 误触"不喜欢"）。用**捕获阶段**一次性拦掉 ——
 * 事件在到达任何子孙元素之前就被终止，所以行本身、红心、不喜欢按钮
 * 都不必各自判断。放在 touchstart 复位：合成 click 一定在本次 touchend
 * 之后、下一次 touchstart 之前到达，不会误吞用户下一次真正的点击。
 */
let suppressClick = false;

function onClickCapture(e: MouseEvent) {
  if (!suppressClick) return;
  suppressClick = false;
  e.stopPropagation();
  e.preventDefault();
}

function play() {
  void player.playTrack(props.track, props.list);
}

/** 快速收藏。行本身可点播放，红心必须拦住冒泡，否则点红心会变成切歌 */
async function toggleFav() {
  try {
    await favorites.toggle(props.track);
  } catch (e) {
    ui.err(e instanceof Error ? e.message : '收藏操作失败，请稍后重试');
  }
}

// ---------------------------------------------------------------------------
// 移动端右滑：收藏 / 取消收藏
//
// 参数与播放队列的「右滑移除」逐一对齐（水平判定 8px、阻尼 150px、
// 阈值 85px、200ms 滑出），学一次就能跨页面复用。
// 只认右滑：动作区在行的左侧被拉出来；左滑不消耗（留给未来的左滑移除）。
// ---------------------------------------------------------------------------
/** 判定为水平滑动所需的最小位移 */
const SWIPE_GATE = 8;
/**
 * 竖直方向的"认输"阈值：手势在还没变成水平之前就已经明显向下拉了这么多，
 * 就认定它属于主页的下拉刷新，本次不再抢。
 *
 * 没有这道闸会出现"既刷新又收藏"：主页下拉刷新挂在滚动容器上，
 * 它要累积到 PULL_TRIGGER(56px) / PULL_DAMPING(0.5) = **112px 原始位移**
 * 才会真的刷新；而用户完全可以先往下拉 112px 再拐向右边 ——
 * 那样刷新与收藏会同时发生。24px 远早于这个临界点。
 */
const VERTICAL_COMMIT = 24;
/** 超过这个位移后加阻尼，避免行被拉得过远 */
const SWIPE_DAMP_AT = 150;
/** 触发动作的阈值，与队列一致 */
const SWIPE_THRESHOLD = 85;
/** 触发动后的滑出距离 */
const SWIPE_OUT = 360;

const swipeOffset = ref(0);
/** 手指正按在行上参与手势（据此关掉过渡，跟手） */
const swiping = ref(false);
/** 已触发动作、行正在滑出（收藏页里随后会被父级剪掉） */
const vanishing = ref(false);

let startX = 0;
let startY = 0;
let horizontal = false;
/** 本次手势已判定为竖直（下拉刷新），不再参与滑动 */
let abandoned = false;

function onTouchStart(e: TouchEvent) {
  if (vanishing.value) return;
  const t = e.touches[0];
  if (!t) return;
  startX = t.clientX;
  startY = t.clientY;
  horizontal = false;
  abandoned = false;
  suppressClick = false;
  swipeOffset.value = 0;
  swiping.value = true;
}

function onTouchMove(e: TouchEvent) {
  if (!swiping.value || vanishing.value) return;
  const t = e.touches[0];
  if (!t) return;
  const dx = t.clientX - startX;
  const dy = t.clientY - startY;

  if (!horizontal) {
    // 先看竖直方向是否已经"跑远"：是就把这次手势整个让给下拉刷新
    if (Math.abs(dy) > VERTICAL_COMMIT && Math.abs(dy) >= Math.abs(dx)) {
      abandoned = true;
    }
    if (!abandoned && Math.abs(dx) > SWIPE_GATE && Math.abs(dx) > Math.abs(dy)) {
      horizontal = true;
      suppressClick = true;
    }
  }
  if (!horizontal) return;

  // 拦住挂在滚动容器上的手势：主页的下拉刷新在冒泡阶段会把斜向滑动抢走
  // （本监听在目标阶段，先于祖先触发，所以拦得住）
  e.stopPropagation();
  if (e.cancelable) e.preventDefault();

  if (dx <= 0) {
    swipeOffset.value = 0;
    return;
  }
  swipeOffset.value = dx > SWIPE_DAMP_AT ? SWIPE_DAMP_AT + (dx - SWIPE_DAMP_AT) * 0.25 : dx;
}

function onTouchEnd() {
  if (!swiping.value) return;
  const reached = horizontal && swipeOffset.value >= SWIPE_THRESHOLD;
  // 先关掉跟手态，让弹回/滑出重新吃到 transition
  swiping.value = false;
  horizontal = false;
  abandoned = false;

  if (!reached) {
    swipeOffset.value = 0;
    return;
  }

  if (isFav.value && props.swipeRemoveOnUnfavorite) {
    // 这一行即将从列表消失：先滑出去，动画走完再改状态
    // （状态一变父级就把它剪掉，所以顺序不能反）
    vanishing.value = true;
    swipeOffset.value = SWIPE_OUT;
    window.setTimeout(() => {
      void toggleFav();
      vanishing.value = false;
    }, 200);
    return;
  }

  // 普通页：行留在原地，弹回后由红心状态变化确认结果
  void toggleFav();
  swipeOffset.value = 0;
}

/** 手势被系统打断（来电、返回手势接管）：只复位，绝不当作"已触发" */
function onTouchCancel() {
  if (!swiping.value) return;
  swiping.value = false;
  horizontal = false;
  abandoned = false;
  swipeOffset.value = 0;
}

// 收藏 id 集合是登录后懒加载的：第一行触发全量拉取，其余行共享同一个进行中的请求。
// 拉到之前红心一律显示空心，集合到位后由响应式更新点亮。
// 失败静默：可能是登出瞬间的 401，红心不值得为它报错
onMounted(() => {
  favorites.ensureLoaded().catch(() => {});
});
</script>

<template>
  <div class="row-wrap" :class="{ 'is-vanishing': vanishing }" @click.capture="onClickCapture">
    <!-- 右滑拉出来的动作区：与队列的「移除」同构，出现在行的左侧 -->
    <div class="swipe-bg" :class="{ danger: isFav }" aria-hidden="true">
      <NeuIcon :name="isFav ? 'heart-filled' : 'heart'" :size="15" />
      <span>{{ swipeLabel }}</span>
    </div>

    <div
      class="row"
      :class="{ current: isCurrent, 'is-swiping': swiping }"
      :style="swipeOffset ? { transform: `translateX(${swipeOffset}px)` } : undefined"
      role="button"
      tabindex="0"
      :aria-label="`播放 ${track.name}`"
      @click="play"
      @keydown.enter.prevent="play"
      @keydown.space.prevent="play"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchCancel"
    >
      <!-- 序号 / 播放指示 -->
      <div v-if="index !== undefined" class="idx">
        <span v-if="isCurrent" class="bars" aria-hidden="true">
          <i /><i /><i />
        </span>
        <span v-else class="neu-num num">{{ index }}</span>
      </div>

      <div v-if="showCover" class="cov">
        <img v-if="cover" :src="cover" :alt="''" loading="lazy" />
        <span v-else class="cov-ph" aria-hidden="true" />
        <!--
          已收藏：封面左上角一盏很小的强调色指示灯。
          手机上心形列整列被隐藏，没有它滑动就是盲操作（不知道这一下
          是"收藏"还是"取消收藏"）—— 但也不能抢戏，所以只做一个小光点，
          不用图标。仅窄屏显示：PC 有 hover 红心，不需要常显。
        -->
        <span v-if="isFav" class="fav-dot" aria-hidden="true" />
      </div>

      <div class="main">
        <span class="name neu-ellipsis" :class="isCurrent ? 'on' : ''">{{ track.name }}</span>
        <span class="sub neu-ellipsis">{{ artist }}</span>
      </div>

      <div v-if="showAlbum" class="album neu-ellipsis">
        <span class="neu-t2">{{ track.al?.name || '' }}</span>
      </div>

      <span class="dur neu-num">{{ formatDuration(track.dt) }}</span>

      <div class="act" :class="{ 'act-wide': dislikeable }">
        <template v-if="dislikeable">
          <button
            type="button"
            class="fav dislike"
            :aria-label="`不喜欢这首歌：${track.name}`"
            :title="`不喜欢这首歌：${track.name}（之后不再推荐）`"
            @click.stop="emit('dislike-track', track)"
            @keydown.enter.stop
            @keydown.space.stop
          >
            <NeuIcon name="dislike-song" :size="16" />
          </button>
          <button
            type="button"
            class="fav dislike"
            :aria-label="`不喜欢歌手：${artist}`"
            :title="`不喜欢歌手：${artist}（之后不再推荐该歌手）`"
            @click.stop="emit('dislike-artist', track)"
            @keydown.enter.stop
            @keydown.space.stop
          >
            <NeuIcon name="dislike-artist" :size="16" />
          </button>
        </template>
        <button
          type="button"
          class="fav"
          :class="{ on: isFav }"
          :aria-label="isFav ? `取消收藏 ${track.name}` : `收藏 ${track.name}`"
          :aria-pressed="isFav"
          :title="isFav ? '取消收藏' : '收藏'"
          @click.stop="toggleFav"
          @keydown.enter.stop
          @keydown.space.stop
        >
          <NeuIcon :name="isFav ? 'heart-filled' : 'heart'" :size="17" />
        </button>
        <NeuIcon
          v-if="isCurrent && player.playing"
          name="volume"
          :size="17"
          class="playing-icon"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 行外层：把滑出去的部分裁掉，动作区就只在左侧露出一条 */
.row-wrap {
  position: relative;
  overflow: hidden;
  border-radius: 0;
}
/* 已触发动作、行正在滑出（收藏页：随后被父级剪掉）—— 期间不再接手势 */
.row-wrap.is-vanishing {
  pointer-events: none;
}

/* 右滑露出的动作区。填充色与队列的删除条同构，靠颜色区分动作性质 */
.swipe-bg {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding-left: var(--sp-4);
  border-radius: var(--r-md);
  /* 用 --accent-text 而不是 --accent：后者配白字对比度不够 */
  background: var(--accent-text);
  color: #fff;
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
}
:root[data-theme='dark'] .swipe-bg {
  background: #c2541a;
}
.swipe-bg.danger {
  background: #b3261e;
}
:root[data-theme='dark'] .swipe-bg.danger {
  background: #8a1f18;
  color: #ffdad6;
}

.row {
  /* 必须有底色：否则滑动时下层动作区会从整行透出来 */
  position: relative;
  z-index: 1;
  /* ⚠️ 必须不透明：下面就是右滑动作区，透明会让整行变成那条橙色 */
  background: var(--bg);
  display: grid;
  grid-template-columns: 32px 40px minmax(0, 1.6fr) minmax(0, 1fr) 52px 56px;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: 0;
  min-height: 52px;
  cursor: pointer;
  color: var(--t1);
  transition:
    transform var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease),
    background-color var(--dur-fast) var(--ease);
}
/* 手指在行上期间关掉过渡，位移跟手 */
.row.is-swiping {
  transition: none;
}

/* 没有序号与封面时列数少了，网格自动收敛 */
.row:not(:has(.idx)) {
  grid-template-columns: 40px minmax(0, 1.6fr) minmax(0, 1fr) 52px 56px;
}
.row:not(:has(.idx)):not(:has(.cov)) {
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) 52px 56px;
}

/* 列表靠发丝线分界，行本身不做"卡片" */
.row-wrap:not(:last-child) .row {
  border-bottom: 1px solid var(--line);
}

.row:hover {
  background: var(--panel-2);
}

/* 当前播放项：左侧一条 2px 琥珀，比整行变色克制 */
.row.current {
  background: color-mix(in srgb, var(--accent) 7%, var(--panel));
  box-shadow: inset 2px 0 0 var(--accent);
}
.row:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: -2px;
}

.idx {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--t2);
}
.num {
  color: var(--t2);
}

/* 播放中的三根跳动竖条 —— 不用 emoji，用纯 CSS 动画 */
.bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
}
.bars i {
  width: 2px;
  background: var(--accent);
  border-radius: 1px;
  animation: bounce 1s var(--ease) infinite;
}
.bars i:nth-child(1) {
  height: 60%;
  animation-delay: 0ms;
}
.bars i:nth-child(2) {
  height: 100%;
  animation-delay: 160ms;
}
.bars i:nth-child(3) {
  height: 45%;
  animation-delay: 320ms;
}
@keyframes bounce {
  0%,
  100% {
    transform: scaleY(0.5);
  }
  50% {
    transform: scaleY(1);
  }
}

.cov,
.cov img,
.cov-ph {
  width: 40px;
  height: 40px;
  border-radius: var(--r-sm);
  flex: none;
}
.cov {
  position: relative;
}
.cov-ph {
  display: block;
  background: var(--panel-2);
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--hi);
}
.cov img {
  object-fit: cover;
  background: var(--track);
}

/*
 * 已收藏的指示灯：封面左上角**外面**一个 6px 的强调色光点 + 一圈柔光。
 *
 * 位置刻意压在封面框线上（只压住 1px，其余 5px 落在封面外的底色上）：
 * 放在封面内侧会被封面图吃掉对比度，看不清。
 * 整体做得极小 —— 它的职责只是"让你滑动前知道当前状态"，
 * 不是号召点击（心形列在手机上本来就是隐藏的）。
 */
.fav-dot {
  display: none;
  position: absolute;
  top: 3px;
  left: -5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 5px 1px var(--accent);
  pointer-events: none;
}

.main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.name {
  font-size: var(--fs-md);
  color: var(--t1);
}
.name.on {
  color: var(--accent-text);
  font-weight: var(--fw-medium);
}
.sub {
  font-size: var(--fs-xs);
  color: var(--t2);
}

.album {
  font-size: var(--fs-xs);
  min-width: 0;
}

.dur {
  color: var(--t2);
  text-align: right;
}

.act {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  color: var(--accent-text);
}

/* 红心：hover（或已收藏 / 键盘聚焦）时才显形，避免整列图标喧宾夺主 */
.fav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: none;
  color: var(--t2);
  cursor: pointer;
  border-radius: var(--r-sm);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.row:hover .fav,
.fav.on,
.fav:focus-visible {
  opacity: 1;
}
.fav.on {
  color: var(--accent-text);
}
.fav:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: -1px;
}

/* 不喜欢按钮：比红心更淡，hover 行时才显形；点了是要"拉黑"的动作，视觉上与红心区分 */
.fav.dislike {
  color: var(--t2);
}
.fav.dislike:hover {
  color: #b3261e;
}
:root[data-theme='dark'] .fav.dislike:hover {
  color: #ff9a92;
}

/* 每日推荐的行多两个按钮：加宽操作列，并把专辑列让位 */
.row:has(.act-wide) {
  grid-template-columns: 32px 40px minmax(0, 1.6fr) minmax(0, 1fr) 52px auto;
}

@media (max-width: 767px) {
  /* 手机上不显示专辑列 —— 宽度不够，挤掉它比让歌名换行更好。
     但每日推荐的不喜欢入口必须保留：act-wide 时操作列常显 */
  .row,
  .row:not(:has(.idx)),
  .row:not(:has(.idx)):not(:has(.cov)) {
    grid-template-columns: 26px 40px minmax(0, 1fr) 46px;
    gap: var(--sp-2);
    padding: var(--sp-2);
    min-height: 56px;
  }
  .album,
  .act {
    display: none;
  }
  .row:has(.act-wide) {
    /* 操作列（两个不喜欢按钮）加回来后，时长列必须让位：
       不然 5 个子项挤 4 列，按钮会换行掉到歌名下方（实测踩过） */
    grid-template-columns: 26px 40px minmax(0, 1fr) auto;
  }
  .row:has(.act-wide) .dur {
    display: none;
  }
  .row:has(.act-wide) .act {
    display: flex;
  }
  .row:has(.act-wide) .act .fav:not(.dislike) {
    display: none;
  }
  .row:has(.act-wide) .fav.dislike {
    opacity: 1;
  }
  /* 手机上心形列整列被隐藏，改由封面左上角那盏小灯表达"已收藏"，
     滑动才知道这一下是收藏还是取消收藏（PC 有 hover 红心，不需要） */
  .fav-dot {
    display: block;
  }
}
</style>
