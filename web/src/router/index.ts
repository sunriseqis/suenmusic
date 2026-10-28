import { createRouter, createWebHistory } from 'vue-router';
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
     * 酷狗验证页。
     *
     * 链接（/verify/kugou?t=…）由移动端通知带进**手机系统浏览器**直接打开，
     * 那里没有登录态，所以：meta.public 让守卫放行，页面只认 URL 上的 t。
     */
    path: '/verify/kugou',
    name: 'kugou-verify',
    component: () => import('@/views/KugouVerify.vue'),
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
 * 全端统一路由守卫。
 *
 * 服务端单一真相源架构：所有平台（Web、iOS、Android、鸿蒙）数据与流均依赖服务端。
 * 1. 启动必须等 bootstrap() 完成（离线弱网下由 refreshSession/restoreCachedUser 恢复登录态）；
 * 2. 公开页面（如 /login）直接放行；若已登录还进 /login 则回首页；
 * 3. 未登录一律拦截去 /login，带上 redirect 方便登录后回跳。
 */
router.beforeEach(async to => {
  /**
   * 验证页放行，且**不等 bootstrap**：
   * 它会被手机系统浏览器直接打开，那里的访客没有登录态可恢复，
   * 等待 sessionMe 只会在弱网下白等几秒，甚至卡在加载态。
   */
  if (to.name === 'kugou-verify') return true;

  const session = useSessionStore();

  if (!session.bootstrapped) {
    await session.bootstrap();
  }

  // 公开页放行
  if (to.meta.public) {
    if (to.name === 'login' && session.isLoggedIn) {
      return { name: 'home' };
    }
    return true;
  }

  // 未登录全端拦截（Web / Android / iOS / 鸿蒙统一）
  if (!session.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  return true;
});

/**
 * 标签标题**不按路由变化**（2026-09-12 用户拍板，只有两种形态）：
 *   无播放 → `SuenMusic`；有播放 → `正在播放 <歌名>`。
 * 由 App.vue 监听播放器状态统一设置，见 src/App.vue。
 */
