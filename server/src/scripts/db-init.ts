/**
 * 建库 / 升级 schema。
 *
 * 幂等：已应用的迁移会跳过。可以放心地在每次部署启动前跑一次。
 *
 * 运行：npm run db:init
 */

import { config, SERVER_ROOT } from '../config.ts';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { countTracks } from '../db/repo/tracks.ts';
import { countSources } from '../db/repo/sources.ts';

function main(): number {
  const dbPath = config.dbPath;
  process.stdout.write('SuenMusic 服务端 —— 数据库初始化\n');
  process.stdout.write(`库文件：${dbPath.replace(SERVER_ROOT, '.')}\n`);

  openDatabase(dbPath);
  const applied = migrate();

  if (applied === 0) {
    process.stdout.write('schema 已是最新，无需迁移。\n');
  } else {
    process.stdout.write(`已应用 ${applied} 个迁移。\n`);
  }

  const t = countTracks();
  const s = countSources();
  process.stdout.write(
    `当前数据：曲目缓存 ${t} 条，音源缓存 ${s.total} 条（其中成功 ${s.positive} 条）\n`
  );

  process.stdout.write('完成。\n');
  return 0;
}

let code = 1;
try {
  code = main();
} finally {
  closeDatabase();
}
process.exit(code);
