/**
 * OpenAI 兼容的模型调用层（唯一出口）。
 *
 * 配置来源优先级：数据库（前端设置窗口里填的）> 环境变量。
 * 这样"模型接入在前端加个窗口"的诉求成立：家人换模型不用改配置文件。
 *
 * ⚠️ 实测这个上游是**推理模型**：`content` 会因为 `max_tokens` 太小而被截断
 * （响应里只有 `reasoning`、`content: null`）。所以：
 *   - 默认给足 max_tokens；
 *   - content 为空时**报错**，而不是当成"模型没输出"悄悄吞掉。
 */
import { getSetting, setSetting } from '../db/repo/settings.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('ai');

export const AI_SETTING_KEYS = {
  baseUrl: 'ai.base_url',
  apiKey: 'ai.api_key',
  model: 'ai.model',
  modelsConfig: 'ai.models.config',
} as const;

/** 默认给足额度：推理模型的前半段是思考过程，额度太小只剩思考没有正文 */
const DEFAULT_MAX_TOKENS = 16000;

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiSettingsConfig {
  profiles: AiModelProfile[];
  /** 选歌 DJ 主理人模型 ID */
  decideProfileId: string;
  /** 复核审核员模型 ID（可与选歌相同） */
  reviewProfileId: string;
}

/** 读单套旧配置（环境变量或 app_settings 单键兜底） */
function readLegacyAiConfig(): AiConfig | null {
  const baseUrl = (
    getSetting(AI_SETTING_KEYS.baseUrl) ??
    process.env.SUENMUSIC_AI_BASE_URL ??
    ''
  ).trim();
  const apiKey = (getSetting(AI_SETTING_KEYS.apiKey) ?? process.env.SUENMUSIC_AI_KEY ?? '').trim();
  const model = (getSetting(AI_SETTING_KEYS.model) ?? process.env.SUENMUSIC_AI_MODEL ?? '').trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
}

/** 获取完整多模型配置 */
export function getAiSettingsConfig(): AiSettingsConfig {
  const raw = getSetting(AI_SETTING_KEYS.modelsConfig);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as AiSettingsConfig;
      if (Array.isArray(parsed.profiles)) {
        return parsed;
      }
    } catch {
      /* ignore */
    }
  }

  // 没有多模型配置时，尝试从旧配置/环境变量构建默认配置
  const legacy = readLegacyAiConfig();
  if (legacy) {
    const defaultProfile: AiModelProfile = {
      id: 'default',
      name: legacy.model,
      baseUrl: legacy.baseUrl,
      apiKey: legacy.apiKey,
      model: legacy.model,
    };
    return {
      profiles: [defaultProfile],
      decideProfileId: 'default',
      reviewProfileId: 'default',
    };
  }

  return {
    profiles: [],
    decideProfileId: '',
    reviewProfileId: '',
  };
}

/** 读当前生效的配置（支持按场景区分：选歌 vs 审核） */
export function readAiConfig(purpose?: 'decide' | 'review' | 'memory'): AiConfig | null {
  const cfg = getAiSettingsConfig();
  if (cfg.profiles.length > 0) {
    let targetId = cfg.decideProfileId;
    if (purpose === 'review') {
      targetId = cfg.reviewProfileId || cfg.decideProfileId;
    }
    const found = cfg.profiles.find(p => p.id === targetId) || cfg.profiles[0];
    if (found && found.baseUrl && found.apiKey && found.model) {
      return {
        baseUrl: found.baseUrl.replace(/\/+$/, ''),
        apiKey: found.apiKey,
        model: found.model,
      };
    }
  }
  return readLegacyAiConfig();
}

