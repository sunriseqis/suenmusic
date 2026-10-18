<script setup lang="ts">
/**
 * 移动壳（<1024px）：内容区 + 底部导航 + 迷你播放条 + 全屏播放页。
 *
 * 迷你播放条**叠在导航之上**而不是并排 —— 手机竖屏的垂直空间很宝贵，
 * 并排会吃掉两行高度，而叠放时页面滚到底部会自然让位。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute } from 'vue-router';
import PlayerBar from '@/components/PlayerBar.vue';
import FullPlayer from '@/components/FullPlayer.vue';
import { registerBackHandler } from '@/native/back.ts';
import { navItems } from './nav.ts';
import { usePlayerStore } from '@/stores/player.ts';
import { useSessionStore } from '@/stores/session.ts';
import { useUiStore } from '@/stores/ui.ts';

const route = useRoute();
const player = usePlayerStore();
const session = useSessionStore();
const ui = useUiStore();

const isActive = (name: string) => route.name === name;

/** 直连模式隐藏「专属」 */
const items = computed(() => navItems(!!ui.baseUrl.trim()));

/** 全屏播放页是否展开 */
const fullOpen = ref(false);

/**
 * 返回手势：全屏播放页开着就先关它（这就是安卓上"从哪来回哪去"的一层）。
 * 页面自己的处理器注册得更晚、优先级更高，所以收藏里的筛选态会先被吃掉。
 */
const offBack = registerBackHandler(() => {
  if (!fullOpen.value) return false;
  fullOpen.value = false;
  return true;
});
onBeforeUnmount(offBack);

// 搜索页自己带输入框，底部导航照常保留（它是全局导航，不该随页面变）
</script>

<template>
  <div class="shell neu-bg">
    <main class="main neu-scroll">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>

      <!-- 内容末尾留白，避免最后一行被迷你播放条与导航盖住 -->
      <div class="tail" :class="{ 'has-mini': !!player.currentTrack }" aria-hidden="true" />
    </main>

    <!-- 迷你播放条：只在有当前曲目时出现。
         外层容器命名为 mini-dock 而不是 mini —— PlayerBar 紧凑形态的根元素
         本身就叫 .mini，两者同名会让选择器与样式的作用范围变得含混 -->
    <div v-if="player.currentTrack" class="mini-dock">
      <PlayerBar compact @expand="fullOpen = true" />
    </div>

    <nav class="tabbar" aria-label="主导航">
      <router-link
        v-for="item in items"
        :key="item.name"
        :to="`/${item.name === 'home' ? '' : item.name}`"
        class="tab neu-focusable"
        :class="{ active: isActive(item.name) }"
        :aria-current="isActive(item.name) ? 'page' : undefined"
      >
        <span class="tab-label">{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- 全屏播放页 -->
    <Transition name="sheet">
      <FullPlayer v-if="fullOpen" @close="fullOpen = false" />
    </Transition>

    <!-- 用户名在移动端只出现在设置页，这里不做展示，避免占用导航高度 -->
    <span class="neu-sr">{{ session.displayName }}</span>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  height: 100dvh;
  overflow: hidden;
}

.main {
  min-height: 0;
  min-width: 0;
  position: relative;
  /* 让出状态栏高度：edge-to-edge 下内容会画到透明状态栏底下（真机实测） */
  padding-top: var(--safe-top);
  /* 移动端不显示滚动条：触摸滚动照常，视觉与原生 App 一致（用户点名） */
  scrollbar-width: none;
}
.main::-webkit-scrollbar {
  display: none;
}

.tail {
  height: calc(var(--mobile-nav-h) + var(--sp-5) + var(--safe-bottom));
}
.tail.has-mini {
  /* 迷你条约 58px */
  height: calc(var(--mobile-nav-h) + 58px + var(--sp-5) + var(--safe-bottom));
}

.mini-dock {
  /* 浮在导航上方 */
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(var(--mobile-nav-h) + var(--safe-bottom));
  z-index: var(--z-player);
  padding: 0 var(--sp-3);
}

/* N1 导轨选择器：整条导航是凹槽，活动项是滑到位的滑块 */
.tabbar {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 3px;
  margin: 6px 10px calc(6px + var(--safe-bottom));
  padding: 3px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: inset 0 2px 7px var(--lo);
  z-index: var(--z-nav);
}

.tab {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--t2);
  text-decoration: none;
  border-radius: calc(var(--r-md) - 3px);
  /* 触摸目标：整个 tab 都是，远超 44px */
  min-height: 44px;
  /* 底部留出指示条的位置，否则琥珀条会压在文字上 */
  padding: 0 0 8px;
  transition:
    color var(--dur-fast) var(--ease),
    background-color var(--dur-fast) var(--ease);
}
.tab:hover {
  text-decoration: none;
}

.tab.active {
  color: var(--t1);
  font-weight: var(--fw-medium);
  background: var(--panel-2);
  box-shadow: inset 0 1px 0 var(--hi);
}

/* 琥珀只做指示条，不承担状态色 */
.tab.active::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 4px;
  width: 12px;
  height: 2px;
  background: var(--accent);
  transform: translateX(-50%);
}

.tab-label {
  font-size: 12px;
  letter-spacing: 0.08em;
  line-height: 1;
}

/* 全屏播放页从底部推上来 */
.sheet-enter-active,
.sheet-leave-active {
  transition: transform var(--dur-slow) var(--ease);
}
.sheet-enter-from,
.sheet-leave-to {
  transform: translateY(100%);
}
</style>
