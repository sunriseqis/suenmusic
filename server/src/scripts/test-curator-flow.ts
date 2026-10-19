import { openDatabase, closeDatabase } from '../db/index.ts';
import { runDailyFlow } from '../services/ai-flow.ts';

async function main() {
  openDatabase();
  console.log('=== 为测试用户 8 (收藏仅 3 首歌的冷启动场景) 运行专属推荐生成 ===');
  const t0 = Date.now();
  const r = await runDailyFlow(8, { count: 30 });
  const costSec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== 生成结果 (耗时 ${costSec}s) ===`);
  console.log(`落地状态: landed=${r.landed}, shortfall=${r.shortfall}`);
  console.log(`当日导语 (greeting): "${r.greeting}"`);
  console.log(`开屏短语 (welcomePhrase): "${r.welcomePhrase}"`);
  console.log(`审核打回: ${r.rejected} 首, 补位: ${r.refilled} 首`);

  const listA = r.lists[0];
  if (listA) {
    console.log(`\n=== 歌单 A (共 ${listA.picks.length} 首) ===`);
    listA.picks.forEach((p, i) => {
      console.log(
        `${String(i + 1).padStart(2, ' ')}. [${p.source}] ${p.name} - ${p.artist} | 理由: ${p.reason}`
      );
    });
  }

  closeDatabase();
}

main().catch(err => {
  console.error('Flow test error:', err);
  process.exit(1);
});
