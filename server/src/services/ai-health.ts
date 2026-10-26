/**
 * AI 健康度台账（持久化在 app_settings 的 `ai.health`）。
 *
 * 为什么要有：复核/生成失败此前是「catch → 静默放行」，坏掉时只能翻日志，
 * 而且下一次成功会把失败痕迹全抹掉 —— 事后根本判断不出「到底是限流、密钥还是余额」。
 * 这里把最近一次尝试 / 成功 / 失败记成一条 JSON，管理端接口与每日推荐接口都读它。
 *
 * 分类口径（用户拍板）：401/403 → auth，402/余额 → billing，429 → ratelimit，
 * 超时/AbortError → timeout，JSON 解析失败 → parse，其余一律 error。
 */
import { getSetting, setSetting } from '../db/repo/settings.ts';

export const AI_HEALTH_KEY = 'ai.health';

/** 失败分类 */
export type AiFailureKind = 'timeout' | 'ratelimit' | 'auth' | 'billing' | 'parse' | 'error';

const AI_FAILURE_KINDS: readonly AiFailureKind[] = [
  'timeout',
  'ratelimit',
  'auth',
  'billing',
  'parse',
  'error',
];

/** 这里只有"够复现判断"的信息，别把整段上游响应灌进 settings */
const MESSAGE_MAX = 300;

export interface AiFailure {
  at: number;
  kind: AiFailureKind;
  message: string;
}

export interface AiHealth {
  /** 最近一次成功的时间戳（从未成功过则没有该字段） */
  lastSuccessAt?: number;
  /** 最近一次尝试的时间戳；0 = 从未尝试 */
  lastAttemptAt: number;
  /** 连续失败次数（一次成功清零） */
  consecutiveFailures: number;
  /** 最近一次失败（成功后保留，方便事后看"上一次为什么坏"） */
  lastFailure?: AiFailure;
}

function clip(message: string): string {
  const text = (message ?? '').trim();
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text;
}

function isFailureKind(value: unknown): value is AiFailureKind {
  return typeof value === 'string' && (AI_FAILURE_KINDS as readonly string[]).includes(value);
}

/** 空档案：`lastAttemptAt: 0` 表示"还没尝试过"（与"尝试过但没记录"区分开） */
function emptyHealth(): AiHealth {
  return { lastAttemptAt: 0, consecutiveFailures: 0 };
}

/** 读健康度；没记录过或记录损坏一律回空档案，绝不因为台账坏了打断生成流程 */
export function readAiHealth(): AiHealth {
  const raw = getSetting(AI_HEALTH_KEY);
  if (!raw) return emptyHealth();

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') return emptyHealth();
    parsed = value as Record<string, unknown>;
  } catch {
    return emptyHealth();
  }

  const health = emptyHealth();

  const lastAttemptAt = Number(parsed.lastAttemptAt);
  if (Number.isFinite(lastAttemptAt) && lastAttemptAt > 0) health.lastAttemptAt = lastAttemptAt;

  const failures = Number(parsed.consecutiveFailures);
  if (Number.isFinite(failures) && failures > 0) health.consecutiveFailures = Math.floor(failures);

  const lastSuccessAt = Number(parsed.lastSuccessAt);
  if (Number.isFinite(lastSuccessAt) && lastSuccessAt > 0) health.lastSuccessAt = lastSuccessAt;

  const failure = parsed.lastFailure as Record<string, unknown> | undefined;
  if (failure && typeof failure === 'object' && isFailureKind(failure.kind)) {
    const at = Number(failure.at);
    health.lastFailure = {
      at: Number.isFinite(at) && at > 0 ? at : health.lastAttemptAt,
      kind: failure.kind,
      message: clip(String(failure.message ?? '')),
    };
  }

  return health;
}

function writeAiHealth(health: AiHealth): void {
  setSetting(AI_HEALTH_KEY, JSON.stringify(health));
}

