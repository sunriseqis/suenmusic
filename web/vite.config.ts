import { defineConfig } from 'vite';
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

export default defineConfig({
  plugins: [vue()],
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
