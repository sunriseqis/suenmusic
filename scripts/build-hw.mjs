#!/usr/bin/env node
/**
 * 鸿蒙 NEXT HAP 构建脚本：hvigorw 构建**未签名** HAP（供 CI 与侧签工具使用）。
 *
 * 客户端已全原生化（`pages/NativeRoot` 是 ArkUI 页面），**不再消费 web/dist** ——
 * 所以默认构建不再跑 web 同步。旧的 ArkWeb 壳（`pages/Index.ets`）已不是入口页，
 * 只有在需要手工回退验证 WebView 壳时，才显式加 `--with-web`。
 *
 * 用法：
 *   node scripts/build-hw.mjs               # 编译未签名 HAP → output/SuenMusic-v<版本>-unsigned.hap
 *   node scripts/build-hw.mjs --with-web    # 额外把 web/dist 同步进 rawfile（仅回退壳用）
 *   node scripts/build-hw.mjs --sync-only   # 只做 web → rawfile 同步
 *
 * 签名：**故意不配**。CI 出未签名 HAP，真机由侧签工具签名；虚拟机不需要签名。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HW_DIR = join(ROOT, 'hw');
const OUTPUT_DIR = join(ROOT, 'output');
const SYNC_ONLY = process.argv.includes('--sync-only');
/** 默认不再同步 web/dist：原生客户端不消费它；只有回退 WebView 壳时才需要 */
const WITH_WEB = process.argv.includes('--with-web') || SYNC_ONLY;

function log(msg) {
  console.log(`[build-hw] ${msg}`);
}

function fail(message) {
  console.error(`\n✖ [build-hw] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function output(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options }).trim();
}

async function readVersionName() {
  const raw = (await readFile(join(ROOT, 'VERSION'), 'utf8')).trim();
  if (!/^\d+(?:\.\d+)*$/.test(raw)) {
    fail(`VERSION 文件内容不是合法版本号：${JSON.stringify(raw)}`);
  }
  return raw;
}

function readVersionCode(versionName) {
  try {
    const count = Number(output('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT }));
    if (Number.isInteger(count) && count > 0) {
      return { code: 20000 + count, source: `20000 + git 提交数 ${count}` };
    }
  } catch {
    /* 无法执行 git 时回退到版本号推导 */
  }
  const [major = 0, minor = 0, patch = 0] = versionName.split('.').map(Number);
  return {
    code: 20000 + major * 100 + minor * 10 + patch,
    source: `按版本号推导`,
  };
}

async function syncWeb() {
  log('同步 Web 静态资源至鸿蒙 rawfile 目录（仅回退 WebView 壳需要）...');
  run('node', [join(ROOT, 'scripts/sync-hw.mjs')]);
}

async function injectVersion(versionName, versionCode) {
  log(`注入版本号至鸿蒙工程: ${versionName} (${versionCode})...`);
  const appJsonPath = join(HW_DIR, 'AppScope/app.json5');
  if (existsSync(appJsonPath)) {
    let content = await readFile(appJsonPath, 'utf8');
    content = content.replace(/"versionName":\s*"[^"]*"/, `"versionName": "${versionName}"`);
    content = content.replace(/"versionCode":\s*\d+/, `"versionCode": ${versionCode}`);
    await writeFile(appJsonPath, content, 'utf8');
  }
}

async function assembleHap(versionName, versionCode) {
  log('执行 Hvigor 编译未签名 HAP...');
  const hvigorw = join(HW_DIR, 'hvigorw');

  // `hvigorw` 是 bash 脚本（#!/usr/bin/env bash），Windows 不能直接 spawn，
  // 只会报一个看不懂的 ENOEXEC/EACCES。CI 跑在 ubuntu 所以一直没暴露。
  // 本地 Windows 请用 DevEco Studio 构建，或在 Git Bash / WSL 里跑本脚本。
  if (process.platform === 'win32') {
    fail('hvigorw 是 bash 脚本，Windows 上无法直接执行；请用 DevEco Studio 构建，或在 Git Bash / WSL 里运行本脚本。');
  }

  // 兜底补执行位：git 索引里是 100755，但 Windows 上 clone/copy 会丢，
  // 丢失后 execFileSync 直接 EACCES（报错只是一句 Permission denied，很难定位）。
  if (!existsSync(hvigorw)) {
    fail(`缺少 ${hvigorw}：鸿蒙工程不完整`);
  }
  try {
    await chmod(hvigorw, 0o755);
  } catch (err) {
    fail(`无法为 hvigorw 补执行位：${err?.message ?? err}`);
  }

  const args = [
    'assembleHap',
    '--mode', 'module',
    '-p', 'module=entry@default',
    '-p', 'product=default',
    '-p', `versionName=${versionName}`,
    '-p', `versionCode=${versionCode}`,
    '--no-daemon',
    '--accept-license',
  ];

  run(hvigorw, args, { cwd: HW_DIR });

  // 检索产物目录
  const candidateDirs = [
    join(HW_DIR, 'entry/build/default/outputs/default'),
    join(HW_DIR, 'build/outputs/default'),
  ];

  let foundHap = null;
  for (const dir of candidateDirs) {
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith('.hap'));
      if (files.length > 0) {
        foundHap = join(dir, files[0]);
        break;
      }
    }
  }

  if (!foundHap) {
    fail('Hvigor 编译完成，但未在 outputs 目录找到 .hap 产物！');
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const targetHap = join(OUTPUT_DIR, `SuenMusic-v${versionName}-unsigned.hap`);

  await copyFile(foundHap, targetHap);

  const { size } = await stat(targetHap);
  log(`✔ HAP 打包成功！产物：${targetHap}`);
  log(`  大小 ${(size / 1024 / 1024).toFixed(2)} MB（未签名，供测试与自签使用）`);
}

const versionName = process.env.CUSTOM_VERSION || (await readVersionName());
const { code: versionCode, source } = readVersionCode(versionName);
log(`当前目标版本: v${versionName} / versionCode: ${versionCode} (${source})`);

if (WITH_WEB) {
  await syncWeb();
}

if (SYNC_ONLY) {
  log('✔ 已完成静态资源同步（--sync-only）。');
} else {
  await injectVersion(versionName, versionCode);
  await assembleHap(versionName, versionCode);
}
