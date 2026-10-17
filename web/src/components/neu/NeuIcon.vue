<script setup lang="ts">
import { computed } from 'vue';

/**
 * 内联 SVG 图标集。
 *
 * 项目硬性规则：**任何地方都不得用 emoji 当图标**。所以这里把用到的图标
 * 全部内联成 SVG path —— 不引图标库，是因为主流图标库的视觉重量
 * （细线、尖角）和软拟物的圆润厚实完全不搭，反而要做大量覆盖。
 *
 * 统一 24×24 视框、1.8 描边、圆头圆角，保证一组图标观感一致。
 */
export type IconName =
  | 'play'
  | 'pause'
  | 'next'
  | 'prev'
  | 'search'
  | 'home'
  | 'settings'
  | 'heart'
  | 'heart-filled'
  | 'volume'
  | 'volume-mute'
  | 'list'
  | 'close'
  | 'chevron-up'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'user'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'refresh'
  | 'trash'
  | 'plus'
  | 'menu'
  | 'eye'
  | 'eye-off'
  | 'mode-order'
  | 'mode-loop'
  | 'mode-repeat-one'
  | 'mode-shuffle'
  | 'mode-shuffle-once'
  | 'dislike-song'
  | 'dislike-artist'
  | 'sparkles'
  | 'anchor'
  | 'playlist-add'
  | 'download'
  | 'upload'
  | 'info'
  | 'dots';

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: number | string;
    /** 描边宽度。小尺寸下可调细一点 */
    stroke?: number;
  }>(),
  { size: 20, stroke: 1.8 }
);

/**
 * path 数据。用 `d` 数组而不是单串，方便多个子路径的图标分别书写。
 * 一律使用 24×24 坐标系。
 */
