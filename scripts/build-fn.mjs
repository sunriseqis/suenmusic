#!/usr/bin/env node
/**
 * 飞牛私有云（fnOS）原生应用套件（.fpk）自动化构建脚本。
 *
 * 核心设计原则：
 *   1. 100% 纯原生运行，拒绝 Docker 容器的伪应用包装；
 *   2. 内置独立 Node.js 22 运行时与纯 JS 生产依赖，开箱即用，免宿主机额外配置；
 *   3. 内置前端 SPA 静态产物（web/dist），单端口（3210）统一伺服 Web 与 API；
 *   4. 数据落地飞牛原生持久化目录（${TRIM_PKGVAR}/data），支持系统桌面与应用中心完整生命周期；
 *   5. 图标资产使用 SuenMusic 官方高清母版（256x256 / 64x64）。
 *
 * 用法：
 *   node scripts/build-fn.mjs
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FN_DIR = join(ROOT, 'fn');
const APP_DIR = join(FN_DIR, 'app');
const OUTPUT_DIR = join(ROOT, 'output');
const CACHE_DIR = join(homedir(), '.cache/suenmusic-fn');

function log(msg) {
  console.log(`[build-fn] ${msg}`);
}

function fail(message) {
  console.error(`\n✖ [build-fn] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function output(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options }).trim();
}

async function readSemver() {
  const raw = (await readFile(join(ROOT, 'VERSION'), 'utf8')).trim();
  const parts = raw.split('.');
  while (parts.length < 3) {
    parts.push('0');
  }
  const semver = parts.slice(0, 3).join('.');
  if (!/^\d+\.\d+\.\d+$/.test(semver)) {
    fail(`无法从 VERSION "${raw}" 解析有效语义化版本（X.Y.Z）：${semver}`);
  }
  return { raw, semver };
}

async function injectManifestVersion(semver) {
  log(`1/6 同步版本号至 fn/manifest: ${semver}...`);
  const manifestPath = join(FN_DIR, 'manifest');
  if (!existsSync(manifestPath)) {
    fail(`找不到 manifest 文件: ${manifestPath}`);
  }
  let content = await readFile(manifestPath, 'utf8');
  content = content.replace(/version\s*=\s*[^\r\n]*/, `version               = ${semver}`);
  await writeFile(manifestPath, content, 'utf8');
}

async function updateIconAssets() {
  log('2/6 校验并更新官方图标资产...');
  const masterIcon = join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png');
  if (!existsSync(masterIcon)) {
    fail(`找不到高清母版图标: ${masterIcon}`);
  }

  // 使用 Python PIL 从 1024x1024 母版精确下采样生成
  const pyCode = `
from PIL import Image
src = '${masterIcon}'
im = Image.open(src)
im.resize((256, 256), Image.Resampling.LANCZOS).save('${join(FN_DIR, 'ICON_256.PNG')}', format='PNG')
im.resize((256, 256), Image.Resampling.LANCZOS).save('${join(APP_DIR, 'ui/images/icon_256.png')}', format='PNG')
im.resize((64, 64), Image.Resampling.LANCZOS).save('${join(FN_DIR, 'ICON.PNG')}', format='PNG')
im.resize((64, 64), Image.Resampling.LANCZOS).save('${join(APP_DIR, 'ui/images/icon_64.png')}', format='PNG')
`;
  run('python3', ['-c', pyCode]);
}

