/**
 * 极简二维码编码器（字节模式 / 纠错等级 L / 版本 1–6）。
 *
 * ## 为什么自己写
 *
 * B 站扫码登录只返回一个 login URL，**不返回二维码图片**，所以码得我们自己画。
 * 而本项目有一条已经吃过亏才定下来的约束：**服务端运行时依赖只有 fastify**
 * （见 .workbuddy/memory/MEMORY.md 的"技术选型已定"）。为一个登录入口引一个
 * 二维码库，代价和收益不成比例，所以按需实现最小可用子集。
 *
 * ## 覆盖范围与边界
 *
 * - **只做字节模式（8bit byte）**：登录 URL 是 ASCII，够用。
 * - **只做纠错等级 L**（7% 冗余）：屏幕上的码没有污损风险，L 容量最大。
 * - **只做版本 1–6**（21×21 到 41×41，最多 134 字节）。
 *   版本 7 起要塞"版本信息"（BCH 18 位），多一张表和多一段代码，
 *   而 B 站登录 URL 稳定在 110 字节上下 —— 超出直接**返回 null**，
 *   由调用方退化成"只给链接"，不做无谓的容量扩张。
 * - 掩码按标准的 4 条罚分规则从 8 个里挑最优，不是写死一个。
 *
 * ## 验证方式
 *
 * 正确性不靠"看起来像二维码"。测试里对同一段文本、**逐掩码**与参考实现
 * （qrcode-generator）的输出做矩阵哈希比对，8 个掩码全等才算通过 ——
 * 见 `scripts/qr-test.ts`。掩码选择本身只影响观感不影响可解码性
 * （解码器从格式信息里读掩码），所以它由本文件的罚分规则独立决定。
 */

/** 校正图形中心坐标。版本 1 没有校正图形 */
const ALIGNMENT_CENTERS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};

interface EcSpec {
  /** 该版本总码字数（数据 + 纠错） */
  total: number;
  /** 每块的纠错码字数 */
  ecPerBlock: number;
  /** 各数据块的数据码字数；求和即总数据码字数 */
  blocks: number[];
}

/** 纠错等级 L 的块结构表（版本 1–6） */
const EC_LEVEL_L: Record<number, EcSpec> = {
  1: { total: 26, ecPerBlock: 7, blocks: [19] },
  2: { total: 44, ecPerBlock: 10, blocks: [34] },
  3: { total: 70, ecPerBlock: 15, blocks: [55] },
  4: { total: 100, ecPerBlock: 20, blocks: [80] },
  5: { total: 134, ecPerBlock: 26, blocks: [108] },
  6: { total: 172, ecPerBlock: 18, blocks: [68, 68] },
};

/** 支持的最大版本 */
export const MAX_VERSION = 6;

/** 纠错等级 L 在格式信息里的编码 */
const EC_LEVEL_BITS_L = 0b01;

// ---------------------------------------------------------------------------
// GF(256)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  // 本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成 `(x - α^0)(x - α^1)...(x - α^(n-1))` 的系数，最高次在前 */
function rsGeneratorPoly(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 求余式，即纠错码字 */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Array<number>(ecLen).fill(0);

  for (const byte of data) {
    const factor = byte ^ (res[0] ?? 0);
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1] ?? 0, factor);
  }
  return res;
}

// ---------------------------------------------------------------------------
// 数据编码
// ---------------------------------------------------------------------------

/** 选出能装下 `byteLength` 个字节的最小版本；超出能力返回 -1 */
function pickVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const spec = EC_LEVEL_L[v];
    if (!spec) continue;
    const dataCodewords = spec.blocks.reduce((a, b) => a + b, 0);
    // 4 位模式指示 + 8 位字符计数（版本 1–9）+ 内容
    if (4 + 8 + byteLength * 8 <= dataCodewords * 8) return v;
  }
  return -1;
}

function encodeDataCodewords(bytes: number[], version: number): number[] {
  const spec = EC_LEVEL_L[version]!;
  const capacityBits = spec.blocks.reduce((a, b) => a + b, 0) * 8;

  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // 字节模式
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);

  // 终止符最多 4 位，装不下就补齐到容量
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i++) bits.push(0);
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);
  // 交替填充 0xEC / 0x11
  const PAD = [0xec, 0x11];
  let k = 0;
  while (bits.length < capacityBits) push(PAD[k++ % 2]!, 8);

  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] ?? 0);
    out.push(v);
  }
  return out;
}

