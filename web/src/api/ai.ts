/**
 * AI 模型配置与音乐口味画像 API。
 */

import { request } from './client.ts';
import type {
  AiSettingsConfigView,
  PersonaDetail,
} from './types.ts';

export async function fetchAiModels(): Promise<AiSettingsConfigView> {
  return request<AiSettingsConfigView>('/api/ai/models');
}

export async function saveAiModels(payload: {
  profiles: Array<{
    id?: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
  }>;
  /** 缺省 = 保留服务端当前指派（分配与模型配置一起保存） */
  decideProfileId?: string;
  reviewProfileId?: string;
}): Promise<{ ok: boolean; config: AiSettingsConfigView }> {
  return request<{ ok: boolean; config: AiSettingsConfigView }>('/api/ai/models', {
    method: 'POST',
    body: payload,
    timeoutMs: 45_000,
  });
}

export async function fetchPersona(): Promise<PersonaDetail> {
  return request<PersonaDetail>('/api/ai/persona');
}

/**
 * 长 AI 任务的超时预算（⚠️ 必须**大于服务端**的模型超时）。
 *
 * 三处预算的完整链条：
 *   服务端模型调用 600s（`ai-memory.ts` 的 `timeoutMs: 600_000`）
 *   < 客户端 700s（这里）
 *   < Fastify 入站 requestTimeout 900s
 * 之所以要客户端 > 服务端：让**服务端先给出结论**（成功、或一条明确的失败原因），
 * 客户端只是最后一道 UX 兜底。之前客户端也是 180s、服务端也是 180s，
 * 客户端基本必输，用户看到的是「连不上服务端，请到设置页检查基地址」这种**误报**。
 */
const LONG_AI_TIMEOUT_MS = 700_000;

export async function tunePersona(guidance: string): Promise<{ ok: boolean; persona: PersonaDetail }> {
  return request<{ ok: boolean; persona: PersonaDetail }>('/api/ai/persona/tune', {
    method: 'POST',
    body: { guidance },
    timeoutMs: LONG_AI_TIMEOUT_MS,
    // 长任务不参与「换路径重放」：白等两轮 + 服务端 AI 被重复触发（见 RequestOptions.noFailover）
    noFailover: true,
  });
}

