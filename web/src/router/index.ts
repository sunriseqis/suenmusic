import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { useSessionStore } from '@/stores/session.ts';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    // 公开页：未登录也能进
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
 * 登录守卫。
 *
 * **必须等 `bootstrapped`**：刷新页面时 bootstrapped 还是 false，
 * 而静默续期是异步的。不等的话，用户刚刷新就被踹到登录页，
 * 然后续期成功又得自己走回来 —— 典型的"闪一下登录页" bug。
 */
router.beforeEach(async to => {
  const session = useSessionStore();

  if (!session.bootstrapped) {
    await session.bootstrap();
  }

  if (to.name === 'login') {
    // 已登录还去登录页就直接送回首页
    if (session.isLoggedIn) return { name: 'home' };
    return true;
  }

  if (to.meta.public) {
    return true;
  }

  if (!session.isLoggedIn) {
    // 记下原本要去哪，登录后能回去
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }

  return true;
});

/**
 * 标签标题**不按路由变化**（2026-09-12 用户拍板，只有两种形态）：
 *   无播放 → `SuenMusic`；有播放 → `正在播放 <歌名>`。
 * 由 App.vue 监听播放器状态统一设置，见 src/App.vue。
 */
