/**
 * 建号 / 查号 CLI。
 *
 * **为什么必须有这条路**：注册开关一旦关闭，界面上就建不出账号了。
 * 若不提供 CLI，每次给家人开号都得"临时打开注册 → 让 TA 注册 → 再关掉"，
 * 而公网部署最常见的失败模式恰恰是**忘了关**。把建号能力收到服务端命令行，
 * 这个失败模式就从设计上消失了，也不用为了开个号去重启服务。
 *
 * 用法：
 *   npm run user:add -- -u alice -p <密码> -n 爱丽丝
 *   npm run user:add -- --list
 *
 * 注意：口令经命令行传入会留在 shell 历史里。这是本机自用场景下可接受的代价，
 * 换成交互式输入反而会让脚本无法在 CI / 远程 shell 里用。
 */

import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import {
  InvalidUsernameError,
  UsernameTakenError,
  WeakPasswordError,
  createUser,
  findUserByUsername,
  listUsers,
  updatePassword,
} from '../db/repo/users.ts';
import { PASSWORD_MIN_LENGTH } from '../utils/password.ts';

/**
 * 取参数值，同时支持 `-u alice` 与 `--username=alice` 两种写法。
 * 不引第三方 CLI 库 —— 只有三个参数，不值得为它加依赖。
 */
function readArg(...names: string[]): string | undefined {
  for (const name of names) {
    const i = process.argv.indexOf(name);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];

    const withEq = process.argv.find(a => a.startsWith(`${name}=`));
    if (withEq) return withEq.slice(name.length + 1);
  }
  return undefined;
}

function usage(): void {
  process.stdout.write(
    [
      '',
      '建号 / 查号 / 重置口令',
      '',
      '  npm run user:add -- -u <用户名> -p <密码> [-n <显示名>]',
      '  npm run user:add -- --reset -u <用户名> -p <新密码>',
      '  npm run user:add -- --list',
      '',
      '示例：',
      '  npm run user:add -- -u alice -p suenmusic2026 -n 爱丽丝',
      '  npm run user:add -- --reset -u alice -p new-pass-2026',
      '',
      '说明：',
      '  --reset 重置已有账号的口令（改完该账号所有已登录会话立即失效）。',
      '  账号不存在时报错退出，不会顺手建成新号 —— 建号请去掉 --reset。',
      '  注册开关：SUENMUSIC_ALLOW_REGISTRATION=true 时前端开放注册，',
      '  登录页据此显示/隐藏注册入口；首个账号永远可注册。',
      '',
      '用户名规则：3-32 位字母、数字、下划线或连字符',
      `口令长度：至少 ${PASSWORD_MIN_LENGTH} 位`,
      '',
    ].join('\n')
  );
}

function main(): number {
  openDatabase();
  migrate();

  // ---- 列出账号 ----
  if (process.argv.includes('--list') || process.argv.includes('-l')) {
    const users = listUsers();
    if (users.length === 0) {
      process.stdout.write('\n（还没有任何账号）\n\n');
      return 0;
    }

    process.stdout.write(`\n共 ${users.length} 个账号：\n\n`);
    for (const u of users) {
      const created = new Date(u.createdAt).toLocaleString('zh-CN');
      process.stdout.write(
        `  ${u.username.padEnd(20)}${u.displayName.padEnd(16)}创建于 ${created}\n`
      );
    }
    process.stdout.write('\n');
    return 0;
  }

  // ---- 建号 ----
  const username = readArg('-u', '--username');
  const password = readArg('-p', '--password');
  const displayName = readArg('-n', '--display-name', '--displayName');

  if (!username || !password) {
    usage();
    return 1;
  }

  // ---- 重置口令 ----
  if (process.argv.includes('--reset')) {
    const existing = findUserByUsername(username);
    if (!existing) {
      process.stderr.write(
        `\n重置失败：用户 ${username} 不存在。（建新号请去掉 --reset）\n\n`
      );
      return 1;
    }
    try {
      updatePassword(existing.id, password);
      process.stdout.write(
        `\n口令已重置：${existing.username}（${existing.display_name}）  id=${existing.id}\n` +
          '该账号此前签发的所有会话已失效，需要重新登录。\n\n'
      );
      return 0;
    } catch (err) {
      if (err instanceof WeakPasswordError) {
        process.stderr.write(`\n重置失败：${err.message}\n\n`);
        return 1;
      }
      throw err;
    }
  }

  try {
    const user = createUser({ username, password, displayName });
    process.stdout.write(
      `\n账号已创建：${user.username}（${user.displayName}）  id=${user.id}\n` +
        '现在可以在客户端用这个账号登录了。\n\n'
    );
    return 0;
  } catch (err) {
    if (err instanceof UsernameTakenError) {
      process.stderr.write(`\n创建失败：用户名 ${username} 已被占用。\n\n`);
      return 1;
    }
    if (err instanceof InvalidUsernameError) {
      process.stderr.write(
        '\n创建失败：用户名不合法。要求 3-32 位字母、数字、下划线或连字符。\n\n'
      );
      return 1;
    }
    if (err instanceof WeakPasswordError) {
      process.stderr.write(`\n创建失败：${err.message}\n\n`);
      return 1;
    }
    throw err;
  }
}

let code = 1;
try {
  code = main();
} catch (err) {
  process.stderr.write(`\n执行出错：${(err as Error)?.message ?? err}\n\n`);
  code = 1;
} finally {
  closeDatabase();
}
process.exit(code);
