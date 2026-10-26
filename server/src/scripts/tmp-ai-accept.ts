/**
 * 临时验收脚本（验收完即删）：AI 复核三态 / 健康度 / 每日接口状态字段。
 * 在**临时库**上跑，绝不碰 data/suenmusic.db。
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { deleteSetting, getSetting, setSetting } from '../db/repo/settings.ts';
import { reviewPicks, REVIEW_RETRY_DELAYS_MS } from '../services/ai-review.ts';
import {
  AI_HEALTH_KEY,
  classifyAiFailure,
  readAiHealth,
  readAiHealthView,
  recordAiFailure,
  recordAiSuccess,
} from '../services/ai-health.ts';
import { register } from '../services/auth.ts';
import { buildApp } from '../app.ts';
import { todayStr } from '../utils/dates.ts';

const tmpDb = join(tmpdir(), `suenmusic-aihealth-${process.pid}-${Date.now()}.db`);
let failures = 0;

function out(title: string, value: unknown): void {
  process.stdout.write(`\n${title}\n  ${JSON.stringify(value)}\n`);
}

function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) failures += 1;
  process.stdout.write(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}\n`);
}

openDatabase(tmpDb);
migrate();

// ---------- ① readAiHealth 初始形态 / 写入后形态 ----------
const initial = readAiHealth();
out('①-1 readAiHealth() 初始', initial);
check('初始为空档案', initial.lastAttemptAt === 0 && initial.consecutiveFailures === 0);
check('初始无 lastSuccessAt/lastFailure', !initial.lastSuccessAt && !initial.lastFailure);

recordAiFailure('ratelimit', '模型返回 429：rate limited');
const afterFail = readAiHealth();
out('①-2 recordAiFailure(ratelimit) 之后 readAiHealth()', afterFail);
check('consecutiveFailures=1', afterFail.consecutiveFailures === 1);
check('lastFailure.kind=ratelimit', afterFail.lastFailure?.kind === 'ratelimit');
check('lastAttemptAt 有值', (afterFail.lastAttemptAt ?? 0) > 0);
out('①-3 管理端视图 readAiHealthView()', readAiHealthView());
check('verdict=degraded', readAiHealthView().verdict === 'degraded');
check('hint=疑似限流', readAiHealthView().hint === '疑似限流，请稍后重试');

recordAiFailure('auth', '模型返回 401：invalid api key');
const afterAuth = readAiHealthView();
out('①-4 连续两次失败（auth）视图', afterAuth);
check('consecutiveFailures=2', afterAuth.consecutiveFailures === 2);
check('verdict=broken', afterAuth.verdict === 'broken');
check('hint=密钥失效', afterAuth.hint === '疑似密钥失效（401），请检查模型配置');

recordAiSuccess();
const afterOk = readAiHealth();
out('①-5 recordAiSuccess() 之后 readAiHealth()', afterOk);
check('consecutiveFailures 清零', afterOk.consecutiveFailures === 0);
check('lastSuccessAt 有值', (afterOk.lastSuccessAt ?? 0) > 0);
check('成功后 verdict=ok / hint 空', readAiHealthView().verdict === 'ok' && readAiHealthView().hint === '');

out('①-6 classifyAiFailure 映射', {
  401: classifyAiFailure(new Error('模型返回 401：unauthorized')).kind,
  402: classifyAiFailure(new Error('模型返回 402：payment required')).kind,
  429: classifyAiFailure(new Error('模型返回 429：too many requests')).kind,
  timeout: classifyAiFailure(Object.assign(new Error('模型请求超时（900s）'), { name: 'AbortError' })).kind,
  parse: classifyAiFailure(new Error('模型响应 JSON 解析失败：Unexpected token')).kind,
  other: classifyAiFailure(new Error('boom')).kind,
});

// ---------- ② 路由 handler：无 payload + 失败状态 ----------
const app = buildApp();
const session = register({ username: `tmpai${Date.now() % 100000}`, password: 'tmp-pass-123456' });
const auth = { authorization: `Bearer ${session.accessToken}` };
process.stdout.write(`\n(临时用户 id=${session.user.id} role=${session.user.role})\n`);

// 让"最近一次生成失败"变成持久化状态（模拟复核 unavailable 之后重启）
recordAiFailure('timeout', '模型请求超时（900s）');
const failedRes = await app.inject({ method: 'GET', url: '/api/recommend/daily', headers: auth });
const failedBody = failedRes.json() as Record<string, unknown>;
out('②-1 无 payload + 失败状态 → GET /api/recommend/daily', {
  code: failedRes.statusCode,
  status: failedBody.status,
  statusMessage: failedBody.statusMessage,
  statusDetail: failedBody.statusDetail,
});
check('HTTP 200', failedRes.statusCode === 200);
check("status='failed'", failedBody.status === 'failed');
check(
  "statusMessage=契约原文",
  failedBody.statusMessage === '今天的歌单生成失败，请登录服务端确认模型状态'
);
check("statusDetail.code='timeout'", (failedBody.statusDetail as any)?.code === 'timeout');
check('tracks 为空', Array.isArray(failedBody.tracks) && (failedBody.tracks as unknown[]).length === 0);

// 有可用 payload（>= LAND_MIN 首）→ ready，且不应带失败字段
const picks = Array.from({ length: 30 }, (_, i) => ({
  trackId: `qq_tmp${i}`,
  name: `歌${i}`,
  artist: '临时',
  reason: '验收用例',
  source: 'seedNew',
}));
setSetting(`ai.daily.active:${session.user.id}`, JSON.stringify({ date: todayStr(), picks, snapshot: [] }));
const readyRes = await app.inject({ method: 'GET', url: '/api/recommend/daily', headers: auth });
const readyBody = readyRes.json() as Record<string, unknown>;
out('②-2 有可用 payload → GET /api/recommend/daily', {
  code: readyRes.statusCode,
  status: readyBody.status,
  hasStatusMessage: 'statusMessage' in readyBody,
  date: readyBody.date,
});
check("有 payload 时 status='ready'", readyBody.status === 'ready');
check('ready 不带 statusMessage/statusDetail', !('statusMessage' in readyBody) && !('statusDetail' in readyBody));

// ---------- ③ 三态：未配置模型 → unavailable(auth) 且**不重试**（立即返回） ----------
deleteSetting('ai.base_url');
deleteSetting('ai.api_key');
deleteSetting('ai.model');
deleteSetting('ai.models.config');
const startedAt = Date.now();
const outcome = await reviewPicks(
  [{ id: 'qq_x', name: '歌', artist: '人', source: 'seedNew', listNo: 1, reason: '理由' }],
  { lines: [] }
);
const elapsed = Date.now() - startedAt;
out('③-1 reviewPicks() 未配置模型 → 三态', { outcome, elapsedMs: elapsed });
check("status='unavailable'", outcome.status === 'unavailable');
check("reason='auth'（重试无意义，直接判不可用）", outcome.status === 'unavailable' && outcome.reason === 'auth');
check('没有走 5s/20s/60s 退避（<1000ms）', elapsed < 1000, `elapsed=${elapsed}ms`);
out('③-2 重试参数', { REVIEW_RETRY_DELAYS_MS });

out('ai.health 落库键值', JSON.parse(getSetting(AI_HEALTH_KEY) ?? '{}'));

await app.close();
closeDatabase();
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(tmpDb + suffix, { force: true });
  } catch {
    /* ignore */
  }
}

process.stdout.write(`\nEXIT=${failures === 0 ? 0 : 1}（失败 ${failures} 项）\n`);
process.exit(failures === 0 ? 0 : 1);
