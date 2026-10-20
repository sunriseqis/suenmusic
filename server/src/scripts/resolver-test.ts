/**
 * 解析服务验收脚本（P2）。
 *
 * 在**临时库**上跑，跑完自动删除。上游调用预算是刻意压到最低的（约 5 次 B 站请求）：
 * 连续高频打同一个接口会把自己打进风控，那就变成了"测试导致的失败"。
 *
 * 覆盖：冷却器单元行为、冷解析、并发去重、内存命中、持久层命中、
 *       负缓存、缓存失效、冷却快速失败、过期清理。
 *
 * 运行：npm run test:resolver [-- "歌名 歌手"]
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SERVER_ROOT } from '../config.ts';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { getSource } from '../db/repo/sources.ts';
import { deleteAnchor } from '../db/repo/anchors.ts';
import { Cooldown } from '../utils/backoff.ts';
import {
  biliCooldown,
  getUpstreamStats,
  resetUpstreamStats,
} from '../sources/bilibili/stream.ts';
import { searchQQ } from '../sources/qq/search.ts';
import {
  cacheKey,
  clearMemoryCache,
  invalidateTrack,
  pruneExpired,
  resetResolverStats,
  resolveTrack,
  resolverStats,
} from '../services/resolver.ts';
import type { ResolveInput } from '../sources/bilibili/stream.ts';

// ---------- 迷你断言框架 ----------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    process.stdout.write(`  OK   ${name}\n`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function note(text: string): void {
  process.stdout.write(`       ${text}\n`);
}

// ---------- 环境 ----------

const tmpDb = join(SERVER_ROOT, 'data', `.restest-${randomBytes(4).toString('hex')}.db`);

function cleanup(): void {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(tmpDb + suffix, { force: true });
    } catch {
      // 清理失败不影响结论
    }
  }
}

async function main(): Promise<number> {
  process.stdout.write('SuenMusic 服务端 —— 解析服务验收 (P2)\n');
  process.stdout.write(`临时库：${tmpDb}\n`);

  openDatabase(tmpDb);
  migrate();

  // ---- 1. 冷却器（纯单元，无网络） ----
  section('[1/8] 冷却器（风控退避）');
  const cd = new Cooldown('test', { baseMs: 1000, maxMs: 10_000 });

  check('初始不处于冷却', !cd.active());
  eq('初始剩余 0', cd.remainingMs(), 0);

  const first = cd.trip('第一次');
  eq('首次冷却时长 = baseMs', first, 1000);
  check('命中后处于冷却', cd.active());
  check('剩余时间 > 0', cd.remainingMs() > 0);
  eq('原因被记录', cd.snapshot().reason, '第一次');
  eq('连续命中次数为 1', cd.snapshot().strikes, 1);

  const second = cd.trip('第二次');
  eq('第二次翻倍', second, 2000);
  const third = cd.trip('第三次');
  eq('第三次再翻倍', third, 4000);
  eq('连续命中次数为 3', cd.snapshot().strikes, 3);

  cd.reset();
  check('重置后退出冷却', !cd.active());
  eq('重置后连续次数归零', cd.snapshot().strikes, 0);
  eq('重置后剩余 0', cd.remainingMs(), 0);

  // 上限封顶
  const capped = new Cooldown('cap', { baseMs: 1000, maxMs: 3000 });
  capped.trip();
  capped.trip();
  const thirdCapped = capped.trip();
  eq('冷却时长不超过 maxMs', thirdCapped, 3000);

  // 指数不会溢出（strikes 封顶 20）
  const overflow = new Cooldown('of', { baseMs: 60_000, maxMs: 900_000 });
  for (let i = 0; i < 30; i++) overflow.trip();
  eq('连续 30 次命中仍封顶在 maxMs', overflow.remainingMs() <= 900_000, true);

  const forced = new Cooldown('f', { baseMs: 1000, maxMs: 1000 });
  forced.forceUntil(500, 'manual');
  check('forceUntil 可强制进入冷却', forced.active());
  eq('forceUntil 原因被记录', forced.snapshot().reason, 'manual');

  // ---- 2. 取一首真实曲目 ----
  section('[2/8] 取一首真实曲目（QQ）');
  const keyword = process.argv[2] || '笨蛋 陈奕迅';
  const search = await searchQQ(keyword, { limit: 5, slices: ['song'] });

  if (search.degraded.slices.length) {
    note(`QQ 分片被限流：${search.degraded.slices.join(',')} code=${search.degraded.code}`);
  }

  const track = search.songs[0];
  if (!track) {
    check('拿到一首 QQ 曲目', false, '搜索无结果，后续断言无法进行');
    return 1;
  }
  check('拿到一首 QQ 曲目', true);
  note(`${track.name} / ${track.ar.map(a => a.name).join('、')} / ${track.duration}s / id=${track.id}`);

  const input: ResolveInput = {
    id: track.id,
    name: track.name,
    artists: track.ar.map(a => a.name),
    durationMs: track.dt,
  };
  const key = cacheKey(input);
  eq('缓存键使用曲目 id', key, track.id);

  // ---- 3. 冷解析 ----
  section('[3/8] 冷解析（打上游）');
  resetUpstreamStats();
  resetResolverStats();

  const cold = await resolveTrack(input);
  const coldUpstream = getUpstreamStats();

  eq('命中层级为 upstream', cold.hitLevel, 'upstream');
  eq('解析成功', cold.ok, true);
  if (cold.source === 'bilibili') {
    check('拿到 bvid', !!cold.bvid, `bvid=${cold.bvid}`);
    eq('真实打了一次搜索', coldUpstream.search, 1);
    eq('真实取了一次 cid', coldUpstream.view, 1);
    eq('真实取了一次 playurl', coldUpstream.playurl, 1);
  } else {
    check('多源解析命中有效源', !!cold.source, `source=${cold.source}`);
  }
  check('拿到音频地址', !!cold.sourceUrl);
  check('置信度不低于阈值', cold.score >= 60, `score=${cold.score}`);
  eq('上游调用计数 = 1', resolverStats().upstreamCalls, 1);

  note(
    `source=${cold.source} bvid=${cold.bvid} score=${cold.score} 耗时=${cold.costMs}ms ` +
      `上游 search=${coldUpstream.search} view=${coldUpstream.view} playurl=${coldUpstream.playurl}`
  );
  check('结果已落库', getSource(key) !== null);

  if (!cold.ok) {
    note('冷解析未成功，后续缓存断言无意义，提前结束');
    return failed === 0 ? 0 : 1;
  }

  // ---- 4. 并发去重 ----
  section('[4/8] 并发去重（冷缓存下同曲 10 次并发）');
  // 必须先清空两级缓存。步骤 3 已经把结果写进去了，若不清就是"10 次内存命中"，
  // 测不到去重分支 —— 去重只在**真正的冷解析**上才有意义。
  invalidateTrack(key);
  deleteAnchor(key);
  resetUpstreamStats();
  resetResolverStats();

  // 同一 tick 内发起 10 次：必须只产生 1 次真实上游调用
  const batch = await Promise.all(Array.from({ length: 10 }, () => resolveTrack(input)));
  const batchUpstream = getUpstreamStats();

  eq('10 次调用全部返回', batch.length, 10);
  eq('全部命中层级为 upstream（共享同一次上游请求）', [
    ...new Set(batch.map(r => r.hitLevel)),
  ], ['upstream']);
  eq('10 次结果一致', [...new Set(batch.map(r => r.sourceUrl))].length, 1);
  if (cold.source === 'bilibili') {
    eq('上游 search 恰好 1 次（不是 10 次）', batchUpstream.search, 1);
    eq('上游 view 恰好 1 次', batchUpstream.view, 1);
    eq('上游 playurl 恰好 1 次', batchUpstream.playurl, 1);
  }
  eq('解析服务统计 upstreamCalls = 1', resolverStats().upstreamCalls, 1);
  eq('去重期间没有任何内存命中', resolverStats().memoryHits, 0);
  check('去重后结果已回填缓存', getSource(key) !== null);

  // ---- 5. 内存命中延迟 ----
  section('[5/8] 内存命中延迟');
  const ROUNDS = 200;
  const t0 = performance.now();
  for (let i = 0; i < ROUNDS; i++) {
    const r = await resolveTrack(input);
    if (r.hitLevel !== 'memory') {
      check('内存命中', false, `第 ${i} 轮 hitLevel=${r.hitLevel}`);
      break;
    }
  }
  const avg = (performance.now() - t0) / ROUNDS;
  check(`平均命中耗时 < 5ms（实测 ${avg.toFixed(3)}ms）`, avg < 5);
  eq('全部 200 次均为内存命中', resolverStats().memoryHits, ROUNDS);

  // ---- 6. 持久层命中（模拟进程重启） ----
  section('[6/8] 持久层命中（模拟进程重启）');
  clearMemoryCache();
  resetUpstreamStats();
  resetResolverStats();

  const afterRestart = await resolveTrack(input);
  const restartUpstream = getUpstreamStats();

  eq('命中层级为 db', afterRestart.hitLevel, 'db');
  eq('结果与冷解析一致', afterRestart.bvid, cold.bvid);
  eq('重启后未打上游（search=0）', restartUpstream.search, 0);
  eq('解析服务未记 upstreamCall', resolverStats().upstreamCalls, 0);
  eq('持久层命中计数 = 1', resolverStats().dbHits, 1);
  check('持久层命中后回填内存', resolverStats().memorySize >= 1);

  const again = await resolveTrack(input);
  eq('回填后再次命中内存', again.hitLevel, 'memory');

  // ---- 7. 负缓存 ----
  section('[7/8] 负缓存（匹配不到的曲子）');
  const missing: ResolveInput = {
    id: 'qq_zzzzzzzzzzzzzz',
    name: 'zzz-不存在的曲子-9f3a2b',
    artists: ['zzz-不存在的歌手'],
    durationMs: 123_000,
  };
  const missingKey = cacheKey(missing);

  clearMemoryCache();
  resetUpstreamStats();
  resetResolverStats();

  const missCold = await resolveTrack(missing);
  eq('冷解析命中层级为 upstream', missCold.hitLevel, 'upstream');
  eq('解析未成功', missCold.ok, false);
  check(
    '失败原因明确（非 error）',
    missCold.reason !== 'error',
    `reason=${missCold.reason} message=${missCold.message}`
  );
  check('给出失败原因文案', !!missCold.message, 'message 为空');
  check('负缓存已落库', getSource(missingKey) !== null);
  eq('负缓存记录的 ok 为 false', (getSource(missingKey)?.ok ?? true), false);

  resetUpstreamStats();
  resetResolverStats();
  const missAgain = await resolveTrack(missing);
  eq('重复请求命中内存', missAgain.hitLevel, 'memory');
  eq('重复请求未打上游', getUpstreamStats().search, 0);
  eq('重复请求结果一致', missAgain.reason, missCold.reason);

  clearMemoryCache();
  resetUpstreamStats();
  const missAfterRestart = await resolveTrack(missing);
  eq('重启后命中持久负缓存', missAfterRestart.hitLevel, 'db');
  eq('重启后仍未打上游', getUpstreamStats().search, 0);

  // ---- 8. 缓存失效与冷却快速失败 ----
  section('[8/8] 缓存失效 / 冷却快速失败 / 过期清理');

  // 用负缓存那首做失效测试：它的上游查询天然没有候选，代价最低
  invalidateTrack(missingKey);
  check('失效后持久层已清空', getSource(missingKey) === null);

  resetUpstreamStats();
  resetResolverStats();
  const afterInvalidate = await resolveTrack(missing);
  eq('失效后重新走上游', afterInvalidate.hitLevel, 'upstream');

  // 冷却窗口内必须快速失败，且不打上游
  clearMemoryCache();
  const freshKey: ResolveInput = {
    id: 'qq_cooltest000001',
    name: '冷却测试曲',
    artists: ['测试'],
    durationMs: 100_000,
  };

  biliCooldown.forceUntil(5000, '验收脚本强制冷却');
  resetUpstreamStats();
  resetResolverStats();

  const tCooldown = performance.now();
  const cooled = await resolveTrack(freshKey);
  const cooldownCost = performance.now() - tCooldown;
  const coolUpstream = getUpstreamStats();

  eq('冷却窗口内命中层级为 cooldown', cooled.hitLevel, 'cooldown');
  eq('冷却窗口内解析失败', cooled.ok, false);
  eq('失败原因是风控', cooled.reason, 'rejected');
  check('提示文案包含剩余秒数', /重试/.test(cooled.message ?? ''), `message=${cooled.message}`);
  eq('冷却期间未打上游', coolUpstream.search, 0);
  eq('冷却拒绝计数 +1', resolverStats().cooldownRejections, 1);
  check(`冷却响应是快速失败（实测 ${cooldownCost.toFixed(2)}ms）`, cooldownCost < 50);
  biliCooldown.reset();
  check('重置后退出冷却', !biliCooldown.active());

  // 过期清理
  const expiredCount = pruneExpired();
  note(`pruneExpired 清理了 ${expiredCount} 条（未过期的不应被清）`);
  check('未过期的缓存不被清理', getSource(key) !== null);

  const statsFinal = resolverStats();
  note(
    `最终统计：内存 ${statsFinal.memorySize} 条，` +
      `memoryHits=${statsFinal.memoryHits} dbHits=${statsFinal.dbHits} ` +
      `upstreamCalls=${statsFinal.upstreamCalls} errors=${statsFinal.errors}`
  );

  // ---- 汇总 ----
  process.stdout.write('\n' + '-'.repeat(60) + '\n');
  if (failed === 0) {
    process.stdout.write(`解析服务验收通过：${passed} 项全部通过。\n`);
    return 0;
  }
  process.stdout.write(`解析服务验收未通过：${passed} 通过 / ${failed} 失败。\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  return 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  process.stderr.write(`验收脚本异常：${(err as Error)?.stack ?? err}\n`);
  code = 1;
} finally {
  cleanup();
}
process.exit(code);
