/**
 * 极简 HTTP 工具。
 *
 * 刻意不引入 axios：服务端只需要 GET / POST + 超时 + 有限重试，
 * Node 内置 fetch 完全覆盖；而且代理 B 站音频流时要直接拿 Web ReadableStream，
 * 用内置 fetch 比 axios 的 Node Stream 少一层转换。
 */

export class UpstreamError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined | null>;
  /** 会被 JSON 序列化；传了它会自动带上 Content-Type */
  body?: unknown;
  timeoutMs?: number;
  /** 失败后的额外重试次数（5xx 与网络错误才重试，4xx 不重试） */
  retries?: number;
  /**
   * 流式响应：超时只覆盖**首包**（响应头到达），不覆盖响应体读取。
   *
   * ⚠️ 音频这类长流必须开它。响应体是几分钟的音频，而 `AbortSignal.timeout`
   * 是"整个响应周期"的总超时 —— 一旦下游有背压（例如我们自己的上行节流器
   * 把输出压到实时速率），上游读取会被拖到整首歌那么久，总超时必然在
   * 歌播到一半时引爆：`TimeoutError: The operation was aborted due to timeout`
   * （实测报障，流被拦腰截断）。
   */
  stream?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 1;
const RETRY_BACKOFF_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function buildUrl(
  url: string,
  query?: RequestOptions['query']
): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    u.searchParams.set(key, String(value));
  }
  return u.toString();
}

/**
 * 发起请求并返回原始 Response。
 * 调用方需要自己处理业务码（例如 B 站的 -412 是 HTTP 200 + 业务错误）。
 */
export async function request(
  url: string,
  options: RequestOptions = {}
): Promise<Response> {
  const {
    method = 'GET',
    headers = {},
    query,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    stream = false,
  } = options;

  const target = buildUrl(url, query);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const finalHeaders: Record<string, string> = { ...headers };
      if (body !== undefined && !finalHeaders['Content-Type']) {
        finalHeaders['Content-Type'] = 'application/json';
      }

      // stream 模式：超时只到"首包"为止，头一到就解除，body 交给调用方
      const streamAbort = stream ? new AbortController() : null;
      const streamTimer = streamAbort
        ? setTimeout(() => streamAbort.abort(new Error(`上游首包超时（${timeoutMs}ms）`)), timeoutMs)
        : null;
      let res: Response;
      try {
        res = await fetch(target, {
          method,
          headers: finalHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: streamAbort ? streamAbort.signal : AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        });
      } finally {
        if (streamTimer) clearTimeout(streamTimer);
      }

      if (res.status >= 500 && attempt < retries) {
        lastError = new UpstreamError(`上游返回 ${res.status}`, res.status);
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new UpstreamError(String(lastError));
}

/** 请求并解析 JSON。非 2xx 或非法 JSON 会抛 UpstreamError。 */
export async function requestJson<T>(
  url: string,
  options: RequestOptions = {}
): Promise<T> {
  const res = await request(url, options);
  const text = await res.text();

  if (!res.ok) {
    throw new UpstreamError(
      `HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(
      `响应不是合法 JSON: ${text.slice(0, 300)}`,
      res.status
    );
  }
}

export { sleep };
