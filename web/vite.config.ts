import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

/**
 * 读取 server/.env（若存在），让前后端共用同一份开发配置：
 * 在 server/.env 里把 SUENMUSIC_HOST 改成 0.0.0.0 后，
 * 前端 dev server 也随之对局域网开放，不用再单独配前端。
 * 已存在的进程环境变量优先，文件不会覆盖。
 */
function loadServerEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(fileURLToPath(new URL('../server/.env', import.meta.url)), 'utf8');
  } catch {
    return; // server/.env 不存在（纯前端环境）时静默跳过
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m?.[1] || !m[2]) continue;
    const key: string = m[1];
    const value: string = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadServerEnv();

/**
 * 服务端地址。改 server/.env 的 SUENMUSIC_BACKEND 或用同名环境变量覆盖。
 * 注意：这只是**开发期**的代理目标。生产环境前端是纯静态文件，
 * 基地址由设置页写在 localStorage 里（PLAN.md 5.4）。
 */
const BACKEND = process.env.SUENMUSIC_BACKEND || 'http://127.0.0.1:3210';

/**
 * 前端开发服务器监听地址。默认跟随 SUENMUSIC_HOST（server/.env）——
 * 「服务端对局域网开放时，前端同样开放」；SUENMUSIC_WEB_HOST 可单独覆盖。
 */
const HOST = process.env.SUENMUSIC_WEB_HOST || process.env.SUENMUSIC_HOST || '127.0.0.1';

/**
 * 演示用的假 API（仅开发期，SUEN_MOCK=1 时生效）。
 *
 * 设备访问不到开发机上的独立端口，所以把假数据挂在 dev server 的 /api 下：
 * 应用里把服务端地址填成 `http://<开发机 IP>:5273` 即可看到全部设置项。
 */
