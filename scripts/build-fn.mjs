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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 强制统一使用标准 022 umask，确保打包生成的套件文件与目录具备跨用户可读/可执行权限（避免 077 导致 fnOS 报权限出错）
process.umask(0o022);

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

/** 目录树里最新的 mtime（毫秒）。用于判断产物是否比源码旧。 */
function newestMtime(dir) {
  let newest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      try {
        const m = statSync(full).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir);
  return newest;
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
  const icon256 = join(FN_DIR, 'ICON_256.PNG');
  const icon64 = join(FN_DIR, 'ICON.PNG');
  const uiIcon256 = join(APP_DIR, 'ui/images/icon_256.png');
  const uiIcon64 = join(APP_DIR, 'ui/images/icon_64.png');

  // 如果四个产物都已存在且有效，直接确保同步到 ui 目录，避免 CI 缺少 PIL 依赖中断
  if (existsSync(icon256) && existsSync(icon64)) {
    await mkdir(join(APP_DIR, 'ui/images'), { recursive: true });
    await cp(icon256, uiIcon256);
    await cp(icon64, uiIcon64);
    log('已复用套件已有的高清图标资产 (256x256 / 64x64)');
    return;
  }

  const masterIcon = join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png');
  if (!existsSync(masterIcon)) {
    fail(`找不到高清母版图标: ${masterIcon}`);
  }

  const pyCode = `
try:
    from PIL import Image
    src = '${masterIcon}'
    im = Image.open(src)
    im.resize((256, 256), Image.Resampling.LANCZOS).save('${icon256}', format='PNG')
    im.resize((256, 256), Image.Resampling.LANCZOS).save('${uiIcon256}', format='PNG')
    im.resize((64, 64), Image.Resampling.LANCZOS).save('${icon64}', format='PNG')
    im.resize((64, 64), Image.Resampling.LANCZOS).save('${uiIcon64}', format='PNG')
except Exception as e:
    print('WARN: PIL resize failed:', e)
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

  // 1. 确保前端 Web 产物存在且**不陈旧**
  //
  // 只判断"存在"是不够的：改了 web/src 却没重新 build，打包会静默带上旧前端 ——
  // 表现是"新版 fpk 里前端还是上一个版本"，而包体积、校验和都正常，极难发现。
  const webDir = join(ROOT, 'web');
  const webDist = join(webDir, 'dist');
  const distMissing = !existsSync(join(webDist, 'index.html'));
  let distStale = false;
  if (!distMissing) {
    // 覆盖范围要包含 public/（字体、图标、favicon 都在这里）与 lockfile ——
    // 只比 src 会漏掉"只换了 Gunstop.ttf"这种最典型的静默陈旧（重审 R-5）。
    const srcNewest = Math.max(
      newestMtime(join(webDir, 'src')),
      newestMtime(join(webDir, 'public')),
      ...[
        join(webDir, 'index.html'),
        join(webDir, 'vite.config.ts'),
        join(webDir, 'package.json'),
        join(webDir, 'package-lock.json'),
      ]
        .filter(existsSync)
        .map(f => {
          try {
            return statSync(f).mtimeMs;
          } catch {
            return 0;
          }
        })
    );
    const distNewest = newestMtime(webDist);
    distStale = srcNewest > distNewest;
    if (distStale) {
      log('web/dist 比 web 源码/public 旧（改过但没重新构建），强制重新编译前端');
    }
  }
  if (distMissing || distStale) {
    if (distMissing) log('web/dist 不存在，正在执行前端编译...');
    run('npm', ['run', 'build'], { cwd: webDir });
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

  // 生产依赖：**必须重新安装**，不能直接拷开发目录的 node_modules。
  //
  // 以前的做法是"有就拷、没有才装"，于是构建机上只要装了 devDependencies
  //（我本地 npm ci 装了 typescript / @types/node），typescript、@types 就会一起进包，
  // 白占体积且让"这个包到底是哪来的依赖"不可复现。
  // `npm ci --omit=dev` 严格按 package-lock 装，结果可复现。
  log('安装生产依赖（npm ci --omit=dev，严格按 lockfile，不含 devDependencies）...');
  try {
    run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appServer });
  } catch (err) {
    fail(`生产依赖安装失败（打包需要网络）: ${err?.message ?? err}`);
  }
  // 清理可能被 npm 安装进来的开发类型包或构建工具，保证纯净生产运行时
  for (const name of ['typescript', '@types']) {
    const target = join(appServer, 'node_modules', name);
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
      log(`已清理生产依赖残留: ${name}`);
    }
  }

  // 删掉 .bin：里面全是 npm 生成的 CLI 软链，服务端运行时不依赖。
  // ⚠️ 必须删：Node 的 fs.cp 会把 npm 的相对软链改写成构建机绝对路径，
  // fnpack 打包时又只保留目标 basename → app.tgz 里变成自引用死链；
  // fnOS 安装时遍历赋权 stat 到死链直接失败，界面报「设置目录权限失败」。
  const pkgBinDir = join(appServer, 'node_modules', '.bin');
  if (existsSync(pkgBinDir)) {
    await rm(pkgBinDir, { recursive: true, force: true });
    log('已移除 node_modules/.bin（CLI 软链进 fpk 会变死链）');
  }

  // 3. 严格规范套件所有目录与文件权限（杜绝 700/600 导致非 root 用户或 fnOS 应用中心报权限出错）
  log('规范套件文件与目录权限 (目录 755 / 文件 644 / 脚本 755)...');
  run('find', [FN_DIR, '-type', 'd', '-exec', 'chmod', '755', '{}', '+']);
  run('find', [FN_DIR, '-type', 'f', '-exec', 'chmod', '644', '{}', '+']);

  // 确保 cmd 脚本可执行
  const cmdDir = join(FN_DIR, 'cmd');
  run('chmod', ['+x', ...['main', 'install_init', 'install_callback', 'uninstall_init', 'uninstall_callback', 'upgrade_init', 'upgrade_callback', 'config_init', 'config_callback'].map(f => join(cmdDir, f))]);

  // 确保 Node.js 运行时二进制可执行
  const appBinNode = join(APP_DIR, 'bin/node');
  if (existsSync(appBinNode)) {
    await chmod(appBinNode, 0o755);
  }
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

async function assertNoSymlinks() {
  // fpk 内的软链会被 fnpack 改写成死链，fnOS 安装必报「设置目录权限失败」。
  // 打包前硬校验：有软链就直接失败，不带着隐患出包。
  const links = output('find', [FN_DIR, '-type', 'l']).trim();
  if (links) {
    fail(`fn/ 下不允许存在软链（打进 fpk 会变死链，安装必失败）：\n${links}`);
  }
}

async function assembleFpk(fnpackBin, semver) {
  log('6/6 执行 fnpack build 打包原生套件...');
  await assertNoSymlinks();
  await mkdir(OUTPUT_DIR, { recursive: true });

  const staleAppTgz = join(FN_DIR, 'app.tgz');
  if (existsSync(staleAppTgz)) {
    await unlink(staleAppTgz);
  }

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
  await chmod(finalPath, 0o644);

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
