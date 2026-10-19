/**
 * 建号 CLI 验收。
 *
 * **为什么单独测这条路径**：`npm run user:add` 绕开 HTTP 直接调仓储层，
 * 是唯一不受路由层校验约束的入口。它一旦失效（典型情形：口令策略只写在服务层），
 * 表现是"能建出弱口令账号"—— 既不报错，也不会有人立刻发现。
 * 所以这条路径必须有自己的验收，而不是靠"仓储层已经测过了"来推断。
 *
 * 每个用例都跑在**独立进程**里（CLI 是进程级工具，退出码是它契约的一部分），
 * 库指向临时文件，跑完删除。
 *
 * 运行：npm run test:cli
 */

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SERVER_ROOT } from '../config.ts';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import * as users from '../db/repo/users.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

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
  check(
    name,
    same,
    same ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
  );
}

const tmpDb = join(SERVER_ROOT, 'data', `.clitest-${randomBytes(4).toString('hex')}.db`);
const cliPath = join(SERVER_ROOT, 'src', 'scripts', 'user-add.ts');

interface CliResult {
  code: number;
  out: string;
}

/** 跑一次 CLI。参数走数组传递，避开 shell 的引号与编码问题。 */
function runCli(args: string[]): CliResult {
  const res = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', cliPath, ...args],
    {
      cwd: SERVER_ROOT,
      env: { ...process.env, SUENMUSIC_DB: tmpDb },
      encoding: 'utf8',
    }
  );

  return { code: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function cleanup(): void {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(tmpDb + suffix, { force: true });
    } catch {
      // 清理失败不影响验收结论
    }
  }
}

function main(): number {
  process.stdout.write('SuenMusic 服务端 —— 建号 CLI 验收\n');
  process.stdout.write(`临时库：${tmpDb}\n`);

  // ---- 1. 用法 ----
  process.stdout.write('\n[1/4] 参数与用法\n');
  const bare = runCli([]);
  eq('无参数时报错退出', bare.code, 1);
  check('无参数时打印用法', bare.out.includes('建号'), bare.out.slice(0, 120));

  const missingPw = runCli(['-u', 'nopass']);
  eq('只给用户名也不放行', missingPw.code, 1);

  // ---- 2. 策略拦截 ----
  process.stdout.write('\n[2/4] 策略拦截\n');
  // 关键用例：口令策略必须在仓储层生效，否则这条绕过 HTTP 的入口能建出弱口令账号
  const weak = runCli(['-u', 'weakuser', '-p', '123']);
  eq('过短口令被拒绝', weak.code, 1);
  check('给出可读的失败原因', weak.out.includes('创建失败'), weak.out.slice(0, 160));

  const badName = runCli(['-u', 'a b', '-p', 'goodpass123']);
  eq('非法用户名被拒绝', badName.code, 1);

  // ---- 3. 正常建号 ----
  process.stdout.write('\n[3/4] 建号与重名\n');
  const created = runCli(['-u', 'alice', '-p', 'goodpass123', '-n', '爱丽丝']);
  eq('建号成功退出码为 0', created.code, 0);
  check('输出确认信息', created.out.includes('账号已创建'), created.out.slice(0, 160));

  const dup = runCli(['-u', 'alice', '-p', 'otherpass123']);
  eq('重名被拒绝', dup.code, 1);
  check('提示用户名已被占用', dup.out.includes('已被占用'), dup.out.slice(0, 160));

  // `--key=value` 写法也要能用
  const eqStyle = runCli(['--username=bob', '--password=bobpass1234']);
  eq('支持 --key=value 写法', eqStyle.code, 0);

  // ---- 4. 列表与落库结果 ----
  process.stdout.write('\n[4/4] 列表与落库\n');
  const list = runCli(['--list']);
  eq('列表退出码为 0', list.code, 0);
  check('列表包含已建账号', list.out.includes('alice') && list.out.includes('bob'));
  check('列表带上显示名', list.out.includes('爱丽丝'));

  // 直接开库核对：CLI 写的确实是 SUENMUSIC_DB 指向的那个库
  openDatabase(tmpDb);
  migrate();
  check('账号真的落在指定库里', !!users.findUserByUsername('alice'));
  check('新口令可登录', !!users.authenticate('alice', 'goodpass123'));
  eq('初始令牌纪元为 1', users.getTokenEpoch(users.findUserByUsername('alice')!.id), 1);
  eq('弱口令账号未落库', users.findUserByUsername('weakuser'), null);

  return failed === 0 ? 0 : 1;
}

let code = 1;
try {
  code = main();
} catch (err) {
  process.stderr.write(`验收脚本异常：${(err as Error)?.stack ?? err}\n`);
  code = 1;
} finally {
  cleanup();
}

if (code === 0) {
  process.stdout.write(`\n建号 CLI 验收通过：${passed} 项全部通过。\n`);
} else {
  process.stdout.write(`\n建号 CLI 验收未通过：${passed} 通过 / ${failed} 失败。\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.exit(code);