/** 测试指定的模型连通性 */
export async function testAiConnection(target: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<{ ok: boolean; latencyMs: number }> {
  const baseUrl = (target.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = (target.apiKey || '').trim();
  const model = (target.model || '').trim();

  if (!baseUrl) throw new Error('缺少 Base URL');
  if (!apiKey) throw new Error('缺少 API Key');
  if (!model) throw new Error('缺少模型名称');

  const started = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(err => {
    throw new Error(`网络连接失败：${(err as Error).message}`);
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`接口响应 HTTP ${res.status}：${text.slice(0, 150) || res.statusText}`);
  }

  const latencyMs = Date.now() - started;
  return { ok: true, latencyMs };
}

/** 保存多模型配置，根据需求切换或保存时自动连通校验 */
export async function saveAiSettingsConfig(
  newConfig: AiSettingsConfig,
  verify = true
): Promise<void> {
  if (verify && newConfig.profiles.length > 0) {
    const decide = newConfig.profiles.find(p => p.id === newConfig.decideProfileId);
    if (decide) {
      try {
        await testAiConnection(decide);
      } catch (err) {
        throw new Error(`选歌模型「${decide.name}」连通失败：${(err as Error).message}`);
      }
    }

    if (
      newConfig.reviewProfileId &&
      newConfig.reviewProfileId !== newConfig.decideProfileId
    ) {
      const review = newConfig.profiles.find(p => p.id === newConfig.reviewProfileId);
      if (review) {
        try {
          await testAiConnection(review);
        } catch (err) {
          throw new Error(`审核模型「${review.name}」连通失败：${(err as Error).message}`);
        }
      }
    }
  }

  setSetting(AI_SETTING_KEYS.modelsConfig, JSON.stringify(newConfig));
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '********';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

export interface AiModelProfileView {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  model: string;
}

export interface AiSettingsConfigView {
  profiles: AiModelProfileView[];
  decideProfileId: string;
  reviewProfileId: string;
}

export function getAiSettingsConfigView(): AiSettingsConfigView {
  const cfg = getAiSettingsConfig();
  return {
    profiles: cfg.profiles.map(p => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKeyMasked: maskApiKey(p.apiKey),
      hasApiKey: Boolean(p.apiKey),
      model: p.model,
    })),
    decideProfileId: cfg.decideProfileId,
    reviewProfileId: cfg.reviewProfileId,
  };
}

export async function updateAiSettingsConfig(
  draft: {
    profiles: Array<{
      id: string;
      name: string;
      baseUrl: string;
      apiKey?: string;
      model: string;
    }>;
    decideProfileId: string;
    reviewProfileId: string;
  },
  verify = true
): Promise<AiSettingsConfigView> {
  const current = getAiSettingsConfig();
  const existingMap = new Map(current.profiles.map(p => [p.id, p]));

  const mergedProfiles: AiModelProfile[] = draft.profiles.map((p, index) => {
    const existing = existingMap.get(p.id);
    const name = (p.name || '').trim() || (p.model || '').trim();
    const key = (p.apiKey || '').trim() || (existing ? existing.apiKey : '');
    if (!key) {
      throw new Error(`模型「${name}」缺少 API Key`);
    }
    return {
      id: p.id || `m_${Date.now()}_${index}`,
      name,
      baseUrl: (p.baseUrl || '').trim(),
      apiKey: key,
      model: (p.model || '').trim(),
    };
  });

  const finalConfig: AiSettingsConfig = {
    profiles: mergedProfiles,
    decideProfileId: draft.decideProfileId || (mergedProfiles[0]?.id ?? ''),
    reviewProfileId: draft.reviewProfileId || draft.decideProfileId || (mergedProfiles[0]?.id ?? ''),
  };

  await saveAiSettingsConfig(finalConfig, verify);
  return getAiSettingsConfigView();
}

/** 模型不可用（未配置 / 连不上 / 返回异常）—— 调用方据此给用户明确提示，不做静默降级 */
export class AiUnavailableError extends Error {}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 调一次 chat/completions，返回助手正文。
 *
 * @param opts.jsonMode 要求返回 JSON 对象（openai 兼容的 response_format）
 */
/** 一次失败只重试一次；连续失败就把原因如实抛给调用方 */
class AiRetryableFailure extends Error {}

/** 把 fetch 层的失败翻译成人话：超时要说清秒数，其他要把 cause 带出来 */
function describeFetchFailure(err: unknown, timeoutMs: number): string {
  const e = err as {
    name?: string;
    message?: string;
    cause?: { name?: string; message?: string };
  };
  const isAbort = e?.name === 'AbortError' || /abort|timeout/i.test(String(e?.message ?? ''));
  if (isAbort) return `模型请求超时（${Math.round(timeoutMs / 1000)}s）`;
  const cause = e?.cause
    ? `${e.cause.name ?? ''}${e.cause.message ? ': ' + e.cause.message : ''}`
    : '';
  return `模型请求失败：${e?.message ?? String(err)}${cause ? `（${cause}）` : ''}`;
}

/**
 * 发一轮对话请求，**超时 / 限流 / 上游故障自动重试一次**。
 *
 * 口径（用户拍板 2026-09-22）：后台任务里**超时是常态**，不该判死 ——
 * 只有模型本身报错（400/401/403 这类永久错误）才直接失败。所以：
 *   - 超时 / 429 / 5xx / 网络层失败 → 重试一次
 *   - 其余 4xx → 立即失败（重试也不会变好）
 *
 * 失败信息里会带超时秒数或 cause —— 之前那种裸露的 `fetch failed`
 * （undici 300s 默认上限）在日志里与网络故障无法区分，查了很久。
 */
async function postChatWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AiRetryableFailure(describeFetchFailure(err, timeoutMs));
    }
    if (!res.ok && (res.status === 429 || res.status >= 500)) {
      const text = await res.text().catch(() => '');
      throw new AiRetryableFailure(`模型返回 ${res.status}：${text.slice(0, 200)}`);
    }
    return res;
  };

  try {
    return await attempt();
  } catch (err) {
    if (!(err instanceof AiRetryableFailure)) throw err;
    log.warn(`${(err as Error).message}；重试一次…`);
    return await attempt();
  }
}

