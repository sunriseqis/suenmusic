/**
 * 分类广场路由：官方分类树、按分类拉歌单、全部榜单。
 *
 * 与 `routes/catalog.ts` 分开的原因：广场是"发现"入口，请求的是**列表**；
 * catalog 是"详情"入口，请求的是**单个实体的详情**。两者上游模块、
 * 缓存策略都不同，混在一个文件里只会让 catalog 越来越长。
 *
 * 与 catalog 一致的两条约定：
 *   - 全部端点要求登录（消耗 QQ 配额，不能开放成公共代理）
 *   - 上游限流不吞成"空结果"，而是带 `degraded` 透出
 */

import type { FastifyInstance } from 'fastify';
import {
  QQ_TAG_ALL,
  findCategoryId,
  getQQAllToplists,
  getQQCategoryTree,
  getQQPlaylistsByCategory,
} from '../sources/qq/plaza.ts';
import { badRequest } from '../http/errors.ts';
import { intParam, strParam } from '../http/params.ts';
import { requireUser } from '../http/require-auth.ts';

export function registerPlazaRoutes(app: FastifyInstance): void {
  /**
   * 官方歌单分类树。
   *
   * 客户端拿它渲染分类导航，并把 `cat.id` 回传给 `/api/plaza?category=<id>`。
   * 服务端缓存 6 小时，所以这里的 Cache-Control 可以给长一点。
   */
  app.get('/api/plaza/categories', async (req, reply) => {
    requireUser(req);
    const result = await getQQCategoryTree();
    reply.header('Cache-Control', 'private, max-age=3600');
    return result;
  });

  /**
   * 按分类分页拉取官方歌单。
   *
   * `category` 接受两种形式：
   *   - 数字 tagId（推荐，客户端从分类树拿到）
   *   - 分类名（如 `爵士`），服务端查分类树解析；查不到**明确报错**，
   *     不退回「全部」—— 静默退回会让用户以为分类生效了
   */
  app.get('/api/plaza', async (req, reply) => {
    requireUser(req);
    const query = req.query as any;

    const page = intParam(query?.page, 1, { min: 1, max: 500 });
    const pageSize = intParam(query?.pageSize, 30, { min: 1, max: 50 });
    const raw = strParam(query?.category);

    let tagId = QQ_TAG_ALL;

    if (raw) {
      if (/^\d+$/.test(raw)) {
        tagId = Number(raw);
      } else {
        const { tree } = await getQQCategoryTree();
        const found = findCategoryId(tree, raw);
        if (found === null) {
          throw badRequest(
            `未知分类「${raw}」。请先用 /api/plaza/categories 取分类列表。`,
            'unknown_category'
          );
        }
        tagId = found;
      }
    }

    const result = await getQQPlaylistsByCategory(tagId, page, pageSize);
    reply.header('Cache-Control', 'private, max-age=120');
    return result;
  });

  /**
   * 全部官方榜单（巅峰榜 / 地区榜 / 特色榜 / 全球榜）。
   * 与 `/api/toplist/:id`（单个榜单详情）配套使用。
   */
  app.get('/api/toplists', async (req, reply) => {
    requireUser(req);
    const result = await getQQAllToplists();
    reply.header('Cache-Control', 'private, max-age=600');
    return result;
  });
}
