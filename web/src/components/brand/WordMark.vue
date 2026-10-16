<script setup lang="ts">
/**
 * 字标（2026-09-12 定稿）：统一笔宽的圆头笔画「SuenMusic」。
 *
 * 为什么不用字体：整套品牌里 LOGO 是粗圆头线条，用普通字体的文字配不上它；
 * 而自绘**细**单线字标试过一版、字形不达标。最终走中间路线 ——
 * 保留与图标音浪完全一致的线条语言（统一笔宽 + round cap），字形用几何构造
 * （圆弧/折线），笔画够粗，细节瑕疵在这种风格里不显眼。
 *
 * 拟物处理：不描边不渐变，靠 CSS 的双向 drop-shadow 做「凸起」——
 * 亮侧用 --sl（左上来光）、暗侧用 --sd，与全站拟物语言同一套 token，
 * 因此浅/深色主题自动成立，不需要第二份素材。
 *
 * 源文件与参数在 web/scripts/gen-wordmark.py（改字形后重跑生成）。
 */
withDefaults(defineProps<{ height?: number }>(), { height: 22 });
</script>

<template>
  <svg
    class="wordmark"
    :height="height"
    :width="Math.round(height * 4.258)"
    viewBox="-8.0 -8.0 255.5 60.0"
    role="img"
    aria-label="SuenMusic"
  >
    <g fill="none" stroke="currentColor" stroke-width="8.0"
       stroke-linecap="round" stroke-linejoin="round">
      <path transform="translate(0.00 0)" d="M 20 10.5 C 20 6.5 16.5 4 11.5 4 C 6.5 4 3 7 3 11 C 3 15 6.5 17 11.5 18.5 C 16.5 20 20 22.5 20 26.5 C 20 30.5 16.5 36 11.5 36 C 6.5 36 3 33 3 29" />
      <path transform="translate(30.00 0)" d="M 4 18 V 27.5 A 6.5 6.5 0 0 0 17 27.5 V 18" />
      <path transform="translate(58.00 0)" d="M 2 26 H 20 A 9 9 0 1 0 16.8 32.9" />
      <path transform="translate(87.00 0)" d="M 4 36 V 18 M 4 25 A 6.5 6.5 0 0 1 17 25 V 36" />
      <path transform="translate(115.00 0)" d="M 4.5 36 V 9.5 L 15 26 L 25.5 9.5 V 36" />
      <path transform="translate(152.00 0)" d="M 4 18 V 27.5 A 6.5 6.5 0 0 0 17 27.5 V 18" />
      <path transform="translate(180.00 0)" d="M 17 21.5 C 17 18.5 14 16.8 9.8 16.8 C 5.8 16.8 3 18.9 3 21.8 C 3 24.6 5.9 25.9 9.8 26.9 C 13.7 27.9 17 29.3 17 31.9 C 17 34.8 14.2 36.8 9.8 36.8 C 5.9 36.8 3 35.1 3 32.2" />
      <path transform="translate(207.00 0)" d="M 2.25 18 V 36" />
      <path transform="translate(218.50 0)" d="M 18 21.5 A 7.5 7.5 0 1 0 18 30.5" />
    </g>
    <g fill="currentColor">
      <circle cx="209.25" cy="6.80" r="4.0" />
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
