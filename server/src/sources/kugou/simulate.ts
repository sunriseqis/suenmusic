/**
 * 酷狗行为指纹模拟（sid / edt 生成）。
 *
 * 逐函数移植自 MakcRe/KuGouMusicApi `util/generate_simulate.js`（本地参考 /tmp/kugouapi），
 * 数学与编码格式**保持一致**，只把两个浏览器/三方依赖换掉：
 *   · crypto-js AES  → node:crypto createCipheriv('aes-128-cbc')
 *   · node-forge RSA → node:crypto publicEncrypt(RSA-OAEP, sha256 + mgf1 sha256)
 * 明文拼接（mid/userid/dfid/webgl/webdriver/ts/data）、IV、填充、事件串格式都未改动：
 * 换公式等于换指纹，上游会直接判失败，所以宁可留一堆常量也不要"优化"。
 *
 * 用途：POST /v4/verify_user_info 的 sid/edt。get_verify_info 返回的 sid/edt 实测为空，
 * 而参考实现的真实提交走 module/sidedt.js —— 用这里生成的指纹替代（见 kugou-verify.ts）。
 */

import { createCipheriv, createHash, createPublicKey, constants, publicEncrypt, randomInt } from 'node:crypto';

/**
 * RSA 公钥（PEM/SPKI，RSA-2048）—— 原样搬自参考实现 generate_simulate.js:36。
 * 这是**酷狗服务端**用来解 SID 拿到 AES key 的公钥，和 crypto.ts 里那把
 * 1024 位概念版（加密 params 用的）不是同一把，不能混用。
 */
