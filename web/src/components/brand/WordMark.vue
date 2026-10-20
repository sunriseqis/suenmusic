<script setup lang="ts">
/**
 * 字标（2026-10-20 重画）：折角钣金「SuenMusic」，与 MarkBold 同一语言。
 *
 * 与旧版（2026-09-12 圆头描边）的区别：
 *   · 实心笔画 —— 每条骨架线由 stroker 生成多边形，不再是 stroke
 *   · 端头 45° 切角、转角尖接，全部直线段，没有圆弧
 * 这样它和侧边栏那枚实心折角 S 是同一套钣金语言。
 *
 * 拟物处理：不描边不渐变，靠 CSS 的双向 drop-shadow 做「凸起」——
 * 亮侧用 --sl（左上来光）、暗侧用 --sd，与全站拟物语言同一套 token，
 * 因此浅/深色主题自动成立，不需要第二份素材。
 *
 * 源文件与参数在 web/scripts/gen-wordmark-angular.py（改字形后重跑
 * write-wordmark-assets.py 生成本文件与 docs/icon 资产）。
 */
withDefaults(defineProps<{ height?: number }>(), { height: 22 });
</script>

<template>
  <svg
    class="wordmark"
    :height="height"
    :width="Math.round(height * 4.283)"
    viewBox="-8.0 -8.0 257.0 60.0"
    role="img"
    aria-label="SuenMusic"
  >
    <g fill="currentColor">
      <path transform="translate(0.00 0)" d="M 22.00 4.00 L 14.00 12.00 L 6.00 12.00 L 6.00 17.23 L 22.00 23.23 L 22.00 36.00 L 2.00 36.00 L -2.00 36.00 L 6.00 28.00 L 14.00 28.00 L 14.00 28.77 L -2.00 22.77 L -2.00 4.00 L 18.00 4.00 Z"/>
      <path transform="translate(29.00 0)" d="M 0.00 14.00 L 8.00 22.00 L 8.00 32.00 L 13.00 32.00 L 13.00 18.00 L 13.00 14.00 L 21.00 22.00 L 21.00 40.00 L 0.00 40.00 L 0.00 18.00 Z"/>
      <path transform="translate(57.00 0)" d="M 15.00 29.00 L 7.00 37.00 L 0.00 37.00 L 0.00 17.00 L 22.00 17.00 L 22.00 33.00 L 22.00 37.00 L 14.00 29.00 L 14.00 25.00 L 8.00 25.00 L 8.00 29.00 L 11.00 29.00 Z"/>
      <path transform="translate(57.00 0)" d="M -4.00 31.00 L 4.00 23.00 L 22.00 23.00 L 26.00 23.00 L 18.00 31.00 L 0.00 31.00 Z"/>
      <path transform="translate(88.00 0)" d="M 8.00 40.00 L 0.00 32.00 L 0.00 14.00 L 21.00 14.00 L 21.00 36.00 L 21.00 40.00 L 13.00 32.00 L 13.00 22.00 L 8.00 22.00 L 8.00 36.00 Z"/>
      <path transform="translate(116.00 0)" d="M 8.50 40.00 L 0.50 32.00 L 0.50 8.00 L 7.84 5.81 L 15.00 16.71 L 22.16 5.81 L 29.50 8.00 L 29.50 36.00 L 29.50 40.00 L 21.50 32.00 L 21.50 8.00 L 28.84 10.19 L 15.00 31.29 L 1.16 10.19 L 8.50 8.00 L 8.50 36.00 Z"/>
      <path transform="translate(153.00 0)" d="M 0.00 14.00 L 8.00 22.00 L 8.00 32.00 L 13.00 32.00 L 13.00 18.00 L 13.00 14.00 L 21.00 22.00 L 21.00 40.00 L 0.00 40.00 L 0.00 18.00 Z"/>
      <path transform="translate(181.00 0)" d="M 21.00 15.00 L 13.00 23.00 L 7.00 23.00 L 7.00 23.82 L 19.16 31.64 L 17.00 39.00 L 3.00 39.00 L -1.00 39.00 L 7.00 31.00 L 17.00 31.00 L 14.84 38.36 L -1.00 28.18 L -1.00 15.00 L 17.00 15.00 Z"/>
      <path transform="translate(208.00 0)" d="M -1.50 14.00 L 6.50 22.00 L 6.50 36.00 L 6.50 40.00 L -1.50 32.00 L -1.50 18.00 Z"/>
      <path transform="translate(220.00 0)" d="M 21.00 15.00 L 13.00 23.00 L 7.00 23.00 L 7.00 31.00 L 17.00 31.00 L 21.00 31.00 L 13.00 39.00 L -1.00 39.00 L -1.00 15.00 L 17.00 15.00 Z"/>
      <path transform="translate(210.50 10.00)" d="M -2.75 -2.75 L 2.75 -2.75 L 2.75 2.75 L -2.75 2.75 Z"/>
    </g>
  </svg>
</template>

<style scoped>
.wordmark {
  display: block;
  flex: none;
  color: var(--t1);
  /* 凸起：亮侧左上来光（--sl）、暗侧右下投影（--sd） */
  filter: drop-shadow(1.1px 1.1px 1.1px var(--sd)) drop-shadow(-1.1px -1.1px 1.1px var(--sl));
}
</style>
