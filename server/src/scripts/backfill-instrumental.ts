/**
 * 器乐 / 翻奏 / 片段维度回填（2026-10-29 用户裁定，方案 B）。
 *
 * 背景：`track_tags.is_instrumental` 是**后加的维度**，存量 8308 行标签里这一列全是 NULL。
 * 召回按字段过滤（ai-recall 的 push）只对 `=1` 生效，NULL 等于「还没判」—— 不补一遍，
 * 第二道防线对存量曲目形同不存在。
 *
 * 用法：
 *   node src/scripts/backfill-instrumental.ts --dry-run        # 只报数，不写库
 *   node src/scripts/backfill-instrumental.ts --limit 150      # 本次判 150 首
 *   node src/scripts/backfill-instrumental.ts                  # 默认 150 首
 *
 * 两步走：
 *   ① `syncLibraryTrackTags`：给 `library_tracks` 里还没有标签行的曲目补启发式标签（零网络），
 *      这一步只填 styles/language，`is_instrumental` 留 NULL；
 *   ② `tagInstrumental`：只挑 `is_instrumental IS NULL` 的曲目，每批 15 首调一次模型。
 *      模型失败的那批保持 NULL（下次再判），不会写假判定。
 *
 * 为什么要 --limit：一次把 8000+ 首全喂给模型会打爆 AI 配额，且长跑容易中途被杀。
 * 想全量补完就多跑几次（脚本幂等，只补没判定的）。
 */
import { config } from '../config.ts';
import { closeDatabase, getDatabase, openDatabase } from '../db/index.ts';
import { readAiConfig } from '../services/ai-client.ts';
import {
  countUnjudgedInstrumental,
  syncLibraryTrackTags,
  tagInstrumental,
} from '../services/ai-tags.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('backfill-instrumental');

interface Args {
  limit: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const dryRun = argv.includes('--dry-run');
  const i = argv.findIndex(a => a === '--limit' || a.startsWith('--limit='));
  let limit = 150;
  if (i >= 0) {
    const raw = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
  } else {
    // 也允许裸数字：backfill-instrumental.ts 200
    const bare = argv.find(a => /^\d+$/.test(a));
    if (bare) limit = Number(bare);
  }
  return { limit, dryRun };
}

/** 还没有任何标签行的曲目（要先补启发式标签，才会进入 ② 的候选集） */
function countMissingTagRows(): { tracks: number; library: number } {
  const db = getDatabase();
  const t = db
    .prepare('SELECT COUNT(*) AS n FROM tracks t LEFT JOIN track_tags g ON g.track_id = t.id WHERE g.track_id IS NULL')
    .get() as { n?: number } | undefined;
  const lt = db
    .prepare('SELECT COUNT(*) AS n FROM library_tracks lt LEFT JOIN track_tags g ON g.track_id = lt.id WHERE g.track_id IS NULL')
    .get() as { n?: number } | undefined;
  return { tracks: Number(t?.n ?? 0), library: Number(lt?.n ?? 0) };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  openDatabase(config.dbPath);

  const before = countUnjudgedInstrumental();
  const missing = countMissingTagRows();
  const cfg = readAiConfig();
  process.stdout.write(
    `器乐维度回填（${args.dryRun ? 'DRY-RUN 不写库' : '实际写入'}）\n` +
      `  已有标签行但 is_instrumental 为 NULL：${before} 首\n` +
      `  连标签行都没有（需先补启发式标签）：tracks ${missing.tracks} 首 / library_tracks ${missing.library} 首\n` +
      `  本次上限：${args.limit} 首 · 模型：${cfg ? cfg.model : '未配置（无法判定器乐维度）'}\n`
  );

  if (args.dryRun) {
    process.stdout.write(`\n[dry-run] 待判定合计 ${before} 首（不含上面 ${missing.tracks + missing.library} 首待补标签的）—— 未写入任何数据。\n`);
    return 0;
  }
  if (!cfg) {
    process.stdout.write('\nAI 未配置：器乐维度只能靠模型判定，本次退出。\n');
    return 0;
  }

  // ① 先把没有标签行的 library_tracks 补上启发式标签（零网络），让它们进入 ② 的候选集
  const synced = syncLibraryTrackTags(args.limit);
  process.stdout.write(`\n① 建库同步打标：${synced} 首 library_tracks 补上启发式标签\n`);

  // ② 分批判器乐维度：每次取一小片（≤ 上限），循环到没活或到上限为止
  let judged = 0;
  let rounds = 0;
  while (judged < args.limit) {
    const slice = Math.min(args.limit - judged, 150);
    const stats = await tagInstrumental(slice);
    rounds += 1;
    if (stats.tagged === 0) break;
    judged += stats.tagged;
    const left = countUnjudgedInstrumental();
    process.stdout.write(
      `② 第 ${rounds} 批：判定 ${stats.tagged} 首（累计 ${judged}）· 剩余未判定 ${left} 首\n`
    );
  }

  const after = countUnjudgedInstrumental();
  process.stdout.write(
    `\n完成：本次判定 ${judged} 首 · 未判定从 ${before} 降到 ${after}（还剩 ${after} 首，多跑几次可补完）\n`
  );
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  log.error(`回填失败：${(err as Error).message}`);
  code = 1;
} finally {
  closeDatabase();
}
process.exit(code);