export async function aiChat(
  messages: AiMessage[],
  opts: {
    purpose?: 'decide' | 'review' | 'memory';
    jsonMode?: boolean;
    maxTokens?: number;
    timeoutMs?: number;
    temperature?: number;
  } = {}
): Promise<string> {
  const cfg = readAiConfig(opts.purpose);
  if (!cfg) throw new AiUnavailableError('模型未配置（请在设置页中配置 AI 接口）');

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? 0.8,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const started = Date.now();
  let res: Response;
  try {
    res = await postChatWithRetry(
      `${cfg.baseUrl}/chat/completions`,
      { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      JSON.stringify(body),
      opts.timeoutMs ?? 600_000
    );
  } catch (err) {
    throw new AiUnavailableError((err as Error).message);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiUnavailableError(`模型返回 ${res.status}：${text.slice(0, 200)}`);
  }

  /**
   * ⚠️ 不能直接 res.json()：这个上游的响应体后面会跟 SSE 尾巴（`data: [DONE]`），
   * 实测会抛 "Unexpected non-whitespace character after JSON"。所以读文本后
   * 用配平大括号的方式抠出第一个完整 JSON 对象。
   */
  const rawText = await res.text();
  const jsonText = firstJsonObject(rawText);
  if (!jsonText) throw new AiUnavailableError(`模型响应里没有 JSON：${rawText.slice(0, 200)}`);
  let data: {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning?: string | null;
        reasoning_content?: string | null;
      };
      finish_reason?: string | null;
    }>;
    usage?: { total_tokens?: number };
  };
  try {
    data = JSON.parse(jsonText) as typeof data;
  } catch (err) {
    throw new AiUnavailableError(`模型响应 JSON 解析失败：${(err as Error).message}`);
  }
  let content = data.choices?.[0]?.message?.content ?? '';
  // 兜底抢救：仅当 content 为空，且 reasoning / reasoning_content 呈现结构化 JSON 格式时尝试借用（如审核/分类场景）
  if (!content.trim()) {
    const reasoning = (data.choices?.[0]?.message?.reasoning ?? data.choices?.[0]?.message?.reasoning_content ?? '').trim();
    if (reasoning && (reasoning.includes('{"picks"') || reasoning.includes('{"items"') || reasoning.includes('{"reject"'))) {
      log.info('模型正文为空，从思考过程 (reasoning) 兜底提取结构化 JSON');
      content = reasoning;
    }
  }

  // 剥离模型/中转网关注入的 User Safety: safe 等风控元数据残留
  content = content.replace(
    /(?:\[|【)?\b(?:user\s+|content\s+|system\s+)?safety(?:\s+(?:assessment|rating|check|status|result))?\s*[:：]\s*(?:safe|pass|ok|clean|neutral|none|true|false)\b[\s,，;；、\-—]*\]?】?/gi,
    ''
  ).trim();

  log.info(
    `模型调用完成：${Date.now() - started}ms · tokens ${data.usage?.total_tokens ?? '?'} · 输出 ${content.length} 字`
  );
  if (!content.trim()) {
    const finishReason = data.choices?.[0]?.finish_reason;
    if (finishReason === 'length') {
      throw new AiUnavailableError('模型没有返回正文（思考过程过长，触碰了 max_tokens 截断上限）');
    }
    throw new AiUnavailableError('模型没有返回正文（可能被截断或模型无响应）');
  }
  return content;
}