function mockApiPlugin(): Plugin {
  const now = Date.now();
  const fixtures: Record<string, unknown> = {
    '/api/auth/config': {
      registrationOpen: true,
      allowRegistration: true,
      hasUsers: true,
      passwordMinLength: 6,
    },
    '/api/auth/me': {
      user: { id: 'u_demo', username: 'demo', displayName: '演示账号', role: 'admin' },
    },
    '/api/auth/sessions': {
      sessions: [
        { id: 's1', createdAt: now - 2 * 864e5, lastUsedAt: now - 36e5, expiresAt: now + 30 * 864e5, userAgent: 'Android 16 · 本机', isCurrent: true },
        { id: 's2', createdAt: now - 9 * 864e5, lastUsedAt: now - 3 * 864e5, expiresAt: now + 21 * 864e5, userAgent: 'Chrome · Windows', isCurrent: false },
      ],
    },
    '/api/bilibili/account': { loggedIn: true, uname: '哔哩哔哩演示账号', mid: 1234567 },
    '/api/netease/account': { loggedIn: false },
    '/api/ai/models': {
      profiles: [
        { id: 'm1', name: '主模型', baseUrl: 'http://127.0.0.1:8904/v1', apiKeyMasked: 'sk-****demo', hasApiKey: true, model: 'glm-5.3-flash' },
        { id: 'm2', name: '复核模型', baseUrl: 'http://127.0.0.1:8904/v1', apiKeyMasked: 'sk-****demo', hasApiKey: true, model: 'glm-5.3' },
      ],
      decideProfileId: 'm1',
      reviewProfileId: 'm2',
    },
    '/api/ai/persona': {
      summary: '偏好人声与华语流行，夜晚更常听抒情人声。',
      profileLines: ['华语流行 62%', '人声优先', '夜间时段活跃'],
      ledgerLines: ['收藏 12 首', '不喜欢 2 首'],
      lastGuidance: '少一点电音',
      updatedAt: now - 864e5,
    },
    /**
     * 每日专属推荐：给「不喜欢按钮 + 推荐理由卡片」一个可看的场景。
     * 没有这一条时，假服务端的专属页只会是空态，播放页那张卡永远出不来。
     */
    '/api/home': {
      welcomePhrase: '今晚听点安静的',
      newAlbums: [
          { id: 'qq_al_1', mid: 'al_1', name: '示例专辑 1', picUrl: '', publishTime: '2026-10-11', description: '', company: '示例唱片', type: '专辑', size: 1, artists: [{ id: 'qq_ar_1', mid: 'ar_1', name: '歌手 1', picUrl: '' }], artist: { name: '歌手 1' } },
          { id: 'qq_al_2', mid: 'al_2', name: '示例专辑 2', picUrl: '', publishTime: '2026-10-12', description: '', company: '示例唱片', type: '专辑', size: 1, artists: [{ id: 'qq_ar_2', mid: 'ar_2', name: '歌手 2', picUrl: '' }], artist: { name: '歌手 2' } },
          { id: 'qq_al_3', mid: 'al_3', name: '示例专辑 3', picUrl: '', publishTime: '2026-10-13', description: '', company: '示例唱片', type: '专辑', size: 1, artists: [{ id: 'qq_ar_3', mid: 'ar_3', name: '歌手 3', picUrl: '' }], artist: { name: '歌手 3' } },
          { id: 'qq_al_4', mid: 'al_4', name: '示例专辑 4', picUrl: '', publishTime: '2026-10-14', description: '', company: '示例唱片', type: '专辑', size: 1, artists: [{ id: 'qq_ar_4', mid: 'ar_4', name: '歌手 4', picUrl: '' }], artist: { name: '歌手 4' } }
      ],
      newSongs: [
          { id: 'qq_home_1', mid: 'home_1', name: '示例歌曲 1', ar: [{ id: 'qq_ar_1', mid: 'ar_1', name: '歌手 1', picUrl: '' }], artists: [{ id: 'qq_ar_1', mid: 'ar_1', name: '歌手 1', picUrl: '' }], al: { id: 'qq_al_1', mid: 'al_1', name: '示例专辑 1', picUrl: '' }, album: { id: 'qq_al_1', name: '示例专辑 1', picUrl: '' }, dt: 240000, duration: 240, playable: true, matched: true, privilege: { playMaxbr: 320000, maxbr: 320000, freeTrialPrivilege: { resConsumable: false } } },
          { id: 'qq_home_2', mid: 'home_2', name: '示例歌曲 2', ar: [{ id: 'qq_ar_2', mid: 'ar_2', name: '歌手 2', picUrl: '' }], artists: [{ id: 'qq_ar_2', mid: 'ar_2', name: '歌手 2', picUrl: '' }], al: { id: 'qq_al_2', mid: 'al_2', name: '示例专辑 2', picUrl: '' }, album: { id: 'qq_al_2', name: '示例专辑 2', picUrl: '' }, dt: 240000, duration: 240, playable: true, matched: true, privilege: { playMaxbr: 320000, maxbr: 320000, freeTrialPrivilege: { resConsumable: false } } },
          { id: 'qq_home_3', mid: 'home_3', name: '示例歌曲 3', ar: [{ id: 'qq_ar_3', mid: 'ar_3', name: '歌手 3', picUrl: '' }], artists: [{ id: 'qq_ar_3', mid: 'ar_3', name: '歌手 3', picUrl: '' }], al: { id: 'qq_al_3', mid: 'al_3', name: '示例专辑 3', picUrl: '' }, album: { id: 'qq_al_3', name: '示例专辑 3', picUrl: '' }, dt: 240000, duration: 240, playable: true, matched: true, privilege: { playMaxbr: 320000, maxbr: 320000, freeTrialPrivilege: { resConsumable: false } } },
          { id: 'qq_home_4', mid: 'home_4', name: '示例歌曲 4', ar: [{ id: 'qq_ar_4', mid: 'ar_4', name: '歌手 4', picUrl: '' }], artists: [{ id: 'qq_ar_4', mid: 'ar_4', name: '歌手 4', picUrl: '' }], al: { id: 'qq_al_4', mid: 'al_4', name: '示例专辑 4', picUrl: '' }, album: { id: 'qq_al_4', name: '示例专辑 4', picUrl: '' }, dt: 240000, duration: 240, playable: true, matched: true, privilege: { playMaxbr: 320000, maxbr: 320000, freeTrialPrivilege: { resConsumable: false } } },
          { id: 'qq_home_5', mid: 'home_5', name: '示例歌曲 5', ar: [{ id: 'qq_ar_5', mid: 'ar_5', name: '歌手 5', picUrl: '' }], artists: [{ id: 'qq_ar_5', mid: 'ar_5', name: '歌手 5', picUrl: '' }], al: { id: 'qq_al_5', mid: 'al_5', name: '示例专辑 5', picUrl: '' }, album: { id: 'qq_al_5', name: '示例专辑 5', picUrl: '' }, dt: 240000, duration: 240, playable: true, matched: true, privilege: { playMaxbr: 320000, maxbr: 320000, freeTrialPrivilege: { resConsumable: false } } },
          { id: 'qq_home_6', mid: 'home_6', name: '示例歌曲 6', ar: [{ id: 'qq_ar_6', mid: 'ar_6', name: '歌手 6', picUrl: '' }], artists: [{ id: 'qq_ar_6', mid: 'ar_6', name: '歌手 6', picUrl: '' }], al: { id: 'qq_al_6', mid: 'al_6', name: '示例专辑 6', picUrl: '' }, album: { id: 'qq_al_6', name: '示例专辑 6', picUrl: '' }, dt: 240000, duration: 240, playable: true, matched: true, privilege: { playMaxbr: 320000, maxbr: 320000, freeTrialPrivilege: { resConsumable: false } } }
      ],
      toplists: [
          { id: 'qq_top_1', name: '飙升榜', picUrl: '', updateFrequency: '每日更新' },
          { id: 'qq_top_2', name: '热歌榜', picUrl: '', updateFrequency: '每日更新' },
          { id: 'qq_top_3', name: '新歌榜', picUrl: '', updateFrequency: '每日更新' },
          { id: 'qq_top_4', name: '流行指数', picUrl: '', updateFrequency: '每日更新' }
      ],
    },
    '/api/recommend/daily': {
      status: 'ready',
      date: '2026-10-19',
      greeting: '今天的曲子偏安静，适合夜里听。',
      tracks: [
        {
          id: 'qq_demo_1',
          mid: 'demo_1',
          name: '夜航',
          ar: [{ id: 'qq_ar_demo_1', mid: 'ar_1', name: '林间', picUrl: '' }],
          artists: [{ id: 'qq_ar_demo_1', mid: 'ar_1', name: '林间', picUrl: '' }],
          al: { id: 'qq_al_demo_1', mid: 'al_1', name: '夜航', picUrl: '' },
          album: { id: 'qq_al_demo_1', name: '夜航', picUrl: '' },
          dt: 248000,
          duration: 248,
          playable: true,
          matched: true,
          privilege: { playMaxbr: 320000, maxbr: 320000, freeTrialPrivilege: { resConsumable: false } },
          recommendReason: '和你最近常听的华语人声接近，但编曲更安静一点。',
        },
        {
          id: 'qq_demo_2',
          mid: 'demo_2',
          name: '雨停之后',
          ar: [{ id: 'qq_ar_demo_2', mid: 'ar_2', name: '陈稚', picUrl: '' }],
          artists: [{ id: 'qq_ar_demo_2', mid: 'ar_2', name: '陈稚', picUrl: '' }],
          al: { id: 'qq_al_demo_2', mid: 'al_2', name: '雨停之后', picUrl: '' },
          album: { id: 'qq_al_demo_2', name: '雨停之后', picUrl: '' },
          dt: 213000,
          duration: 213,
          playable: true,
          matched: true,
          privilege: { playMaxbr: 320000, maxbr: 320000, freeTrialPrivilege: { resConsumable: false } },
          recommendReason: '你收藏过同一位制作人的作品，这首的配器更克制。',
        },
        {
          id: 'qq_demo_3',
          mid: 'demo_3',
          name: '慢速列车',
          ar: [{ id: 'qq_ar_demo_3', mid: 'ar_3', name: '北纬三十', picUrl: '' }],
          artists: [{ id: 'qq_ar_demo_3', mid: 'ar_3', name: '北纬三十', picUrl: '' }],
          al: { id: 'qq_al_demo_3', mid: 'al_3', name: '慢速列车', picUrl: '' },
          album: { id: 'qq_al_demo_3', name: '慢速列车', picUrl: '' },
          dt: 267000,
          duration: 267,
          playable: true,
          matched: true,
          privilege: { playMaxbr: 320000, maxbr: 320000, freeTrialPrivilege: { resConsumable: false } },
          recommendReason: '夜间时段你更常听慢歌，这首的鼓点密度更低。',
        },
      ],
    },
    '/api/health': { ok: true, version: '1.0.0-demo' },
  };

  return {
    name: 'suen-mock-api',
    configureServer(server) {
      if (process.env.SUEN_MOCK !== '1') return;
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api')) return next();
        const path = url.split('?')[0] ?? url;
        console.log(`[mock] ${req.method} ${path}`);
        res.setHeader('Content-Type', 'application/json');
        if (path === '/api/auth/login' || path === '/api/auth/refresh') {
          res.end(JSON.stringify({
            accessToken: 'demo-access',
            refreshToken: 'demo-refresh',
            expiresInSec: 3600,
            user: { id: 'u_demo', username: 'demo', displayName: '演示账号', role: 'admin' },
          }));
          return;
        }
        res.end(JSON.stringify(fixtures[path] ?? {}));
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), mockApiPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: HOST,
    port: 5273,
    strictPort: true,
    proxy: {
      /**
       * 只代理 /api。
       *
       * 走代理而不是直连 + CORS，是因为**音频流**尤其怕跨域：
       * `<audio src>` 发出的 Range 请求若跨域，服务端需要正确回应 OPTIONS，
       * 而开发期直接同源最省事，也不会有 Cookie/凭据策略的干扰。
       */
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        // 音频是长连接流式响应，不能让代理提前超时切断
        proxyTimeout: 0,
        timeout: 0,
      },
    },
  },
  build: {
    outDir: 'dist',
    // 单文件体积可控，不需要拆得太碎；保留 sourcemap 便于线上排查
    sourcemap: true,
    chunkSizeWarningLimit: 800,
  },
});