const PATHS: Record<IconName, string[]> = {
  dots: ['M5.5 12h.01', 'M12 12h.01', 'M18.5 12h.01'],
  play: ['M8 5.5v13l11-6.5z'],
  pause: ['M9 5v14', 'M15 5v14'],
  next: ['M6 5.5v13l9-6.5z', 'M19 5v14'],
  prev: ['M18 5.5v13L9 12z', 'M5 5v14'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M16.5 16.5 21 21'],
  home: ['M4 10.5 12 4l8 6.5V20H4z', 'M9.5 20v-6h5v6'],
  settings: [
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z',
    'M19.4 13.5a7.6 7.6 0 0 0 0-3l1.8-1.4-1.9-3.3-2.1.9a7.6 7.6 0 0 0-2.6-1.5L14.2 2h-3.8l-.4 2.2a7.6 7.6 0 0 0-2.6 1.5l-2.1-.9L3.4 9.1l1.8 1.4a7.6 7.6 0 0 0 0 3l-1.8 1.4 1.9 3.3 2.1-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.2h3.8l.4-2.2a7.6 7.6 0 0 0 2.6-1.5l2.1.9 1.9-3.3z',
  ],
  heart: [
    'M12 20s-7.2-4.4-7.2-9.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.2 3C19.2 15.6 12 20 12 20z',
  ],
  'heart-filled': [
    'M12 20s-7.2-4.4-7.2-9.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.2 3C19.2 15.6 12 20 12 20z',
  ],
  volume: ['M5 10v4h3l4 3.5v-11L8 10z', 'M15.5 9.5a3.5 3.5 0 0 1 0 5', 'M18 7a7 7 0 0 1 0 10'],
  'volume-mute': ['M5 10v4h3l4 3.5v-11L8 10z', 'M16 10l4 4', 'M20 10l-4 4'],
  list: ['M4 7h16', 'M4 12h16', 'M4 17h10'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  'chevron-up': ['M6 15l6-6 6 6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  sun: [
    'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z',
    'M12 2v2.5',
    'M12 19.5V22',
    'M2 12h2.5',
    'M19.5 12H22',
    'M4.9 4.9l1.8 1.8',
    'M17.3 17.3l1.8 1.8',
    'M19.1 4.9l-1.8 1.8',
    'M6.7 17.3l-1.8 1.8',
  ],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'],
  monitor: ['M4 5h16v11H4z', 'M9 20h6', 'M12 16v4'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v4.5h-4.5'],
  trash: ['M5 7h14', 'M10 7V5h4v2', 'M6.5 7l1 13h9l1-13', 'M10 11v6', 'M14 11v6'],
  plus: ['M12 5v14', 'M5 12h14'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  eye: ['M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z', 'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  'eye-off': [
    'M4 4l16 16',
    'M9.5 9.7A2.5 2.5 0 0 0 12 14.5c.7 0 1.3-.3 1.8-.7',
    'M6.3 6.7C3.9 8.4 2.5 12 2.5 12s3.5 5.5 9.5 5.5c1.5 0 2.8-.3 4-.9',
    'M11 6.6c.3 0 .7-.1 1-.1 6 0 9.5 5.5 9.5 5.5s-.7 1.2-2 2.5',
  ],
  // 播放模式五态。顺序 = 直行箭头；列表循环 = 双向循环箭头；
  // 随机 = 交叉箭头；带"1"的变体在图形中心补一个小的"1"
  'mode-order': ['M4 12h15', 'M15 7.5 19.5 12 15 16.5'],
  'mode-loop': [
    'M17 3l4 4-4 4',
    'M3 12v-1a4 4 0 0 1 4-4h14',
    'M7 21l-4-4 4-4',
    'M21 12v1a4 4 0 0 1-4 4H3',
  ],
  'mode-repeat-one': [
    'M17 3l4 4-4 4',
    'M3 12v-1a4 4 0 0 1 4-4h14',
    'M7 21l-4-4 4-4',
    'M21 12v1a4 4 0 0 1-4 4H3',
    'M11.4 14.6V10l-1.2.8',
  ],
  'mode-shuffle': [
    'M16 3h5v5',
    'M4 20 21 3',
    'M21 16v5h-5',
    'M15 15l6 6',
    'M4 4l5 5',
  ],
  'mode-shuffle-once': [
    'M16 3h5v5',
    'M4 20 21 3',
    'M21 16v5h-5',
    'M15 15l6 6',
    'M4 4l5 5',
    'M10.4 14.6V10l-1.2.8',
  ],
  // 不喜欢这首：音符 + 斜杠
  'dislike-song': [
    'M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
    'M9 18.5V6l10-2v11.5',
    'M19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
    'M4 4l16 16',
  ],
  // 不喜欢该歌手：人形 + 斜杠
  'dislike-artist': [
    'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M5 20c0-3.3 3.1-6 7-6 1.4 0 2.7.3 3.8.9',
    'M6.8 12.9A7.4 7.4 0 0 0 5 20',
    'M4 4l16 16',
  ],
  // 专属推荐：大小双星（与"发现/收藏"都拉得开）
  sparkles: [
    'M11 4.5l1.7 4.3 4.3 1.7-4.3 1.7L11 16.5 9.3 12.2 5 10.5l4.3-1.7z',
    'M18.3 14.6l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z',
  ],
  // 导入歌单（列表 + 加号）
  'playlist-add': ['M4 6h11', 'M4 11h11', 'M4 16h6', 'M17.5 13.5v6', 'M14.5 16.5h6'],
  // 锚定音源
  anchor: [
    'M12 7.4V21',
    'M7.5 11h9',
    'M4 13.5c.2 4.3 3.8 7.5 8 7.5s7.8-3.2 8-7.5',
    'M12 2.8a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6z',
  ],
  download: ['M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 20h16'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
};

/** 实心图标（播放三角、上一/下一首、已收藏）—— 填充比描边更醒目 */
const FILLED: ReadonlySet<IconName> = new Set<IconName>([
  'play',
  'next',
  'prev',
  'heart-filled',
]);

const filled = computed(() => FILLED.has(props.name));
</script>

<template>
  <svg
    class="neu-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :stroke-width="stroke"
    :fill="filled ? 'currentColor' : 'none'"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, i) in PATHS[props.name]" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.neu-icon {
  display: block;
  flex: none;
  /* 图标跟随文字色，由父级控制 */
  color: inherit;
}
</style>
