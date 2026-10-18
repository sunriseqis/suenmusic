/**
 * 演示用的假服务端（仅本机开发）。
 *
 * 目的：不部署真服务端，也能把「数据 / 高级」里那些依赖服务端的分节渲染出来，
 * 用来验收版式。它只提供**结构正确**的假数据，不做鉴权、不落库。
 *
 * 用法：
 *   node scripts/mock-server.mjs            # 默认 0.0.0.0:8899
 *   应用里把服务端地址设为 http://<开发机 IP>:8899
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8899);
const now = Date.now();

const fixtures = {
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
      {
        id: 's_1',
        createdAt: now - 2 * 864e5,
        lastUsedAt: now - 36e5,
        expiresAt: now + 30 * 864e5,
        userAgent: 'Android 16 · 本机',
        isCurrent: true,
      },
      {
        id: 's_2',
        createdAt: now - 9 * 864e5,
        lastUsedAt: now - 3 * 864e5,
        expiresAt: now + 21 * 864e5,
        userAgent: 'Chrome · Windows',
        isCurrent: false,
      },
    ],
  },
  '/api/bilibili/account': {
    loggedIn: true,
    uname: '哔哩哔哩演示账号',
    mid: 1234567,
    avatar: '',
  },
  '/api/netease/account': { loggedIn: false, nickname: '' },
  '/api/ai/models': {
    profiles: [
      {
        id: 'm_main',
        name: '主模型',
        baseUrl: 'http://127.0.0.1:8904/v1',
        apiKeyMasked: 'sk-****demo',
        hasApiKey: true,
        model: 'glm-5.3-flash',
      },
      {
        id: 'm_review',
        name: '复核模型',
        baseUrl: 'http://127.0.0.1:8904/v1',
        apiKeyMasked: 'sk-****demo',
        hasApiKey: true,
        model: 'glm-5.3',
      },
    ],
    decideProfileId: 'm_main',
    reviewProfileId: 'm_review',
  },
  '/api/ai/persona': {
    summary: '偏好人声与华语流行，夜晚更常听抒情人声。',
    profileLines: ['华语流行 62%', '人声优先', '夜间时段活跃'],
    ledgerLines: ['收藏 12 首', '不喜欢 2 首'],
    lastGuidance: '少一点电音',
    updatedAt: now - 864e5,
  },
  '/api/favorites': { tracks: [], total: 0 },
  '/api/playlists': { playlists: [] },
  '/api/history': { items: [] },
  '/api/home': { newAlbums: [], newSongs: [], toplists: [] },
  '/api/recommend/daily': { tracks: [], reason: null },
  '/api/health': { ok: true, version: '1.0.0-demo' },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  console.log(`${req.method} ${path}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // 登录：直接给一对假令牌，够让前端进入已登录状态
  if (path === '/api/auth/login' || path === '/api/auth/refresh') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        accessToken: 'demo-access',
        refreshToken: 'demo-refresh',
        expiresInSec: 3600,
        user: { id: 'u_demo', username: 'demo', displayName: '演示账号', role: 'admin' },
      })
    );
    return;
  }

  const body = fixtures[path] ?? {};
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock server on http://0.0.0.0:${PORT}`);
});
