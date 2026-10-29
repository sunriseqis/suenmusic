/**
 * 第二批 · 选歌约束优化 实测脚本（不依赖 AI 输出，只验建池层硬约束与曲风画像读取）。
 * 用法：node src/scripts/verify-batch2.ts
 */
import { buildCandidatePool } from '../services/ai-recall.ts';
import { referTierArtistNames, topArtists } from '../services/artist-stats.ts';
import { topStyles } from '../services/playlist-pool.ts';

const userId = 1;
console.log(`=== 第二批 · 选歌约束实测 (user ${userId}) ===`);

const refer = referTierArtistNames(userId);
console.log(`[T1] refer 档（1-2 首收藏，不进 TOP 池）歌手数：${refer.size}`);

const style = topStyles(userId, 12);
console.log(`[T5] user_style_profile 被 ai-recall 读取（topStyles）：${style.length} 项 -> ${style.map(s => s.keyword + '(' + s.weight + ')').join(' ') || '(空)'}`);

const t0 = Date.now();
const { candidates, counts } = await buildCandidatePool(userId);
console.log('建池耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's；候选 ' + candidates.length + ' 首');
console.log('  来源分布：' + JSON.stringify(counts));

// T1: seedOld / seedNew 里不得出现 refer 档歌手（1-2 首不进 TOP 池）
const topPool = candidates.filter(c => c.source === 'seedOld' || c.source === 'seedNew');
const referLeaks = topPool.filter(c => refer.has((c.track.ar ?? [])[0]?.name ?? ''));
console.log('[T1] TOP 池（seedOld/seedNew）共 ' + topPool.length + ' 首；refer 档泄漏：' + referLeaks.length + ' 首 ' + (referLeaks.length === 0 ? '✅' : '❌ ' + referLeaks.map(c => (c.track.ar ?? [])[0]?.name).join(',')));

// TOP 歌手硬约束：每天最多 1 位 TOP 歌手（老歌 seedOld 里）
const tops = new Set(topArtists(userId).map(a => a.name));
const topInPool = topPool.filter(c => tops.has((c.track.ar ?? [])[0]?.name ?? '') && c.source !== 'seedNew');
const topNames = [...new Set(topInPool.map(c => (c.track.ar ?? [])[0]?.name ?? ''))];
console.log('[T1] 老歌里的 TOP 歌手（seedOld）：' + topNames.length + ' 位 ' + topNames.join(',') + '（应 <=1 位）');

// T5: simi 来源的候选应带受控标签（曲风参考参考物生效）
const simiWithTags = candidates.filter(c => c.source === 'simi' && c.styles.length > 0);
console.log('[T5] simi 候选带标签：' + simiWithTags.length + '/' + counts.simi + ' 首');

console.log('=== 汇总 ===');
console.log('T1 refer 泄漏 ' + (referLeaks.length === 0 ? 'PASS' : 'FAIL') + '；TOP 老歌歌手数 ' + (topNames.length <= 1 ? 'PASS' : 'FAIL'));
console.log('T5 user_style_profile 读取 ' + (style.length > 0 ? 'PASS' : 'EMPTY'));
process.exit(0);
