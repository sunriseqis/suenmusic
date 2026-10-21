<script setup lang="ts">
/**
 * 品牌锁定组合：图标 + 字标共用**一块**拟物凸起底板。
 *
 * 为什么要合并：之前徽标自带一块凸起底板、字标又各自做凸起投影，
 * 两者是"两块贴在一起的面"，中间那道缝把品牌切成了两半。
 * 收进同一块面板后，成为机身上的一枚整体铭牌，也和侧边栏的
 * 其它拟物元件（导航项、按钮）在同一层次上。
 *
 * 面板内部保持"凸起面板 + 凸起文字"的同向关系（都是左上来光），
 * 视觉上才有厚度，而不是文字被压进面板里。
 */
import MarkBold from './MarkBold.vue';
import WordMark from './WordMark.vue';
import NeuSurface from '@/components/neu/NeuSurface.vue';

const props = withDefaults(
  defineProps<{
    size?: 'md' | 'lg';
    /**
     * 不要凸起底板（登录页用）。
     *
     * 底板是给侧边栏准备的"机身铭牌"——和导航项同层。登录页上空旷背景里
     * 一块悬着的凸起面板很突兀（用户反馈"LOGO 和品牌名不要凸起背景"）。
     */
    flat?: boolean;
  }>(),
  { size: 'md', flat: false }
);

/** 两档尺寸：md 给侧边栏，lg 给登录页（登录页要撑起整张卡片的分量） */
const DIMS = {
  /**
   * md 给侧边栏。
   *
   * ⚠️ MarkBold 的字形在 viewBox(8000) 里只占约 70%（X:-802~4800 / Y:-964~6024），
   * 四周有 ~30% 留白 —— 之前 mark 配 24px，实际字形只有 ~17px，
   * 底板颜色又与网页背景接近，视觉上就是"LOGO 极小"。
   * 现在 mark 提到 34（字形有效 ≈24px），面板同步放大到 52。
   */
  md: { height: 52, padX: 10, gap: 10, mark: 34, word: 19 },
  lg: { height: 64, padX: 16, gap: 12, mark: 38, word: 22 },
} as const;

const dim = DIMS[props.size];
</script>

<template>
  <NeuSurface
    v-if="!flat"
    variant="raised-md"
    radius="lg"
    padding="none"
    class="lockup"
    :style="{ height: `${dim.height}px`, padding: `0 ${dim.padX}px`, gap: `${dim.gap}px` }"
  >
    <!-- 实心折角 S：不要自带底板（lockup 已有一块整体铭牌），段 0 染琥珀 -->
    <MarkBold :size="dim.mark" bare :accent-index="0" />
    <WordMark :size="dim.word" />
  </NeuSurface>

  <div
    v-else
    class="lockup lockup-flat"
    :style="{ height: `${dim.height}px`, padding: `0 ${dim.padX}px`, gap: `${dim.gap}px` }"
  >
    <MarkBold :size="dim.mark" bare :accent-index="0" />
    <WordMark :size="dim.word" />
  </div>
</template>

<style scoped>
.lockup {
  display: inline-flex;
  align-items: center;
  flex: none;
}
</style>

<style scoped>
.lockup-flat {
  display: flex;
  align-items: center;
}
</style>
