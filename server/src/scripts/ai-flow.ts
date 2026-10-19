/**
 * 每日歌单整条流程（分批 → 审核 → 补位 → 写记忆 → 两份落库）。
 * 用法：npm run ai:flow [数量]
 */
import { runDailyFlow } from '../services/ai-flow.ts';
const count = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) ?? 40);
const t0 = Date.now();
const r = await runDailyFlow(1, { count });
console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!r.landed || !r.lists[0]) {
  console.log(`\n⚠️ 歌单未落地（landed=false, shortfall=${r.shortfall}）`);
  console.log('问候语：' + (r.greeting || '（无）'));
  process.exit(0);
}
console.log('\n=== 歌单 A（' + r.lists[0].picks.length + ' 首）===');
r.lists[0].picks.forEach((p, i) => console.log(String(i + 1).padStart(2) + '. [' + p.source + '] ' + p.name + ' — ' + p.artist));
console.log('\n问候语：' + r.greeting);
console.log('欢迎短语：' + (r.welcomePhrase || '（无）'));
console.log('审核打回 ' + r.rejected + ' 首 · 补位 ' + r.refilled + ' 首');
process.exit(0);