/** 一次成功：连续失败清零（偶发限流不该让服务长时间显示降级） */
export function recordAiSuccess(): void {
  const health = readAiHealth();
  const now = Date.now();
  writeAiHealth({
    ...health,
    lastAttemptAt: now,
    lastSuccessAt: now,
    consecutiveFailures: 0,
  });
}

/** 一次失败：连续失败 +1，记下原因（不抛异常：记账失败不该打挂调用方） */
export function recordAiFailure(kind: AiFailureKind, message: string): void {
  const health = readAiHealth();
  const now = Date.now();
  writeAiHealth({
    ...health,
    lastAttemptAt: now,
    consecutiveFailures: health.consecutiveFailures + 1,
    lastFailure: { at: now, kind, message: clip(message) },
  });
}

/**
 * 把一次调用异常翻译成失败分类。
 *
 * 顺序有讲究：**先判永久错误（auth/billing），再判可恢复错误**。
 * 反过来的话，"余额不足（402）"这类消息里若带 rate/quota 字样会被误判成限流，
 * 然后被退避重试白白拖 85 秒。
 */
export function classifyAiFailure(err: unknown): { kind: AiFailureKind; message: string } {
  const e = err as { name?: string; message?: string } | undefined;
  const message = clip(String(e?.message ?? err ?? '未知错误')) || '未知错误';
  const text = `${e?.name ?? ''} ${message}`;

  if (
    /\b(401|403)\b|unauthor|forbidden|invalid[ _-]?api[ _-]?key|authentication|模型未配置|not configured/i.test(
      text
    )
  ) {
    // 「模型未配置」与 401 同类：都属于"配置坏了，重试无用"
    return { kind: 'auth', message };
  }
  if (
    /\b402\b|payment required|insufficient[ _-]?(quota|balance|credit|funds)|exceeded your current quota|余额|欠费|额度不足/i.test(
      text
    )
  ) {
    return { kind: 'billing', message };
  }
  if (/\b429\b|rate[ _-]?limit|too many requests|限流|请求过于频繁/i.test(text)) {
    return { kind: 'ratelimit', message };
  }
  if (/\b408\b|timeout|timed out|超时|abort/i.test(text)) {
    return { kind: 'timeout', message };
  }
  if (/\bjson\b|parse|unexpected token|解析失败|无法解析/i.test(text)) {
    return { kind: 'parse', message };
  }
  return { kind: 'error', message };
}

export type AiHealthVerdict = 'ok' | 'degraded' | 'broken';

export interface AiHealthView extends AiHealth {
  verdict: AiHealthVerdict;
  /** 可直接上屏的中文判断（ok 时为空串） */
  hint: string;
}

const FAILURE_VIEW: Record<AiFailureKind, { verdict: AiHealthVerdict; hint: string }> = {
  auth: { verdict: 'broken', hint: '疑似密钥失效（401），请检查模型配置' },
  billing: { verdict: 'broken', hint: '疑似余额不足' },
  ratelimit: { verdict: 'degraded', hint: '疑似限流，请稍后重试' },
  timeout: { verdict: 'degraded', hint: '模型响应超时，请稍后重试' },
  parse: { verdict: 'degraded', hint: '模型响应无法解析' },
  error: { verdict: 'degraded', hint: '模型调用异常，请查看服务端日志' },
};

/** 连续失败到这个次数，就不是"偶发限流"了：degraded 升级为 broken */
const BROKEN_AFTER_FAILURES = 3;

/** 管理端视图：健康度 + 一句人话判定 */
export function readAiHealthView(): AiHealthView {
  const health = readAiHealth();
  const failure = health.lastFailure;
  if (health.consecutiveFailures <= 0 || !failure) {
    return { ...health, verdict: 'ok', hint: '' };
  }

  const view = FAILURE_VIEW[failure.kind] ?? FAILURE_VIEW.error;
  const verdict: AiHealthVerdict =
    view.verdict === 'degraded' && health.consecutiveFailures >= BROKEN_AFTER_FAILURES
      ? 'broken'
      : view.verdict;
  return { ...health, verdict, hint: view.hint };
}
