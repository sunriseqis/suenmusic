/**
 * Fastify 应用组装。
 *
 * 与 `src/index.ts`（进程入口）分开，是为了让验收脚本能直接
 * `buildApp()` + `app.inject()` / `listen(0)` 起一个临时实例，
 * 不必真的去抢配置里的端口。
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { createLogger } from './logger.ts';
import { AppError } from './http/errors.ts';
import { DatabaseRestoringError } from './db/index.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerBackupRoutes } from './routes/backup.ts';
import { registerAiSettingsRoutes } from './routes/ai-settings.ts';
import { registerBilibiliRoutes } from './routes/bilibili.ts';
import { registerNeteaseRoutes } from './routes/netease.ts';
import { registerDailyRoutes } from './routes/daily.ts';
import { registerCatalogRoutes } from './routes/catalog.ts';
import { registerFavoriteRoutes } from './routes/favorites.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerHistoryRoutes } from './routes/history.ts';
import { registerKugouVerifyRoutes } from './routes/kugou-verify.ts';
import { registerResolveRoutes } from './routes/resolve.ts';
import { registerStreamRoutes } from './routes/stream.ts';
import { registerUpdateRoutes } from './routes/update.ts';
import { registerOpsLogRoutes } from './routes/ops-log.ts';

const log = createLogger('http');

function readRootVersion(): string {
  try {
    const p1 = join(config.webRoot, '../../VERSION');
    if (existsSync(p1)) return readFileSync(p1, 'utf8').trim();
    const p2 = join(import.meta.dirname, '../../VERSION');
    if (existsSync(p2)) return readFileSync(p2, 'utf8').trim();
    const p3 = join(import.meta.dirname, '../VERSION');
    if (existsSync(p3)) return readFileSync(p3, 'utf8').trim();
  } catch {
    /* ignore */
  }
  log.warn('未能定位 VERSION 文件，版本号未知');
  return '0.0.0';
}

export const SERVER_VERSION = readRootVersion();

/** 音频代理需要客户端能读到这些响应头，否则进度条拿不到总长度 */
/**
 * 跨域可读的响应头。
 *
 * 少一个 `X-Audio-Duration-Ms` 的后果很隐蔽：原生壳（Bearer + CORS）里
 * `fetch` 读不到这个头，进度条只能退回 Q 音元数据时长 —— 锚定到时长不同的
 * 视频时就会"播完不切歌"（重审 F）。同源 Web 不受 CORS 限制，所以一直没暴露。
 */
const EXPOSED_HEADERS =
  'Content-Range, Content-Length, Accept-Ranges, Content-Type, X-Audio-Duration-Ms';

const ALLOWED_HEADERS = 'Content-Type, Authorization, Range, X-Device-Id';

function applyCors(req: FastifyRequest, reply: FastifyReply): void {
  const origin = req.headers.origin;
  if (!origin) return;

  const allowed = config.corsOrigins;
  const wildcard = allowed.includes('*');
  if (!wildcard && !allowed.includes(origin)) return;

  // 不依赖 Cookie（令牌走 Authorization 头），因此通配来源不构成 CSRF 风险
  reply.header('Access-Control-Allow-Origin', wildcard ? '*' : origin);
  if (!wildcard) reply.header('Vary', 'Origin');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  reply.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  reply.header('Access-Control-Max-Age', '86400');
}