/** 工具调用（openai 兼容） */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiToolReply {
  content: string;
  toolCalls: AiToolCall[];
}

/** 支持 function calling 的一轮对话（工具结果用 role: 'tool' 回填） */
export async function aiChatWithTools(
  messages: Array<Record<string, unknown>>,
  tools: unknown[],
  opts: { maxTokens?: number; timeoutMs?: number; temperature?: number } = {}
): Promise<AiToolReply> {
  const cfg = readAiConfig();
  if (!cfg) throw new AiUnavailableError('模型未配置（前端设置里填 base_url / key / model）');

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? 0.7,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await postChatWithRetry(
      `${cfg.baseUrl}/chat/completions`,
      { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      JSON.stringify(body),
      opts.timeoutMs ?? 600_000
    );
  } catch (err) {
    throw new AiUnavailableError((err as Error).message);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiUnavailableError(`模型返回 ${res.status}：${text.slice(0, 200)}`);
  }

  const rawText = await res.text();
  const jsonText = firstJsonObject(rawText);
  if (!jsonText) throw new AiUnavailableError(`模型响应里没有 JSON：${rawText.slice(0, 200)}`);
  const data = JSON.parse(jsonText) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        /** 推理模型可能只给思考不给正文（实测收口轮常见） */
        reasoning?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: { total_tokens?: number };
  };
  const msg = data.choices?.[0]?.message;
  /**
   * ⚠️ 推理模型会"只思考不产出"：实测收口轮 content 为空、reasoning 里却写了东西。
   * 空正文时把 reasoning 一起交出去，让调用方有机会从中抢救 JSON（总比整轮白跑强）。
   */
  let content = (msg?.content ?? '').trim() ? (msg?.content ?? '') : (msg?.reasoning ?? '');
  content = content.replace(
    /(?:\[|【)?\b(?:user\s+|content\s+|system\s+)?safety(?:\s+(?:assessment|rating|check|status|result))?\s*[:：]\s*(?:safe|pass|ok|clean|neutral|none|true|false)\b[\s,，;；、\-—]*\]?】?/gi,
    ''
  ).trim();
  const toolCalls: AiToolCall[] = (msg?.tool_calls ?? []).map(c => ({
    id: String(c.id ?? ''),
    name: String(c.function?.name ?? ''),
    arguments: String(c.function?.arguments ?? '{}'),
  }));
  log.info(
    `模型轮次：${Date.now() - started}ms · tokens ${data.usage?.total_tokens ?? '?'} · ` +
      `工具调用 ${toolCalls.length} 个 · 正文 ${(msg?.content ?? '').length} 字` +
      (msg?.content ? '' : '（正文为空，已用 reasoning 兜底）')
  );
  return { content, toolCalls };
}

/** 从可能带尾巴的响应里抠出第一个配平的 JSON 对象 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 连通性测试：前端"测试"按钮用，返回模型原文 */
export async function aiPing(): Promise<string> {
  return aiChat([{ role: 'user', content: '只回答两个字：收到' }], { maxTokens: 800 });
}
