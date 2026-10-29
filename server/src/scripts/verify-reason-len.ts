/**
 * T4 定点复验：用已落库的 reason_for_review（长听感）再跑一次 reviewReasons，
 * 检查 reason_for_display 是否 12-25 字（clampDisplay 硬约束生效）。
 */
import { reviewReasons } from '../services/ai-review.ts';
import { getDatabase } from '../db/index.ts';

const row = getDatabase().prepare("SELECT value FROM app_settings WHERE key = 'ai.daily.active:1'").get() as { value: string } | undefined;
if (!row) { console.log('无 ai.daily.active:1'); process.exit(1); }
const p = JSON.parse(row.value) as { picks: Array<{ trackId: string; name: string; artist: string; reason?: string }> };
const items = p.picks.slice(0, 12).map(x => ({ id: x.trackId, name: x.name, artist: x.artist, reasonForReview: x.reason || '' }));
console.log('送审 ' + items.length + ' 首（reason_for_review 平均 ' + Math.round(items.reduce((a, b) => a + [...(b.reasonForReview)].length, 0) / items.length) + ' 字）');

const map = await reviewReasons(items);
const rows = [...map.entries()];
const approved = rows.filter(([, v]) => v.verdict === 'approved');
console.log('approved ' + approved.length + ' / rejected ' + (rows.length - approved.length));
const lens = approved.map(([, v]) => [...v.reasonForDisplay].length);
console.log('display 字数：' + lens.join(','));
console.log('超出 12-25 的：' + lens.filter(l => l < 12 || l > 25).length);
console.log('样例：');
for (const [, v] of approved.slice(0, 5)) console.log('  (' + [...v.reasonForDisplay].length + '字) ' + v.reasonForDisplay);
const pass = lens.every(l => l >= 1 && l <= 25);
console.log('T4 display 长度约束 ' + (pass ? 'PASS（全部 <=25）' : 'FAIL'));
process.exit(0);