export function buildApp(): FastifyInstance {
  const app = Fastify({
    // 用自研 logger：结构化、无颜色，能直接被 docker logs / journalctl 读
    logger: false,
    /**
     * 反代后面要信 X-Forwarded-For 才能取到真实客户端 IP（登录节流依赖它）。
     *
     * 但**不能无条件 true**：那等于采信任何客户端伪造的 XFF，而节流按 IP 分桶，
     * 攻击者每请求换一个假 IP 就永远撞不到上限 —— 字典攻击变成无限次。
     * 所以默认 false，只有显式配置了可信代理（`SUENMUSIC_TRUST_PROXY`）才采信。
     */
    trustProxy: config.trustProxy,
    // 请求体上限 256KB：这个服务没有任何大体积上传，收紧可减少攻击面
    bodyLimit: 256 * 1024,
    // AI 深度长任务（画像重构、多轮选歌）耗时较长，显式设置 900 秒连接与请求超时：
    // 与 AI 调用处的预算配套 —— 调用处 600s（画像/选曲）/900s（审核），
    // 客户端 700s。顺序要保证「服务端先于客户端给出结论」，否则用户只会看到超时。
    connectionTimeout: 900_000,
    requestTimeout: 900_000,
  });

  // ---- CORS 与预检 ----
  app.addHook('onRequest', async (req, reply) => {
    applyCors(req, reply);
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  // ---- 访问日志 ----
  app.addHook('onResponse', async (req, reply) => {
    const ms = reply.elapsedTime;
    const line = `${req.method} ${req.url} ${reply.statusCode} ${ms.toFixed(1)}ms`;
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'debug';
    log[level](line);
  });

  // ---- 统一错误体 ----
  app.setErrorHandler((err, req, reply) => {
    // 数据库恢复临界区：请求路径上任何取连接的调用都会抛这个 ——
    // 明确回 503（可重试），不要落到 500 那条「未处理异常」上去刷错误日志
    if (err instanceof DatabaseRestoringError) {
      reply.code(503).send({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof AppError) {
      reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }

    // fastify 自身的请求解析错误（畸形 JSON、超长 body 等）
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      reply.code(status).send({
        error: {
          code: 'bad_request',
          message: '请求格式不正确',
        },
      });
      return;
    }

    log.error(`未处理异常 ${req.method} ${req.url}`, (err as Error).stack ?? String(err));
    reply.code(500).send({
      error: { code: 'internal_error', message: '服务端内部错误' },
    });
  });

  // ---- 前端静态资源（单端口部署）----
  // 目标是「一个进程、一个端口」同时伺服前端和 API，替掉原来的 nginx 容器。
  // 关键约束：**只有存在 index.html 才接管**。server 镜像（server/Dockerfile）
  // 里只 COPY 了 src/，没有前端产物 —— 那种情况下必须保持「纯 API」行为不变。
  const webRoot = existsSync(join(config.webRoot, 'index.html')) ? config.webRoot : null;
  /**
   * index.html **按 mtime 热读**，不再启动时缓存一份。
   *
   * 踩过：`web` 重新构建后 index.html 引用了新的 assets 哈希，但服务端手里还是旧 HTML，
   * 浏览器继续跑旧 bundle —— 表现为「新加的功能在页面上完全不存在」
   * （酷狗显示未登录、钉了源仍显示未钉，都是这个原因）。
   * 现在每次取都比一次 mtime：构建完刷新页面即生效，不用重启服务端。
   */
  let indexHtmlCache: { mtimeMs: number; html: string } | null = null;
  const readIndexHtml = (): string | null => {
    if (!webRoot) return null;
    const file = join(webRoot, 'index.html');
    try {
      const st = statSync(file);
      if (!indexHtmlCache || indexHtmlCache.mtimeMs !== st.mtimeMs) {
        indexHtmlCache = { mtimeMs: st.mtimeMs, html: readFileSync(file, 'utf8') };
      }
      return indexHtmlCache.html;
    } catch {
      return null;
    }
  };
  const indexHtml = readIndexHtml();

  if (webRoot && indexHtml) {
    app.register(fastifyStatic, {
      root: webRoot,
      // 缓存策略不在这里设：@fastify/static 内部是
      // `setHeaders(res, path)` → `reply.headers(send算出的值)`，
      // 后者会覆盖前者（实测 max-age 被重置成 0）。所以放到下面的 onSend 钩子里。
    });
    log.info(`前端静态资源已挂载：${webRoot}（单端口部署）`);
  }

  // ---- 前端缓存策略 ----
  // 放在 onSend 而不是 @fastify/static 的 setHeaders：后者先被调用、
  // 紧接着 send 计算出的 Cache-Control 会覆盖它（实测 max-age 会被重置为 0）。
  // onSend 在响应落地前执行，顺序才对。
  //   · /assets/*  带内容哈希 → 可以 immutable 长缓存
  //   · *.html    入口文件   → 绝不能缓存，否则前端发版后客户端一直拿旧的
  app.addHook('onSend', async (req, reply, payload) => {
    const path = (req.url ?? '').split('?')[0];
    if (path.startsWith('/api/')) return payload;
    if (path.endsWith('.html')) {
      reply.header('Cache-Control', 'no-cache');
    } else if (path.includes('/assets/')) {
      reply.header('Cache-Control', 'public, max-age=2592000, immutable');
    }
    return payload;
  });

  app.setNotFoundHandler((req, reply) => {
    // API 未命中仍然是 JSON 404 —— 这是契约，客户端靠状态码判断
    if (req.url.startsWith('/api/') || req.url === '/api') {
      reply.code(404).send({
        error: {
          code: 'not_found',
          message: `接口不存在：${req.method} ${req.url}`,
        },
      });
      return;
    }

    // 其余路径交给前端路由（Vue Router 的 history 模式）
    const liveIndexHtml = readIndexHtml();
    if (liveIndexHtml) {
      reply.header('Cache-Control', 'no-cache');
      reply.type('text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-cache');
      reply.send(liveIndexHtml);
      return;
    }

    reply.code(404).send({
      error: {
        code: 'not_found',
        message: `不存在：${req.method} ${req.url}`,
      },
    });
  });

  // ---- 路由 ----
  registerHealthRoutes(app, SERVER_VERSION);
  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerBackupRoutes(app);
  registerBilibiliRoutes(app);
  registerNeteaseRoutes(app);
  registerDailyRoutes(app);
  registerAiSettingsRoutes(app);
  registerCatalogRoutes(app);
  registerFavoriteRoutes(app);
  registerHistoryRoutes(app);
  registerResolveRoutes(app);
  registerKugouVerifyRoutes(app);
  registerStreamRoutes(app);
  registerUpdateRoutes(app);
  registerOpsLogRoutes(app);

  return app;
}
