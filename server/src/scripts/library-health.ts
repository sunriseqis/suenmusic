/**
 * 手动跑一次池子体检（补库）。
 * 用法：npm run library:health
 */
import { ensurePoolHealth } from '../services/library-topup.ts';

const reports = await ensurePoolHealth(1);
if (reports.length === 0) {
  console.log('池子健康，无需补库 ✓');
} else {
  for (const r of reports) console.log(`[${r.source}] ${r.before} → ${r.action}`);
}
process.exit(0);
