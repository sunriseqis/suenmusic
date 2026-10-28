/**
 * 酷狗验证码链路需要的两个加密函数（v_type=23 提交验证码时必需）。
 *
 * 移植自 MakcRe/KuGouMusicApi（本地参考实现 `util/crypto.js`）：
 *   · cryptoAesEncrypt(data, opt?)  → crypto.js:188-213
 *   · cryptoRSAEncrypt(data, pem?)  → crypto.js:247-262
 *   · randomString(len)             → util/util.js:randomString
 *
 * 原实现依赖 crypto-js + node-forge；这里用 node:crypto 写等价实现，不新增依赖：
 *   · AES：随机 16 位 key → md5 取前 32 字符**当 UTF-8 字节密钥**（32 字节 = AES-256），
 *          iv 取密钥尾部 16 字符，CBC/PKCS7，密文输出 hex；
 *   · RSA：明文 JSON 右侧补 \0 到模长后做无填充（textbook）RSA，输出 hex。
 *
 * ⚠️ 参数一个都不能换：上游用 pk 里带回的那把 AES key 去解 params，
 * 所以既不能换成 kugou-login.ts 的 aes-128 变体，也不能改成 PKCS#1 填充。
 */

import {
  createCipheriv,
  createHash,
  createPublicKey,
  constants,
  publicEncrypt,
  randomInt,
} from 'node:crypto';

/**
 * RSA 公钥：**原样搬自参考实现** `util/crypto.js:4-5`（1024 位，SPKI/PEM）。
 *
 * 两个平台各一把：服务端用对应私钥解 pk，用错公钥它解不开 params → 验证必失败。
 * 本项目全程走概念版（appid=3116），故默认用 LITE 那把；
 * 万一上游按标准版校验，只改 `KUGOU_RSA_PUBLIC_KEY` 一处即可。
 */
export const KUGOU_RSA_PUBLIC_KEY_STANDARD = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`;

export const KUGOU_RSA_PUBLIC_KEY_LITE = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB
-----END PUBLIC KEY-----`;

/** 当前生效的 RSA 公钥（概念版） */
export const KUGOU_RSA_PUBLIC_KEY = KUGOU_RSA_PUBLIC_KEY_LITE;

export interface AesEncryptResult {
  /** 密文 hex（对应参考实现的 encrypt.str） */
  str: string;
  /** 本轮随机 key（要经 pk 加密后交给上游，否则上游解不开 str） */
  key: string;
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

/** 参考实现 util/util.js 的 randomString：大写字母 + 数字 */
function randomString(len: number): string {
  const charset = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < len; i += 1) out += charset[randomInt(0, charset.length)];
  return out;
}

/**
 * AES 加密（对应 crypto.js:188 cryptoAesEncrypt）。
 * 返回 { str, key }：str 进 body 的 params，key 经 RSA 加密进 body 的 pk。
 */
export function cryptoAesEncrypt(payload: unknown = {}): AesEncryptResult {
  const plain = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const tempKey = randomString(16).toLowerCase();
  const key = md5(tempKey).slice(0, 32);
  const iv = key.slice(key.length - 16);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return {
    str: cipher.update(plain, 'utf8', 'hex') + cipher.final('hex'),
    key: tempKey,
  };
}

/**
 * RSA 加密（对应 crypto.js:247 cryptoRSAEncrypt）：无填充，输出 hex。
 * 注意是**教科书式 RSA**（modPow），不是 PKCS#1 —— 上游按前者解。
 */
export function cryptoRSAEncrypt(
  data: unknown,
  publicKey: string = KUGOU_RSA_PUBLIC_KEY,
): string {
  const keyBytes = Math.ceil((createPublicKey(publicKey).asymmetricKeyDetails?.modulusLength ?? 1024) / 8);
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  if (payload.length > keyBytes) throw new Error(`RSA payload 超过密钥长度（${payload.length} > ${keyBytes}）`);
  const padded = Buffer.concat([payload, Buffer.alloc(keyBytes - payload.length)]);
  return publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, padded).toString('hex');
}
