<script setup lang="ts">
/**
 * 品牌标记：横向音浪（2026-09-12 定稿的 H1 形态）。
 *
 * 两个形态各司其职：
 *   - `tile`：圆角瓦片 + 白色音浪。用于 favicon / 安卓启动图标 / 侧边栏徽标，
 *     瓦片填充跟随 CSS `color`（应用内即强调色）。
 *   - `glyph`：只有音浪，线条跟随 `color`。用于需要单色标记的场合
 *     （浅色/深色底、未来安卓单色主题图标）。
 *
 * 线条是 2 个半波的正弦近似（控制点取 4A/3），等比横置后比如竖置更舒展。
 */
withDefaults(defineProps<{ size?: number; variant?: 'tile' | 'glyph' }>(), {
  size: 20,
  variant: 'tile',
});

const WAVE = 'M12 32C18.67 41.33 25.33 41.33 32 32C38.67 22.67 45.33 22.67 52 32';
/**
 * glyph 用**紧贴波形**的 viewBox：波形在 64 方框里上下留白很大（y 21.8~42.2），
 * 直接沿用方框会让标记在拟物底板里显得又小又空。收紧后波形铺满宽度，
 * 高度按比例（约 2.26:1），在方形底座里居中即是最舒展的形态。
 */
const GLYPH_VIEWBOX = '8.9 21.8 46.2 20.4';
</script>

<template>
  <svg
    class="logo-mark"
    :width="size"
    :height="size"
    :viewBox="variant === 'glyph' ? GLYPH_VIEWBOX : '0 0 64 64'"
    role="img"
    aria-label="SuenMusic"
  >
    <rect v-if="variant === 'tile'" x="2" y="2" width="60" height="60" rx="19" fill="currentColor" />
    <path
      :d="WAVE"
      fill="none"
      :stroke="variant === 'tile' ? '#ffffff' : 'currentColor'"
      stroke-width="6.2"
      stroke-linecap="round"
    />
  </svg>
</template>

<style scoped>
.logo-mark {
  display: block;
  flex: none;
  /*
   * 默认跟随强调色。必须由组件自己声明：标记用 currentColor 取色，
   * 若等父级继承，登录卡片/侧边栏的文字色（--t1 深色）会把瓦片染成深蓝
   * ——实测踩过。父级要覆盖时用更高优先级的 color 覆盖即可。
   */
  color: var(--accent);
}
</style>
