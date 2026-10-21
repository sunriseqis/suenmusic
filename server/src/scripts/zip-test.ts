/**
 * .sm 归档解压防护验收。
 *
 * ## 这份测试凭什么算数
 *
 * 解压器的风险不是"解不出来"，而是"太能解"：deflate 的压缩比可以做到 1000:1，
 * 20MB 全零数据压成几十 KB，解压时却要真分配几十 GB。服务端是单进程 + 单 SQLite
 * （每日推荐、打标任务都在同一进程），一次 OOM 就是全部用户掉线。
 *
 * 所以这里测的不是"能不能解析"（正常往返那两项），而是**四道闸各自真的生效**：
 *   1. 条目数上限；
 *   2. 单条目解压体积上限（按 central directory 声明值先筛）；
 *   3. 压缩比上限；
 *   4. `maxOutputLength` 兜底 —— 用**声明值被伪造**的归档验证：
 *      头部谎报"解压后只有 1000 字节"，实际 deflate 流能解出 20MB。
 *      前两道闸都会放行，只有 zlib 自己的输出上限能拦住它。
 *
 * 运行：npm run test:zip
 */

import zlib from 'node:zlib';
import { createZip, parseZip } from '../utils/zip.ts';

// ---------- 迷你断言框架（与其余验收脚本一致） ----------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    process.stdout.write(`  OK   ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail ? `  （${detail}）` : ''}\n`);
  }
}

/** 断言抛错，且错误信息里带上预期关键词 */
function expectThrow(name: string, fn: () => unknown, keyword: string): void {
  try {
    fn();
    check(name, false, '没有抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, msg.includes(keyword), `错误信息是「${msg}」`);
  }
}

// ---------- 手工构造 ZIP（用于伪造头部） ----------

interface RawEntry {
  name: string;
  /** 实际写进归档的（已压缩）字节 */
  body: Buffer;
  /** central directory 里声明的压缩后大小 */
  compSize: number;
  /** central directory 里声明的解压后大小（可以是骗人的） */
  uncompSize: number;
  method: number;
}

function buildRawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(0, 12); // date
    lh.writeUInt32LE(0, 14); // crc（解析器不校验，留 0）
    lh.writeUInt32LE(e.compSize, 18);
    lh.writeUInt32LE(e.uncompSize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);
    locals.push(lh, e.body);

    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(0, 16); // crc
    ch.writeUInt32LE(e.compSize, 20);
    ch.writeUInt32LE(e.uncompSize, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    nameBuf.copy(ch, 46);
    centrals.push(ch);

    offset += lh.length + e.body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/** 20MB 全零 —— 压缩后只有几十 KB，是天然的炸弹素材 */
const ZERO_BOMB = Buffer.alloc(20 * 1024 * 1024, 0);

function main(): number {
  // ---------------------------------------------------------------------
  section('1. 正常往返（不能误杀真备份）');
  // ---------------------------------------------------------------------
  {
    const favorites = JSON.stringify({ tracks: Array.from({ length: 400 }, (_, i) => ({ id: `qq_${i}`, name: `曲目 ${i}` })) });
    const persona = '# 画像\n用户偏爱后摇与城市流行。'.repeat(200);
    const zip = createZip([
      { name: 'favorites.json', data: favorites },
      { name: 'persona.md', data: persona },
    ]);

    check('归档体积合理（<1MB）', zip.length < 1024 * 1024, `${zip.length} 字节`);

    const entries = parseZip(zip);
    check('解析出 2 个条目', entries.length === 2, `实际 ${entries.length}`);
    check('favorites.json 内容一致', entries[0]?.data.toString('utf8') === favorites);
    check('persona.md 内容一致（UTF-8 中文无损）', entries[1]?.data.toString('utf8') === persona);
  }

  // ---------------------------------------------------------------------
  section('2. 损坏数据必须拒绝');
  // ---------------------------------------------------------------------
  expectThrow('不足 22 字节直接拒绝', () => parseZip(Buffer.from('short')), '文件过小');
  expectThrow(
    '随机字节没有 EOCD 签名',
    () => parseZip(Buffer.alloc(1024, 0x41)),
    '未检测到有效 ZIP/SM 归档签名'
  );

  // ---------------------------------------------------------------------
  section('3. 条目数上限');
  // ---------------------------------------------------------------------
  {
    const many = createZip(
      Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.json`, data: '{}' }))
    );
    expectThrow('10 个条目超过默认上限 8', () => parseZip(many), '条目数');
  }

  // ---------------------------------------------------------------------
  section('4. 单条目体积上限 + 压缩比上限');
  // ---------------------------------------------------------------------
  {
    // createZip 会如实写入解压后大小 → 20MB 先撞上单条上限（8MB）
    const bomb = createZip([{ name: 'favorites.json', data: ZERO_BOMB }]);
    check('炸弹归档本身很小（证明压缩比）', bomb.length < 200 * 1024, `${bomb.length} 字节`);
    expectThrow('20MB 解压体积被单条上限拒绝', () => parseZip(bomb), '单条上限');

    // 把单条上限提到 32MB，就轮到压缩比闸生效（20000KB / 20KB ≈ 1000:1）
    expectThrow(
      '提升体积上限后仍被压缩比拒绝',
      () => parseZip(bomb, { maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 }),
      '压缩比'
    );
  }

  // ---------------------------------------------------------------------
  section('5. 声明值被伪造时，maxOutputLength 是最后一道闸');
  // ---------------------------------------------------------------------
  {
    const raw = zlib.deflateRawSync(ZERO_BOMB);
    // 谎报：解压后只有 1000 字节，压缩比 1000/20480 也很正常 → 前两道闸都会放行
    const forged = buildRawZip([
      {
        name: 'favorites.json',
        body: raw,
        compSize: raw.length,
        uncompSize: 1000,
        method: 8,
      },
    ]);
    check('伪造归档能通过前两道闸的声明值检查', forged.length < 200 * 1024);
    expectThrow(
      '实际解压 20MB 时被 zlib 输出上限拦住',
      () => parseZip(forged),
      'Buffer larger' // zlib 的 maxOutputLength 超限文案：Cannot create a Buffer larger than N bytes
    );
  }

  // ---------------------------------------------------------------------
  section('6. 上限可配置（调用方收紧后真的生效）');
  // ---------------------------------------------------------------------
  {
    const zip = createZip([{ name: 'favorites.json', data: 'x'.repeat(4096) }]);
    expectThrow(
      '把单条上限收到 1KB 后正常数据也被拒',
      () => parseZip(zip, { maxEntryBytes: 1024 }),
      '单条上限'
    );
    // 这份内容压缩比约 200:1（重复字符），但只有 4KB —— 压缩比闸不该为它误杀，
    // 否则一份合法的小备份会被当成攻击。体积闸才是小条目的防线。
    check('小条目高压缩比不误杀（压缩比闸只对大条目生效）', parseZip(zip).length === 1);
  }

  return failed === 0 ? 0 : 1;
}

const code = main();
process.stdout.write('\n' + '-'.repeat(60) + '\n');
if (code === 0) {
  process.stdout.write(`归档解压防护验收通过：${passed} 项全部通过。\n`);
} else {
  process.stdout.write(`归档解压防护验收未通过：${passed} 通过 / ${failed} 失败。\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.exit(code);