async function ensureStandaloneNode() {
  log('3/6 准备原生自包含 Node.js 运行时...');
  const nodeVersion = 'v22.14.0';
  const nodeDirName = `node-${nodeVersion}-linux-x64`;
  const cachedNodeBin = join(CACHE_DIR, nodeDirName, 'bin/node');

  if (!existsSync(cachedNodeBin)) {
    log(`下载独立 Node.js 运行时 (${nodeVersion} linux-x64)...`);
    await mkdir(CACHE_DIR, { recursive: true });
    const tarFile = join(CACHE_DIR, `${nodeDirName}.tar.xz`);
    const mirrorUrl = `https://npmmirror.com/mirrors/node/${nodeVersion}/${nodeDirName}.tar.xz`;
    const officialUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeDirName}.tar.xz`;

    try {
      run('curl', ['-sL', mirrorUrl, '-o', tarFile]);
    } catch {
      run('curl', ['-sL', officialUrl, '-o', tarFile]);
    }

    run('tar', ['-xJf', tarFile, '-C', CACHE_DIR]);
  }

  const appBinDir = join(APP_DIR, 'bin');
  await mkdir(appBinDir, { recursive: true });
  const targetNodeBin = join(appBinDir, 'node');

  await cp(cachedNodeBin, targetNodeBin);
  await chmod(targetNodeBin, 0o755);
  log(`Node.js 运行时就绪: ${targetNodeBin}`);
}

async function prepareNativeAppPayload() {
  log('4/6 装配原生服务端与 Web SPA 静态资产...');
  // 清理任何历史 Docker 遗留
  await rm(join(APP_DIR, 'docker'), { recursive: true, force: true });

  // 1. 确保前端 Web 产物存在
  const webDist = join(ROOT, 'web/dist');
  if (!existsSync(join(webDist, 'index.html'))) {
    log('web/dist 不存在，正在执行前端编译...');
    run('npm', ['run', 'build'], { cwd: join(ROOT, 'web') });
  }

  // 同步前端静态文件到 app/web/dist
  const appWebDist = join(APP_DIR, 'web/dist');
  await rm(appWebDist, { recursive: true, force: true });
  await mkdir(dirname(appWebDist), { recursive: true });
  await cp(webDist, appWebDist, { recursive: true });

  // 2. 同步服务端源码与生产依赖
  const appServer = join(APP_DIR, 'server');
  await rm(appServer, { recursive: true, force: true });
  await mkdir(appServer, { recursive: true });

  // 复制 src/、package.json、package-lock.json
  await cp(join(ROOT, 'server/src'), join(appServer, 'src'), { recursive: true });
  await cp(join(ROOT, 'server/package.json'), join(appServer, 'package.json'));
  await cp(join(ROOT, 'server/package-lock.json'), join(appServer, 'package-lock.json'));

  // 复制生产 node_modules
  const serverNodeModules = join(ROOT, 'server/node_modules');
  if (existsSync(serverNodeModules)) {
    await cp(serverNodeModules, join(appServer, 'node_modules'), { recursive: true });
  } else {
    log('server/node_modules 不存在，正在安装生产依赖...');
    run('npm', ['ci', '--omit=dev'], { cwd: appServer });
  }

  // 确保 cmd 脚本可执行
  const cmdDir = join(FN_DIR, 'cmd');
  run('chmod', ['+x', ...['main', 'install_init', 'install_callback', 'uninstall_init', 'uninstall_callback', 'upgrade_init', 'upgrade_callback', 'config_init', 'config_callback'].map(f => join(cmdDir, f))]);
}

async function ensureFnpack() {
  log('5/6 检查 fnpack 官方打包工具...');
  try {
    const which = output('which', ['fnpack']);
    if (which) {
      log(`使用系统 fnpack: ${which}`);
      return 'fnpack';
    }
  } catch {
    /* not in PATH */
  }

  const localBin = join(ROOT, 'node_modules/.bin/fnpack');
  if (existsSync(localBin)) {
    return localBin;
  }

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://static2.fnnas.com/fnpack/fnpack-1.2.1-linux-${arch}`;
  log(`未检测到 fnpack，下载官方工具: ${url}...`);

  await mkdir(join(ROOT, 'node_modules/.bin'), { recursive: true });
  run('curl', ['-sL', url, '-o', localBin]);
  await chmod(localBin, 0o755);
  return localBin;
}

async function assembleFpk(fnpackBin, semver) {
  log('6/6 执行 fnpack build 打包原生套件...');
  await mkdir(OUTPUT_DIR, { recursive: true });

  const rawTarget = join(FN_DIR, 'suenmusic.fpk');
  if (existsSync(rawTarget)) {
    await unlink(rawTarget);
  }

  // fnpack 必须在项目源码根目录执行
  run(fnpackBin, ['build', '-d', '.'], { cwd: FN_DIR });

  if (!existsSync(rawTarget)) {
    fail(`打包完成但未找到产物: ${rawTarget}`);
  }

  const finalName = `suenmusic-v${semver}.fpk`;
  const finalPath = join(OUTPUT_DIR, finalName);
  await rename(rawTarget, finalPath);

  const fileStat = await stat(finalPath);
  const sizeMb = (fileStat.size / (1024 * 1024)).toFixed(2);
  const buffer = await readFile(finalPath);
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  console.log('\n============================================================');
  console.log('✔ 飞牛 fnOS 原生应用套件打包成功！');
  console.log(`  安装包:   output/${finalName}`);
  console.log(`  运行模式: 纯原生系统进程 (无 Docker 依赖 / 零虚拟化损耗)`);
  console.log(`  包体积:   ${fileStat.size} 字节 (${sizeMb} MB)`);
  console.log(`  SHA256:   ${sha256}`);
  console.log('============================================================\n');
}

async function main() {
  const { semver } = await readSemver();
  await injectManifestVersion(semver);
  await updateIconAssets();
  await ensureStandaloneNode();
  await prepareNativeAppPayload();
  const fnpackBin = await ensureFnpack();
  await assembleFpk(fnpackBin, semver);
}

main().catch(err => {
  fail(err?.stack || String(err));
});
