/**
 * 二维码编码器验收。
 *
 * ## 这份测试凭什么算数
 *
 * 二维码的失败模式是"码能生成、但扫不出来"——肉眼和"看起来像不像"都判不出来。
 * 所以编码器的正确性是**先离线验过**的：把矩阵栅格化后用纯 JS 解码器（jsQR）
 * 反解回原文，逐掩码比对，26 项全通。那一步需要解码器，而解码器不该进本项目
 * 的依赖（服务端运行时依赖只有 fastify），所以没有留在这里。
 *
 * 留在repo里的是**冻结的回归基准**：下面那些哈希是上述验证通过之后从
 * 本实现导出的。它们锁死的是"数据编码 + RS 纠错 + 块交错 + 掩码 + 铺码顺序 +
 * 格式信息"这一整条链 —— 其中任何一环被改动，哈希必然变化。
 *
 * 换句话说：**哈希不解释为什么对，但能保证"改坏了"一定会被发现。**
 * 真要再验一次正确性，重跑一次离线回环（用隔离工作区里的 jsqr）即可。
 *
 * 运行：npm run test:qr
 */

import { createHash } from 'node:crypto';
import { encodeQrMatrix, qrMatrixToSvg, qrSvgDataUrl } from '../utils/qr.ts';

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

// ---------- 基准 ----------

/** 真实形态的 B 站登录 URL（125 字节） */
const BILI_URL =
  'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=' +
  'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** 行优先把矩阵压成 '0'/'1' 串再取哈希；取前 32 位足够 */
function matrixHash(text: string, mask?: number): string {
  const m = encodeQrMatrix(text, mask === undefined ? {} : { mask });
  if (!m) return '(null)';
  const bits = m.modules.map(row => row.map(v => (v ? '1' : '0')).join('')).join('');
  return createHash('sha256').update(bits).digest('hex').slice(0, 32);
}

function main(): number {
  // ---------------------------------------------------------------------
  section('1. 矩阵回归基准');
  // ---------------------------------------------------------------------
  //
  // 逐掩码固定，再单独锁一次"自动选掩码"的结果。
  // 只锁自动结果是不够的：掩码选择一变，8 个掩码里哪个错都看不出来。

  const expectedMasks = [
    'a3607317f5983ffd98ccb51089358302',
    '9e819d7732b5613806d8903843080631',
    'ff00cba1ae768a0896eef47ed3932589',
    'da51db5ec6a96d413c970605417cfdc6',
    '5e95d545a11ecc954e9594939c6ab2b8',
    '0dd96aeb1cf7b9df281b8f7dd7d8d31c',
    'a5962e277c8bb66f2a3927b4e26539ca',
    '3b19f8c2cd526f01037eddd2e04db8d2',
  ];
  expectedMasks.forEach((expected, mask) => {
    check(`掩码 ${mask} 的矩阵与基准一致`, matrixHash(BILI_URL, mask) === expected);
  });

  check(
    '自动选出的掩码就是基准里的掩码 2',
    matrixHash(BILI_URL) === expectedMasks[2],
    matrixHash(BILI_URL)
  );

  check(
    '短文本（18 字节，v1）矩阵与基准一致',
    matrixHash('https://y.qq.com/') === '5468bac506d51e1abb69d77f8afb0258'
  );
  check(
    '版本 1 容量上限（17 字节）矩阵与基准一致',
    matrixHash('A'.repeat(17)) === '04c39bc7d784e722fb203adf29844eb6'
  );
  check(
    '版本 6 容量上限（134 字节）矩阵与基准一致',
    matrixHash('A'.repeat(134)) === 'dba273d5c6d158633f3f76444fc1228f'
  );

  // ---------------------------------------------------------------------
  section('2. 版本选择');
  // ---------------------------------------------------------------------
  //
  // 纠错等级 L 的**字节**容量 = 数据码字数 - 2（4 位模式 + 8 位字符计数 = 12 位开销）：
  // 17 / 32 / 53 / 78 / 106 / 134。**不是**数据码字数本身（19/34/55/80/108/136）——
  // 离线验证时这里就把预期写错过一次，把正确实现判成了失败。
  const boundaries: Array<[number, number]> = [
    [1, 1],
    [17, 1],
    [18, 2],
    [32, 2],
    [33, 3],
    [53, 3],
    [54, 4],
    [78, 4],
    [79, 5],
    [106, 5],
    [107, 6],
    [134, 6],
  ];
  for (const [bytes, version] of boundaries) {
    const m = encodeQrMatrix('A'.repeat(bytes));
    check(
      `${bytes} 字节落在版本 ${version}`,
      m?.version === version,
      `实际 v${m?.version ?? '(null)'}`
    );
  }

  // ---------------------------------------------------------------------
  section('3. 超出能力要干脆失败');
  // ---------------------------------------------------------------------
  //
  // 返回 null 让调用方退化成"只给链接"。生成一个扫不出来的码，
  // 比明确说"画不出来"糟糕得多。
  check('135 字节返回 null（版本 6 上限 134）', encodeQrMatrix('A'.repeat(135)) === null);
  check('500 字节返回 null', encodeQrMatrix('A'.repeat(500)) === null);
  check('空字符串返回 null', encodeQrMatrix('') === null);
  check('超长时 qrSvgDataUrl 也返回 null（不留半成品）', qrSvgDataUrl('A'.repeat(135)) === null);

  // ---------------------------------------------------------------------
  section('4. SVG 输出');
  // ---------------------------------------------------------------------
  const matrix = encodeQrMatrix(BILI_URL)!;
  const svg = qrMatrixToSvg(matrix);

  check('SVG 带 xmlns，否则在 <img> 里不渲染', svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  check('SVG 用 crispEdges，避免缩放时边缘发虚', svg.includes('shape-rendering="crispEdges"'));
  check('SVG 有白底（透明背景在暗色主题下会变负片）', svg.includes('fill="#ffffff"'));
  check('SVG 视框含 4 模块静默区', svg.includes('viewBox="0 0 49 49"'), svg.slice(0, 70));

  // 深色模块数 = path 里的矩形段数；空 path 说明矩阵整体为白，必然是错的
  const pathMatch = /<path fill="#000000" d="([^"]*)"/.exec(svg);
  const segments = (pathMatch?.[1]?.match(/M/g) ?? []).length;
  check('SVG 里真的画了深色模块', segments > 200, `${segments} 段`);
  check(
    '深色模块数少于总格数（不是全黑）',
    segments < matrix.size * matrix.size,
    `${segments} < ${matrix.size * matrix.size}`
  );

  const dataUrl = qrSvgDataUrl(BILI_URL);
  check('产出 base64 data URL', !!dataUrl && dataUrl.startsWith('data:image/svg+xml;base64,'));
  if (dataUrl) {
    const decoded = Buffer.from(
      dataUrl.slice('data:image/svg+xml;base64,'.length),
      'base64'
    ).toString('utf8');
    check('data URL 解出来就是同一份 SVG', decoded === svg);
  }

  return failed === 0 ? 0 : 1;
}

const code = main();
process.stdout.write('\n' + '-'.repeat(60) + '\n');
if (code === 0) {
  process.stdout.write(`二维码编码器验收通过：${passed} 项全部通过。\n`);
} else {
  process.stdout.write(`二维码编码器验收未通过：${passed} 通过 / ${failed} 失败。\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.exit(code);