const KUGOU_SIM_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoW2+Ylo8ALePSQTP0xBF
lFmEOHvBD9tS+s7DBlfKEu3RzzvZTaX1JtYbX4+AVUqj6ARz8IM+CKByqGFvbHN/
W64XxNI+q7z36ajCL3VTJ2W5G9MCJitc6oGbire4NQfhaEq0nC+hxBWQvCbIFflA
2ItrLUbSU7z1bHA/a+jlQm4OWvY+IKnTryOJTPuT1yNOVjbJ8wBLKy2DgQr9pPqW
PmEQtGpR5IM9V8Kao6PaSdKYOWGbX3i2+RzIKhvZUxxtJwdVbqPlDPlW9h4/xIBc
56Lgvr4aIl8nFtwbj4UJVUTFuGrs0tY9H/tXvZ22dUCKuGxW/gW7ZF+gXz6vHtYa
rQIDAQAB
-----END PUBLIC KEY-----`;

/** AES 初始向量（生成器里硬编码的固定值，对应 ASCII "kugousecurity123"） */
const AES_IV = 'kugousecurity123';

/** 哨兵值：每条事件后跟一条"结束标记"，时间差字段用它。每次生成重新随机（参考实现同款） */
let SENTINEL = 0xffffffff - Math.floor(Math.random() * 20);

/** [min, max] 闭区间随机整数（generate_simulate.js:259） */
function ri(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 随机字符串（大写字母 + 数字），生成器用它做 AES key 的原料（util/util.js:34） */
export function randomString(len = 16): string {
  const charset = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < len; i += 1) out += charset[randomInt(0, charset.length)];
  return out;
}

/**
 * WebGL 指纹哈希（util/util.js:224 的 Node 分支）。
 * 浏览器里是着色器像素的 FNV-1a 哈希；Node 没有 canvas，参考实现退化成随机 uint64，
 * 这里保持一致（换成真值反而会和上游记录的设备指纹对不上）。
 */
export function generateWebGLHash(): string {
  const hi = Math.floor(Math.random() * 0xffffffff);
  const lo = Math.floor(Math.random() * 0xffffffff);
  return (BigInt(hi) * BigInt(0x100000000) + BigInt(lo)).toString();
}

// ---------- 事件记录格式化（generate_simulate.js:195-251） ----------
// type-3 鼠标/触摸移动、type-5 滚动、type-6 窗口事件；fs* 是对应的哨兵记录。

function f3(t: number, i: number, x: number, y: number): string {
  return `3,${t},${i},${x},${y}`;
}

function f5(t: number, i: number): string {
  return `5,${t},${i}`;
}

function f6(t: number, i: number, x: number, y: number): string {
  return `6,${t},${i},${x},${y}`;
}

function fs3(i: number, x: number, y: number): string {
  return `3,${SENTINEL},${i},${x},${y}`;
}

function fs5(i: number): string {
  return `5,${SENTINEL},${i}`;
}

function fs6(i: number, x: number, y: number): string {
  return `6,${SENTINEL},${i},${x},${y}`;
}

/**
 * 三阶贝塞尔曲线鼠标路径（generate_simulate.js:156）。
 * 抖动幅度随 t 从 3px 递减到 0.5px —— 模拟"起步手抖、移动后稳定"。
 */
function bezierPath(sx: number, sy: number, ex: number, ey: number, n: number): { x: number; y: number }[] {
  const c1x = sx + (ex - sx) * 0.3 + ri(-80, 80);
  const c1y = sy + (ey - sy) * 0.2 + ri(-60, 60);
  const c2x = sx + (ex - sx) * 0.7 + ri(-60, 60);
  const c2y = sy + (ey - sy) * 0.8 + ri(-40, 40);

  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex;
    const y = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey;
    const jitter = Math.max(0.5, 3 - t * 2.5);
    pts.push({ x: x + (Math.random() - 0.5) * jitter, y: y + (Math.random() - 0.5) * jitter });
  }
  return pts;
}

/** 行为事件串（generate_simulate.js:76）：窗口 → 3 次滚动 → 鼠标轨迹（每 12 帧插一次滚动）→ 收尾 */
function generateEDTData(opts: {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  mousePoints: number;
}): string {
  const { startX, startY, endX, endY, mousePoints } = opts;
  const entries: string[] = [];
  let ts = 0;
  let ei = 0;

  // 启动时的两条 type-5 零事件，各带哨兵
  entries.push(f5(0, 0));
  entries.push(fs5(0));
  entries.push(f5(0, 0));
  entries.push(fs5(0));

  // 窗口事件：模拟 750x500 的移动端页面
  ts += ri(5, 20);
  entries.push(f6(ts, ei, 750, 500));
  entries.push(fs6(ei, 750, 500));
  ei++;

  // 3 次滚动，间隔不均匀
  for (let i = 0; i < 3; i++) {
    ts += ri(80, 600);
    entries.push(f5(ts, ei));
    entries.push(fs5(ei));
    ei++;
  }

  // 鼠标轨迹
  const path = bezierPath(startX, startY, endX, endY, mousePoints);
  let si = 0;
  for (let i = 0; i < path.length; i++) {
    const { x, y } = path[i];
    ts += ri(8, 50);
    entries.push(f3(ts, si, Math.round(x), Math.round(y)));
    entries.push(fs3(si, Math.round(x), Math.round(y)));

    if (i > 0 && i % 12 === 0) {
      ts += ri(20, 60);
      entries.push(f5(ts, ei));
      entries.push(fs5(ei));
      ei++;
    }
    si = (si + 1) % 2;
  }

  // 收尾：最后一次移动带 ±5px 微调（点击前的抖动）
  ts += ri(5, 30);
  entries.push(f3(ts, 1, Math.round(endX + ri(-5, 5)), Math.round(endY + ri(-5, 5))));
  entries.push(fs3(1, Math.round(endX), Math.round(endY)));

  return entries.join(':');
}

export interface KugouSimulateResult {
  /** RSA-OAEP(SHA-256) 加密后的 AES key，Base64 */
  sid: string;
  /** AES-128-CBC 加密后的行为指纹明文，Base64 */
  edt: string;
}

/**
 * 生成 sid/edt（generate_simulate.js:286）。
 *
 * 步骤与参考实现一一对应：
 *   1. key = MD5(randomString(16)).hex.substring(0, 16) —— 16 个 ASCII 字符 = AES-128 密钥
 *   2. 随机起点/终点/采样点数，生成行为事件串
 *   3. 明文 mid=..;userid=..;dfid=..;webgl=..;webdriver=0;ts=..;data=..
 *   4. AES-128-CBC(PKCS7, IV="kugousecurity123") → edt（Base64）
 *   5. RSA-OAEP-SHA256(key) → sid（Base64）
 */
export function generateSimulate(
  mid?: string | number,
  userid?: string | number,
  dfid?: string | number,
  webglHash?: string,
): KugouSimulateResult {
  SENTINEL = 0xffffffff - Math.floor(Math.random() * 20);

  const key = createHash('md5').update(randomString(16)).digest('hex').substring(0, 16);

  const points = ri(30, 60);
  const startX = ri(200, 600);
  const startY = ri(200, 500);
  const endX = ri(500, 700);
  const endY = ri(80, 150);

  const devMid = mid || 0;
  const devUserid = userid || 0;
  const devDfid = dfid || 0;
  const webgl = webglHash || generateWebGLHash();
  const ts = Date.now();

  const data = generateEDTData({ startX, startY, endX, endY, mousePoints: points });
  const plaintext = `mid=${devMid};userid=${devUserid};dfid=${devDfid};webgl=${webgl};webdriver=0;ts=${ts};data=${data}`;

  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(AES_IV, 'utf8'));
  const edt = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');

  // 公钥只在首次使用时解析（失败时抛错，由调用方降级成"sid/edt 为空"）
  const sid = publicEncrypt(
    {
      key: createPublicKey(KUGOU_SIM_PUBLIC_KEY),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(key, 'utf8'),
  ).toString('base64');

  return { sid, edt };
}
