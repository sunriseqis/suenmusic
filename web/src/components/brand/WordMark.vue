<script setup lang="ts">
/**
 * 字标：直接用 Gunstop 字体排「SuenMusic」（2026-10-20 起）。
 *
 * 为什么换成字体：自绘折角字标（web/scripts/gen-wordmark-angular.py，
 * 实心多边形 + 45° 切角）用户看了不满意，指定改用这枚字体。它本身是
 * 切角工业风，和 MarkBold 的钣金语言对得上。
 * 字体文件在 web/public/fonts/Gunstop.ttf（@font-face 见 styles/fonts.css）。
 *
 * 拟物处理：不描边不渐变，靠 CSS 的双向 drop-shadow 做「凸起」——
 * 亮侧用 --sl（左上来光）、暗侧用 --sd，与全站拟物语言同一套 token，
 * 因此浅/深色主题自动成立，不需要第二份素材。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 18 });
</script>

<template>
  <span class="wordmark" :style="{ fontSize: `${size}px` }">SuenMusic</span>
</template>

<style scoped>
.wordmark {
  display: block;
  flex: none;
  font-family: 'Gunstop', sans-serif;
  color: var(--t1);
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  /* 凸起：亮侧左上来光（--sl）、暗侧右下投影（--sd） */
  filter: drop-shadow(1.1px 1.1px 1.1px var(--sd)) drop-shadow(-1.1px -1.1px 1.1px var(--sl));
}
</style>
