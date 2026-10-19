import { createRouter, createWebHistory } from 'vue-router';
import { hasBackend, isWebPlatform } from '@/api/client.ts';
import type { RouteRecordRaw } from 'vue-router';
import { useSessionStore } from '@/stores/session.ts';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/Home.vue'),
  },
  {
    path: '/daily',
    name: 'daily',
    component: () => import('@/views/Daily.vue'),
  },
  {
    path: '/favorites',
    name: 'favorites',
    component: () => import('@/views/Favorites.vue'),
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/Search.vue'),
  },
  {
    /**
     * 一个组件承载四种集合：榜单 / QQ 歌单 / 专辑 / 歌手。
     * 它们的交互完全一致（标题 + 曲目列表 + 播放全部），
     * 拆成四个文件只会重复四遍同样的模板。
     */
    path: '/c/:kind(toplist|playlist|album|artist)/:id',
    name: 'collection',
    component: () => import('@/views/Collection.vue'),
    props: true,
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/Settings.vue'),
  },
  {
    /**
     * 无后端直连诊断页。
     *
     * 必须 meta.public —— 它的整个用途就是"没有服务端、也没登录"时能不能用。
     * 走登录守卫的话它永远打不开，等于自证不了。
     */
    path: '/probe',
    name: 'probe',
    component: () => import('@/views/DirectProbe.vue'),
    meta: { public: true },
  },
  {
    // 兜底：不认识的地址回首页，而不是白屏
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, from, saved) {
    // 浏览器前进/后退时恢复原滚动位置，其余情况回到顶部
    if (saved) return saved;
    if (to.path === from.path) return {};
    return { top: 0 };
  },
});

/**
 * 路由守卫。
 *
 * **直连架构下这里不再拦人。**
 *
 * 旧逻辑是"未登录 → 一律踢到 /login"，前提是"服务端是唯一的数据源"。
 * 现在收藏/历史/不喜欢都在本机，搜索和播放走客户端直连上游，
 * 登录只是一个**可选增强**（多端同步、AI、高音质凭据）。
 * 继续拦的话，装完 app 第一眼就是登录页 —— 既违背"开箱即用"，
 * 也会让应用商店审核看到"必须先有服务器才能用"。
 *
 * 仍然保留 `bootstrap()` 的等待：刷新页面时它还是 false，而静默续期是异步的。
 * 不等的话，已登录用户一刷新会先闪一下"未登录"的界面。
 */
router.beforeEach(async to => {
  const session = useSessionStore();

  if (!session.bootstrapped) {
    await session.bootstrap();
  }

  // 直连模式没有「专属」：地址栏直达也送回首页，避免一个必然失败的页面
  if (to.name === 'daily' && !hasBackend()) {
    return { name: 'home' };
  }

  // Web 是后端的一部分，必须有登录守卫；原生壳保留"没配服务端也能用"
  if (isWebPlatform) {
    if (to.name === 'login') {
      return session.isLoggedIn ? { name: 'home' } : true;
    }
    if (!session.isLoggedIn) {
      return { name: 'login', query: { redirect: to.fullPath } };
    }
  }

  return true;
});

/**
 * 标签标题**不按路由变化**（2026-09-12 用户拍板，只有两种形态）：
 *   无播放 → `SuenMusic`；有播放 → `正在播放 <歌名>`。
 * 由 App.vue 监听播放器状态统一设置，见 src/App.vue。
 */
