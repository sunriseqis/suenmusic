<script setup lang="ts">
/**
 * 桌面壳（≥1024px）：左侧边栏 + 内容区 + 底部常驻播放条。
 *
 * 三段式布局用 grid 而不是 flex 拼：底部播放条必须**不随内容滚动**，
 * 用 `100dvh + minmax(0,1fr)` 是最省事且不会溢出的写法。
 * （用 flex 时内容区忘记加 `min-height: 0` 会导致滚动条出现在整个页面上。）
 */
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import BrandLockup from '@/components/brand/BrandLockup.vue';
import NeuIconButton from '@/components/neu/NeuIconButton.vue';
import PlayerBar from '@/components/PlayerBar.vue';
import DesktopFullPlayer from '@/components/DesktopFullPlayer.vue';
import { hasBackend } from '@/api/client.ts';
import { navItems } from './nav.ts';
import { useSessionStore } from '@/stores/session.ts';
import { useUiStore } from '@/stores/ui.ts';

const route = useRoute();
const session = useSessionStore();
const ui = useUiStore();

/** 桌面详情页展开状态（包 A）：点播放条封面/标题展开，ESC 收起 */
const detailOpen = ref(false);

const isActive = (name: string) => route.name === name;

/** 无后端时隐藏「专属」；Web 端同源为后端 */
const items = computed(() => navItems(hasBackend()));
/** 设置单独放在「管理」分组 */
const browseItems = computed(() => items.value.filter(i => i.name !== 'settings'));

/** 侧栏底部显示的服务端主机名（没有配服务端时为空） */
const serverHost = computed(() => {
  const raw = ui.baseUrl.trim();
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, '');
  }
});

/** 主题按钮的图标跟随当前模式 */
const themeIcon = computed(() => {
  if (ui.themeMode === 'system') return 'monitor' as const;
  return ui.themeMode === 'dark' ? ('moon' as const) : ('sun' as const);
});

const themeLabel = computed(() => {
  const map = { system: '跟随系统', light: '浅色', dark: '深色' } as const;
  return `主题：${map[ui.themeMode]}`;
});
</script>

<template>
  <div class="shell neu-bg">
    <aside class="side">
      <div class="brand">
        <BrandLockup />
      </div>

      <nav class="nav" aria-label="主导航">
        <span class="nav-label">浏览</span>
        <router-link
          v-for="item in browseItems"
          :key="item.name"
          :to="`/${item.name === 'home' ? '' : item.name}`"
          class="nav-item"
          :class="{ 'is-on': isActive(item.name) }"
        >
          {{ item.label }}
        </router-link>

        <template v-if="items.some(i => i.name === 'settings')">
          <span class="nav-label nav-label-gap">管理</span>
          <router-link
            to="/settings"
            class="nav-item"
            :class="{ 'is-on': isActive('settings') }"
          >
            设置
          </router-link>
        </template>
      </nav>

      <div class="foot">
        <router-link
          to="/settings"
          class="account-dock neu-inset-sm neu-focusable"
          title="点击进入设置"
        >
          <div class="dock-identity">
            <div class="dock-name-row">
              <span class="dock-name neu-ellipsis">{{ session.displayName }}</span>
              <span class="dock-dot" title="在线" />
            </div>
            <span class="dock-user neu-ellipsis neu-t2">@{{ session.user?.username }}</span>
          </div>

          <div class="dock-action" @click.prevent="ui.cycleTheme()">
            <NeuIconButton
              :icon="themeIcon"
              :label="themeLabel"
              size="sm"
              @click.stop="ui.cycleTheme()"
            />
          </div>
        </router-link>

        <div v-if="serverHost" class="server">
          <span class="neu-ellipsis">{{ serverHost }}</span>
          <b>{{ session.isLoggedIn ? '已连接' : '未登录' }}</b>
        </div>
      </div>
    </aside>

    <main class="main neu-scroll">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>

    <footer class="player">
      <PlayerBar @expand="detailOpen = true" />
    </footer>

    <DesktopFullPlayer v-if="detailOpen" @close="detailOpen = false" />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  /* 侧边栏固定宽，内容自适应，播放条整行 */
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    'side main'
    'player player';
  /* 用 dvh 而不是 vh：移动端浏览器地址栏收放时 vh 会跳 */
  height: 100dvh;
  overflow: hidden;
}

.side {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: var(--sp-5) var(--sp-4);
  /* 侧边栏与主区同底色，靠 1px 发丝线分界 */
  border-right: 1px solid var(--line);
}


/* 品牌铭牌：与导航项**等宽并居中**（用户反馈原来窄一圈、看着小） */
.brand {
  display: flex;
  justify-content: center;
}
.brand :deep(.lockup) {
  width: 100%;
  justify-content: center;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-label {
  padding: 0 10px 8px;
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--t3);
}
.nav-label-gap {
  margin-top: 18px;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--r-md);
  color: var(--t2);
  font-size: 13px;
  letter-spacing: 0.02em;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease);
}
.nav-item:hover {
  color: var(--t1);
}
.nav-item.is-on {
  color: var(--t1);
  background: var(--panel-2);
  box-shadow: inset 0 1px 0 var(--hi);
}
.nav-item.is-on::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 2px;
  background: var(--accent);
}
.server {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 0 10px;
  font-size: 10px;
  color: var(--t3);
  font-variant-numeric: tabular-nums;
}
.server b {
  font-weight: 400;
  color: var(--t2);
}

.foot {
  margin-top: auto;
}
.account-dock {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-2-5, 10px) var(--sp-3, 12px);
  border-radius: var(--r-lg);
  text-decoration: none;
  cursor: pointer;
  transition: all 0.15s ease;
}
.account-dock:hover {
  background: var(--panel-2);
}
.dock-identity {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.dock-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dock-name {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  color: var(--t1);
  line-height: 1.3;
}
.dock-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 4px var(--accent);
  flex-shrink: 0;
}
.dock-user {
  font-size: var(--fs-xs);
  line-height: 1.3;
}
.dock-action {
  flex-shrink: 0;
}

.main {
  grid-area: main;
  min-height: 0;
  min-width: 0;
}

.player {
  grid-area: player;
  z-index: var(--z-player);
}
</style>
