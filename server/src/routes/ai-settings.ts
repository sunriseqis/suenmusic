/**
 * AI 模型配置与用户画像管理路由。
 *
 * GET  /api/ai/models          获取模型列表（API Key 已脱敏）与分工指派【Web 管理员】
 * POST /api/ai/models          保存模型配置（自动连通性测试）【Web 管理员】
 * POST /api/ai/models/test     单独测试指定模型连通性【Web 管理员】
 * GET  /api/ai/assignment      分工指派下拉数据（瘦身，无 Key 信息）【任何登录用户】
 * PATCH /api/ai/assignment     改分工指派（决策/复核）【任何登录用户】
 * GET  /api/ai/persona         获取当前用户音乐画像与客观分布
 * POST /api/ai/persona/tune    用户提供引导词驱动 AI 调优画像
 * POST /api/ai/persona/refresh 基于最新曲库行为全量重构画像
 */

import type { FastifyInstance } from 'fastify';
import { requireUser, requireWebAdmin } from '../http/require-auth.ts';
import { badGateway, badRequest } from '../http/errors.ts';
import {
  getAiAssignmentView,
  getAiSettingsConfig,
  getAiSettingsConfigView,
  testAiConnection,
  updateAiAssignment,
  updateAiSettingsConfig,
} from '../services/ai-client.ts';
import {
  getPersonaDetail,
  refreshPersona,
  tunePersona,
} from '../services/ai-memory.ts';

export function registerAiSettingsRoutes(app: FastifyInstance): void {
  // ---- 模型配置 ----

  app.get('/api/ai/models', async req => {
    requireWebAdmin(req);
    return getAiSettingsConfigView();
  });

  app.post('/api/ai/models', async req => {
    requireWebAdmin(req);
    const body = req.body as {
      profiles?: Array<{
        id?: string;
        name?: string;
        baseUrl?: string;
        apiKey?: string;
        model?: string;
      }>;
      decideProfileId?: string;
      reviewProfileId?: string;
    };

    if (!body || !Array.isArray(body.profiles)) {
      throw badRequest('请求格式不正确，缺少 profiles 数组');
    }

    // 分配字段缺省 = 保留当前指派（「AI 模型」CRUD 不再提交分配，
    // 分配走 PATCH /api/ai/assignment）；显式清空才回落第一个模型。
    const current = getAiSettingsConfig();
    try {
      const view = await updateAiSettingsConfig(
        {
          profiles: body.profiles.map((p, idx) => ({
            id: p.id || `m_${Date.now()}_${idx}`,
            name: String(p.name ?? '').trim() || String(p.model ?? '').trim(),
            baseUrl: String(p.baseUrl ?? '').trim(),
            apiKey: String(p.apiKey ?? '').trim(),
            model: String(p.model ?? '').trim(),
          })),
          decideProfileId:
            String(body.decideProfileId ?? '').trim() || current.decideProfileId,
          reviewProfileId:
            String(body.reviewProfileId ?? '').trim() || current.reviewProfileId,
        },
        true
      );
      return { ok: true, config: view };
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  app.post('/api/ai/models/test', async req => {
    requireWebAdmin(req);
    const body = (req.body ?? {}) as {
      id?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    };

    let baseUrl = String(body.baseUrl ?? '').trim();
    let apiKey = String(body.apiKey ?? '').trim();
    let model = String(body.model ?? '').trim();

    if (body.id) {
      const cfg = getAiSettingsConfig();
      const existing = cfg.profiles.find(p => p.id === body.id);
      if (existing) {
        if (!baseUrl) baseUrl = existing.baseUrl;
        if (!apiKey) apiKey = existing.apiKey;
        if (!model) model = existing.model;
      }
    }

    if (!baseUrl) throw badRequest('缺少 Base URL');
    if (!apiKey) throw badRequest('缺少 API Key');
    if (!model) throw badRequest('缺少模型名称');

    try {
      const result = await testAiConnection({ baseUrl, apiKey, model });
      return result;
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // ---- 分工指派（客户端只做分配：任何登录用户、任何渠道）----

  app.get('/api/ai/assignment', async req => {
    requireUser(req);
    return getAiAssignmentView();
  });

  app.patch('/api/ai/assignment', async req => {
    requireUser(req);
    const body = (req.body ?? {}) as { decideProfileId?: string; reviewProfileId?: string };
    try {
      updateAiAssignment(
        String(body.decideProfileId ?? '').trim(),
        String(body.reviewProfileId ?? '').trim()
      );
      return { ok: true, assignment: getAiAssignmentView() };
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // ---- 用户画像 ----

  app.get('/api/ai/persona', async req => {
    const user = requireUser(req);
    return getPersonaDetail(user.id);
  });

  app.post('/api/ai/persona/tune', async req => {
    const user = requireUser(req);
    const body = (req.body ?? {}) as { guidance?: string };
    const guidance = String(body.guidance ?? '').trim();
    if (!guidance) {
      throw badRequest('请填写调优引导意见');
    }

    try {
      const detail = await tunePersona(user.id, guidance);
      return { ok: true, persona: detail };
    } catch (err) {
      // 同 refresh：模型侧失败是 502，前端要能把原因显示出来
      throw badGateway(`画像调优失败：${(err as Error).message}`);
    }
  });

  app.post('/api/ai/persona/refresh', async req => {
    const user = requireUser(req);
    try {
      const detail = await refreshPersona(user.id);
      return { ok: true, persona: detail };
    } catch (err) {
      // 上游模型失败（超时/报错）是 502，不是客户端的 400 —— 前端要靠这个
      // 把"模型超时"如实显示出来，而不是静默留着旧画像（2026-09-22 修）
      throw badGateway(`画像生成失败：${(err as Error).message}`);
    }
  });
}
