import { openDatabase, closeDatabase } from '../db/index.ts';
import { getAdaptivePoolFloor, GLOBAL_SIMI_BUDGET, getActiveUserIds } from '../services/library-topup.ts';
import { quotasFor } from '../services/ai-decide.ts';
import { buildCandidatePool } from '../services/ai-recall.ts';

async function main() {
  openDatabase();
  console.log('=== 1. 测试多用户列表与活跃账号 ===');
  const userIds = getActiveUserIds();
  console.log('Active user IDs:', userIds);

  console.log('\n=== 2. 测试自适应健康线 (Adaptive Pool Floor) ===');
  for (const uid of userIds) {
    const floor = getAdaptivePoolFloor(uid);
    console.log(`User ${uid} 自适应健康线:`, floor);
  }
  console.log('GLOBAL_SIMI_BUDGET:', GLOBAL_SIMI_BUDGET);

  console.log('\n=== 3. 测试流水自适应配额 (Water-Filling Quotas) ===');
  // 场景 A: 老用户候选充沛
  const richPool = { simi: 60, playlist: 30, seedOld: 20, chart: 10 };
  const richQuota = quotasFor(30, richPool);
  console.log('场景 A [老用户充沛] 理想配额:', richQuota, '总和:', Object.values(richQuota).reduce((a, b) => a + b, 0));

  // 场景 B: 少样本/冷启动用户 (simi 只有 2 首，seedOld 只有 1 首)
  const coldPool = { simi: 2, playlist: 60, seedOld: 1, chart: 20 };
  const coldQuota = quotasFor(30, coldPool);
  console.log('场景 B [冷启动极少样本] 流水补位配额:', coldQuota, '总和:', Object.values(coldQuota).reduce((a, b) => a + b, 0));
  if (Object.values(coldQuota).reduce((a, b) => a + b, 0) === 30) {
    console.log('✓ 场景 B 成功流水补位，总和严格等于 30！不再出现 13 首死结！');
  } else {
    console.error('✗ 场景 B 失败，总和不等于 30！');
  }

  console.log('\n=== 4. 测试候选池构建与流水补位 (Build Candidate Pool) ===');
  // 测试账号 8 (uicheck_tmp)
  const testUserId = userIds.includes(8) ? 8 : userIds[0];
  console.log(`正在为测试用户 ${testUserId} 构建候选池...`);
  const poolRes = await buildCandidatePool(testUserId);
  console.log(`候选池总数: ${poolRes.candidates.length} 首`);
  console.log('各来源计数:', poolRes.counts);
  console.log('丢弃重复/垃圾数:', poolRes.dropped);

  if (poolRes.candidates.length >= 80) {
    console.log('✓ 候选池成功流水补位至 ≥ 80 首！');
  } else {
    console.log(`! 候选池 ${poolRes.candidates.length} 首（受当前未消耗歌单与网络情况限制）`);
  }

  // 计算测试用户候选池的流水配额
  const actualQuota = quotasFor(30, {
    simi: poolRes.counts.simi,
    playlist: poolRes.counts.playlist,
    seedOld: poolRes.counts.seedOld,
    chart: poolRes.counts.chart,
  });
  console.log('根据该用户实际候选池分配的 30 首流水配额:', actualQuota, '总和:', Object.values(actualQuota).reduce((a, b) => a + b, 0));

  closeDatabase();
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
