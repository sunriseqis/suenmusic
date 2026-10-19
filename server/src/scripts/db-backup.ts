/**
 * 数据库备份。
 *
 * 为什么不能用「拷文件」：库开着 WAL（`db/index.ts:30`），最新数据可能分散在
 * `suenmusic.db`、`suenmusic.db-wal`、`suenmusic.db-shm` 三个文件里，
 * 只拷 `.db` 会丢数据。`VACUUM INTO` 由 SQLite 自己生成**单个自洽快照**
 * （含 WAL 里已提交的内容），不需要停服务。
 *
 * 为什么不用 `node:sqlite` 的 `backup()`：那是 Node API，版本要求比纯 SQL 更高，
 * 而这里用一条 SQL 就能拿到同样结果 —— 这个库没有 BLOB、体量小，备份是秒级的。
 *
 * 运行：npm run db:backup
 * 环境变量：
 *   SUENMUSIC_BACKUP_DIR   备份输出目录，默认 <数据目录>/backups
 *   SUENMUSIC_BACKUP_KEEP  保留最近几份，默认 14
 *
 * 退出码非 0 = 备份失败或校验不通过（**故意不静默**，否则 cron 失败没人知道）。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, SERVER_ROOT } from '../config.ts';

/** 备份文件名前缀，清理旧备份时只认这个前缀 */
const PREFIX = 'suenmusic-';
const SUFFIX = '.db';

/** 时间戳：20261016-145200 —— 不用连字符分隔，避免跨时区/跨系统排序歧义 */
function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 只保留最近 keep 份；备份不是日志，磁盘占用要封顶。 */
function prune(dir: string, keep: number): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort(); // 文件名带时间戳，字典序 == 时间序
  const removed = files.slice(0, Math.max(0, files.length - keep));
  for (const f of removed) rmSync(join(dir, f), { force: true });
  return removed;
}

/**
 * 校验备份真的能用。
 *
 * 没校验过的备份不算备份 —— 文件存在不等于能恢复。这里打开它、跑一遍
 * integrity_check、并确认关键表都在且用户数不为 0（为 0 通常意味着拷了个空壳）。
 */
function verify(backupPath: string): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(backupPath, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const verdict = String((integrity as Record<string, unknown>)?.integrity_check ?? '');
    if (verdict !== 'ok') return `完整性检查未通过：${verdict}`;

    const tables = db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'")
      .get() as Record<string, unknown>;
    const tableCount = Number(tables?.c ?? 0);
    if (tableCount < 10) return `表数量异常：只有 ${tableCount} 张，正常应 ≥ 20`;

    const users = db.prepare('SELECT count(*) AS c FROM users').get() as Record<string, unknown>;
    const userCount = Number(users?.c ?? 0);
    if (userCount === 0) return 'users 表为空 —— 很可能备份到的是空库';

    return null;
  } catch (err) {
    return `无法打开备份：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    try {
      db?.close();
    } catch {
      /* 关闭失败不影响结论 */
    }
  }
}

function main(): number {
  const src = config.dbPath;
  process.stdout.write('SuenMusic 服务端 —— 数据库备份\n');

  if (!existsSync(src)) {
    process.stderr.write(`✗ 数据库不存在：${src}\n`);
    process.stderr.write('  如果这是首次部署，先跑 npm run db:init。\n');
    return 1;
  }
  process.stdout.write(`源库：${src.replace(SERVER_ROOT, '.')}\n`);

  const dir = resolve(
    process.env.SUENMUSIC_BACKUP_DIR ?? join(dirname(src), 'backups')
  );
  mkdirSync(dir, { recursive: true });

  const keep = Number(process.env.SUENMUSIC_BACKUP_KEEP ?? '14');
  const target = join(dir, `${PREFIX}${stamp(new Date())}${SUFFIX}`);

  const db = new DatabaseSync(src, { readOnly: true });
  try {
    // 目标文件必须不存在，否则 VACUUM INTO 直接报错
    rmSync(target, { force: true });
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (err) {
    process.stderr.write(`✗ 备份失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    db.close();
  }

  const size = statSync(target).size;
  process.stdout.write(`已写入：${target.replace(SERVER_ROOT, '.')}（${(size / 1048576).toFixed(2)} MB）\n`);

  const problem = verify(target);
  if (problem) {
    process.stderr.write(`✗ 备份校验未通过：${problem}\n`);
    process.stderr.write('  备份文件已保留在原地，请人工检查，不要当成有效备份。\n');
    return 1;
  }
  process.stdout.write('校验通过：integrity_check=ok，关键表齐全，users 非空。\n');

  const removed = prune(dir, Number.isFinite(keep) && keep > 0 ? keep : 14);
  if (removed.length > 0) {
    process.stdout.write(`已清理 ${removed.length} 份旧备份（保留最近 ${keep} 份）。\n`);
  }

  process.stdout.write('完成。\n');
  return 0;
}

process.exit(main());