/** 分块做 RS 再按标准交错。跳过错开这一步，码在密集扫描下会成片出错 */
function interleaveBlocks(dataCodewords: number[], version: number): number[] {
  const spec = EC_LEVEL_L[version]!;

  const parts: Array<{ data: number[]; ec: number[] }> = [];
  let offset = 0;
  for (const size of spec.blocks) {
    const chunk = dataCodewords.slice(offset, offset + size);
    offset += size;
    parts.push({ data: chunk, ec: rsEncode(chunk, spec.ecPerBlock) });
  }

  const out: number[] = [];
  const maxData = Math.max(...spec.blocks);
  for (let i = 0; i < maxData; i++) {
    for (const p of parts) if (i < p.data.length) out.push(p.data[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const p of parts) out.push(p.ec[i]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 格式信息与掩码
// ---------------------------------------------------------------------------

/** 5 位数据（纠错等级 + 掩码）→ 15 位 BCH 码，再异或 0x5412 */
function formatInfoBits(mask: number): number {
  const data = (EC_LEVEL_BITS_L << 3) | (mask & 0b111);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0b10100110111 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

/** 8 个标准掩码，(row, col) → 是否翻转 */
const MASK_FUNCS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  r => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * 标准罚分（ISO/IEC 18004 表 24）。
 * 四条规则里 N1/N2 影响最大，N3/N4 主要用于避开"看起来像定位图形"的区域。
 */
function penalty(modules: boolean[][], n: number): number {
  let score = 0;

  // N1：行/列上连续同色 ≥5 → 3 + (长度 - 5)
  for (let i = 0; i < n; i++) {
    for (const byRow of [true, false]) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const prev = byRow ? modules[i]![j - 1]! : modules[j - 1]![i]!;
        const cur = byRow ? modules[i]![j]! : modules[j]![i]!;
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // N2：2×2 同色方块 → 3
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = modules[r]![c]!;
      if (
        modules[r]![c + 1] === v &&
        modules[r + 1]![c] === v &&
        modules[r + 1]![c + 1] === v
      ) {
        score += 3;
      }
    }
  }

  // N3：形如 1:1:3:1:1 且一侧有 4 个浅色模块的图案 → 40
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (k: number) => boolean, start: number, pattern: boolean[]) => {
    for (let k = 0; k < 11; k++) if (get(start + k) !== pattern[k]) return false;
    return true;
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j + 11 <= n; j++) {
      for (const pattern of [P1, P2]) {
        if (matches(k => modules[i]![k]!, j, pattern)) score += 40;
        if (matches(k => modules[k]![i]!, j, pattern)) score += 40;
      }
    }
  }

  // N4：深色占比每偏离 50% 达 5% → 10
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (modules[r]![c]) dark++;
  const ratio = Math.abs((dark * 100) / (n * n) - 50) / 5;
  score += Math.floor(ratio) * 10;

  return score;
}

// ---------------------------------------------------------------------------
// 矩阵
// ---------------------------------------------------------------------------

/**
 * 生成一个掩码下的完整矩阵。
 *
 * 顺序与标准一致，**先写格式信息再铺数据** —— 铺数据只填 `null` 格，
 * 所以格式信息与各功能图形天然不会被覆盖，也就用不着额外的"保留位"数组。
 */
function buildMatrix(codewords: number[], version: number, mask: number): boolean[][] {
  const n = version * 4 + 17;
  // null 表示"还没写"，用三态是为了让"数据区"判定不需要另一张布尔表
  const m: Array<Array<boolean | null>> = Array.from({ length: n }, () =>
    new Array<boolean | null>(n).fill(null)
  );
  const set = (r: number, c: number, v: boolean) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    m[r]![c] = v;
  };

  // ---- 定位图形与分隔符 ----
  for (const [pr, pc] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ] as const) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inside &&
          (dr === 0 ||
            dr === 6 ||
            dc === 0 ||
            dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(pr + dr, pc + dc, dark);
      }
    }
  }

  // ---- 定时图形 ----
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // ---- 校正图形 ----
  const centers = ALIGNMENT_CENTERS[version] ?? [];
  for (const r of centers) {
    for (const c of centers) {
      // 与定位图形（含分隔符）重叠的位置不放
      if (
        (r <= 8 && c <= 8) ||
        (r <= 8 && c >= n - 9) ||
        (r >= n - 9 && c <= 8)
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // ---- 固定深色模块（位置 4V+9 行、第 8 列）----
  set(n - 8, 8, true);

  // ---- 格式信息，两份 ----
  const fmt = formatInfoBits(mask);
  const bit = (i: number) => ((fmt >>> i) & 1) === 1;
  // 第一份：绕左上定位图形的右侧与下侧
  for (let i = 0; i <= 5; i++) set(i, 8, bit(i));
  set(7, 8, bit(6));
  set(8, 8, bit(7));
  set(8, 7, bit(8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i));
  // 第二份：位 0–7 在右上，位 8–14 在左下（左下只占 7 格，深色模块正好补上第 8 格）
  for (let i = 0; i < 8; i++) set(8, n - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) set(n - 15 + i, 8, bit(i));

  // ---- 铺数据（之字形，两列一组自下而上/自上而下交替）----
  const maskFn = MASK_FUNCS[mask]!;
  let row = n - 1;
  let inc = -1;
  let byteIndex = 0;
  let bitIndex = 7;

  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (m[row]![c] !== null) continue;
        let dark = false;
        if (byteIndex < codewords.length) {
          dark = ((codewords[byteIndex]! >>> bitIndex) & 1) === 1;
        }
        if (maskFn(row, c)) dark = !dark;
        m[row]![c] = dark;
        bitIndex -= 1;
        if (bitIndex === -1) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += inc;
      if (row < 0 || row >= n) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }

  return m.map(r => r.map(v => v === true));
}

export interface QrMatrix {
  /** 边长（模块数），不含静默区 */
  size: number;
  /** `modules[row][col]`，true = 深色 */
  modules: boolean[][];
  version: number;
  mask: number;
}

export interface QrOptions {
  /** 指定版本，不传则按内容长度自动选最小可用版本 */
  version?: number;
  /** 指定掩码，不传则按罚分规则自动选 */
  mask?: number;
}

/** 文本 → UTF-8 字节 */
function toBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/**
 * 编码成二维码矩阵。
 *
 * 内容超出本实现的能力（>134 字节，即版本 6 上限）时返回 `null` ——
 * 调用方据此退化成"只给链接"，而不是抛异常把整个登录流程打断。
 */
export function encodeQrMatrix(text: string, options: QrOptions = {}): QrMatrix | null {
  const bytes = toBytes(text);
  if (bytes.length === 0) return null;

  const version = options.version ?? pickVersion(bytes.length);
  if (version < 1 || version > MAX_VERSION) return null;
  if (4 + 8 + bytes.length * 8 > EC_LEVEL_L[version]!.blocks.reduce((a, b) => a + b, 0) * 8) {
    return null;
  }

  const codewords = interleaveBlocks(encodeDataCodewords(bytes, version), version);

  if (options.mask !== undefined) {
    return { size: version * 4 + 17, modules: buildMatrix(codewords, version, options.mask), version, mask: options.mask };
  }

  let best: { mask: number; modules: boolean[][]; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = buildMatrix(codewords, version, mask);
    const score = penalty(modules, version * 4 + 17);
    if (!best || score < best.score) best = { mask, modules, score };
  }

  return { size: version * 4 + 17, modules: best!.modules, version, mask: best!.mask };
}

/** 矩阵 → SVG 字符串。同色相邻模块合并成一条矩形，体积和节点数都降一个数量级 */
export function qrMatrixToSvg(matrix: QrMatrix, options: { quietZone?: number; scale?: number } = {}): string {
  const quiet = options.quietZone ?? 4;
  const scale = options.scale ?? 1;
  const n = matrix.size;
  const total = (n + quiet * 2) * scale;

  const runs: string[] = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!matrix.modules[r]![c]) {
        c++;
        continue;
      }
      let end = c;
      while (end + 1 < n && matrix.modules[r]![end + 1]) end++;
      const x = (quiet + c) * scale;
      const y = (quiet + r) * scale;
      const w = (end - c + 1) * scale;
      runs.push(`M${x} ${y}h${w}v${scale}h-${w}z`);
      c = end + 1;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${total}" height="${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path fill="#000000" d="${runs.join('')}"/>` +
    `</svg>`
  );
}

/** 矩阵 → `data:image/svg+xml;base64,...`，可直接塞进 `<img src>` */
export function qrSvgDataUrl(text: string): string | null {
  const matrix = encodeQrMatrix(text);
  if (!matrix) return null;
  const svg = qrMatrixToSvg(matrix);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
