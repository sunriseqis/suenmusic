/**
 * 更新产物「多镜像自动择优」的测试脚本。
 *
 * 两种跑法：
 *   node --experimental-strip-types src/scripts/update-mirrors-test.ts
 *     → 纯函数断言（不发网络）：候选池、URL 拼装、排序、sha256。
 *   npm run test:update-mirrors -- --probe <资产直链> [--top 10]
 *     → 真实并发探活一遍候选池，打印当前最快的若干镜像（会发 80 个 512KB 的 Range 请求）。
 *
 * 为什么要单独有这个脚本：镜像站的好坏随时在变，这个池子必须能随时复测，
 * 而不是把某个 host 写死在代码里当信仰。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MIRROR_HOSTS,
  mirrorCandidates,
  mirrorUrl,
  probeMirrors,
  rankByProbe,
  sha256Of,
} from '../services/update-mirrors.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(title: string): void {
  process.stdout.write('\n' + title + '\n');
}

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    process.stdout.write('  OK   ' + name + '\n');
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    process.stdout.write('  FAIL ' + name + (detail ? ' — ' + detail : '') + '\n');
  }
}

function argValue(name: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

async function main(): Promise<number> {
  const probeUrl = argValue('probe');
  if (probeUrl) {
    const top = Number(argValue('top')) || 10;
    process.stdout.write('并发探活 ' + String(mirrorCandidates().length) + ' 个候选：' + probeUrl + '\n\n');
    const started = Date.now();
    const list = await probeMirrors(probeUrl);
    const usable = list.filter(x => x.ok);
    process.stdout.write('可用 ' + String(usable.length) + '/' + String(list.length) + '，耗时 ' +
      ((Date.now() - started) / 1000).toFixed(1) + 's\n\n');
    process.stdout.write('排名 镜像                                 吞吐      首字节\n');
    usable.slice(0, top).forEach((r, i) => {
      const label = r.prefix || '(直连)';
      process.stdout.write(String(i + 1).padStart(4) + ' ' + label.padEnd(38) +
        String(r.kbps + ' KB/s').padStart(10) + String((r.ttfbMs ?? 0) + ' ms').padStart(10) + '\n');
    });
    return 0;
  }

  section('1) 候选池');
  check('内置候选 >= 60 个', DEFAULT_MIRROR_HOSTS.length >= 60, '实际 ' + String(DEFAULT_MIRROR_HOSTS.length));
  const defaultPool = mirrorCandidates('');
  check('首项是直连（空前缀）', defaultPool[0] === '', '实际 ' + JSON.stringify(defaultPool[0]));
  check('默认池 = 内置 + 直连', defaultPool.length === DEFAULT_MIRROR_HOSTS.length + 1);
  const custom = mirrorCandidates('example.com, https://foo.bar/ ');
  check('env 覆盖生效（自动补 scheme、去尾斜杠）',
    custom.includes('https://example.com') && custom.includes('https://foo.bar'),
    JSON.stringify(custom));
  check('覆盖后仍包含直连', custom[0] === '');
  check('候选去重', new Set(custom).size === custom.length);

  section('2) URL 拼装');
  check('直连原样返回',
    mirrorUrl('', 'https://github.com/a/b') === 'https://github.com/a/b');
  check('镜像前缀拼接（带尾斜杠也正确）',
    mirrorUrl('https://ghfast.top/', 'https://github.com/a/b') === 'https://ghfast.top/https://github.com/a/b');

  section('3) 排序：可用优先 + 吞吐降序 + 首字节兜底');
  const ranked = rankByProbe([
    { prefix: 'slow', ok: true, ttfbMs: 200, kbps: 100, bytes: 1 },
    { prefix: 'down', ok: false, ttfbMs: null, kbps: 0, bytes: 0, error: 'timeout' },
    { prefix: 'fast', ok: true, ttfbMs: 900, kbps: 900, bytes: 1 },
    { prefix: 'tie', ok: true, ttfbMs: 100, kbps: 100, bytes: 1 },
  ]);
  // 吞吐相同（100）时按首字节升序 → tie(100ms) 在 slow(200ms) 前面
  check('顺序 = fast, tie, slow, down', ranked.map(r => r.prefix).join(',') === 'fast,tie,slow,down',
    ranked.map(r => r.prefix).join(','));

  section('4) sha256 校验');
  const dir = mkdtempSync(join(tmpdir(), 'suen-mirror-'));
  const file = join(dir, 'blob.bin');
  try {
    writeFileSync(file, 'suenmusic');
    const expected = createHash('sha256').update('suenmusic').digest('hex');
    check('sha256Of 与 node:crypto 一致', sha256Of(file) === expected);
    check('内容不同则哈希不同', sha256Of(file) !== 'deadbeef');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write('\n' + '-'.repeat(60) + '\n');
  if (failed === 0) {
    process.stdout.write('多镜像择优单测通过：' + String(passed) + ' 项全部通过。\n');
    return 0;
  }
  process.stdout.write('多镜像择优单测未通过：' + String(passed) + ' 通过 / ' + String(failed) + ' 失败。\n');
  for (const f of failures) process.stdout.write('  - ' + f + '\n');
  return 1;
}

process.exit(await main());
