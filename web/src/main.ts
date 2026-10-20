/**
 * 应用入口。
 *
 * 装配顺序有讲究：pinia 必须**先于** router 安装 —— 路由守卫里要用到
 * session store，而 store 需要已经激活的 pinia 实例。
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';

// 思源黑体（Noto Sans SC，SIL OFL，本地托管无外链）。
// fontsource 版按 unicode-range 切了 100+ 分片，浏览器只下载页面实际
// 用到的分片（font-display: swap，加载期间先渲染系统字体）。
// 部署包里会带全字集 woff2 分片（~7.6MB），运行时首载通常 <500KB —— 这是
// 与计划里"总体积 2-3MB"的刻意偏差：自维护 3500 字子集的长期成本
// （字表维护/生僻字回落）高于多占的磁盘，自用部署磁盘不敏感。
// @font-face 由 scripts/gen-fonts-css.mjs 生成（砍掉了 woff 回退的 9.4MB）。
import './styles/fonts.css';

import './styles/tokens.css';
import './styles/base.css';
import './styles/neu.css';

import App from './App.vue';
import { router } from './router/index.ts';
import { installBackBridge } from './native/back.ts';
import { onAuthLost } from './api/client.ts';
import { onNetworkEnvironmentChanged, selectBestServer } from './api/servers.ts';
import { useSessionStore } from './stores/session.ts';
import { usePlayerStore, registerGlobalAudioControl } from './stores/player.ts';
import { useFavoritesStore } from './stores/favorites.ts';
import { useUiStore } from './stores/ui.ts';
import { useLyricsStore } from './stores/lyrics.ts';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

registerGlobalAudioControl();

const ui = useUiStore();
const session = useSessionStore();
const lyrics = useLyricsStore();
lyrics.init();

// 主题要在挂载前定下，减少闪烁（index.html 里的内联脚本只管到 data-theme，
// 这里把后续的系统主题跟随接上）
ui.initTheme();
ui.initBreakpoint();

// 让 client 内部的令牌变化能反映到 store
session.install();

// 返回手势分发器：原生侧（MainActivity）靠它决定这次返回该给页面、给历史还是退出
installBackBridge();

/**
 * 会话彻底失效（刷新令牌也过期/被吊销）时的收尾。
 *
 * 放在这里而不是请求层，是因为它需要同时操作 store、路由和提示 ——
 * 请求层不该知道路由的存在。
 */
onAuthLost(reason => {
  const player = usePlayerStore();
  const favorites = useFavoritesStore();
  session.markLoggedOut();
  // 播放队列属于上一个账号，必须清掉
  player.reset();
  // 收藏的红心集合同理
  favorites.reset();

  // 不再跳登录页：没有守卫，登录只从设置页的弹层发起。
  // 这里只负责清状态并告知原因，用户留在原地继续本地播放。
  ui.err(reason.message || '登录已失效，请重新登录');
});

/**
 * 启动时按优先级探测并选中最佳路径。
 *
 * 此刻切换代价最小（没有正在进行的播放），效果是"在家自动走内网、出门自动走公网"。
 * 运行期网络环境变化时快速重选，请求失败时由 client 的 failover 钩子兜底切换。
 */
void selectBestServer();

// 网络状态变化（恢复联网/切换 Wi-Fi/蜂窝）是重新选路的天然时机
window.addEventListener('online', () => {
  void onNetworkEnvironmentChanged();
});

app.mount('#app');
