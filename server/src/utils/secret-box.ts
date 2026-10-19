/**
 * 对称加解密（AES-256-GCM）。
 *
 * 用途：把"必须留存但绝不能明文落库"的秘密（目前只有网易云密码，
 * `netease.password_cipher`）加密后存进 `app_settings`。
 *
 * 密钥从 `SUENMUSIC_JWT_SECRET` 派生（HKDF → scrypt 摘一段盐）。
 * 这意味着：**加密强度与服务端同源** —— 服务端被攻破则密文可解。
 * 自用部署可接受；公网部署必须换强 JWT_SECRET（README 已有说明）。
 *
 * 为什么是 GCM：带认证标签，密文被篡改时解密直接失败，
 * 不需要额外的 HMAC 层。每次加密用随机 IV，同一明文两次加密结果不同。
 */

import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'node:crypto';
import { config } from '../config.ts';

/** 派生盐。改它 = 全部密文作废，需要重新登录一次，因此固定下来 */
const KDF_SALT = 'suenmusic.password-cipher.v1';
const KEY_LEN = 32;
const IV_LEN = 12;

let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(config.jwtSecret, KDF_SALT, KEY_LEN);
  }
  return cachedKey;
}

/** 加密。返回 `v1.<iv_b64>.<ciphertext_b64>`（版本前缀留将来换算法的余地） */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${Buffer.concat([tag, enc]).toString('base64')}`;
}

/** 解密。密文被篡改或密钥不匹配（比如换了 JWT_SECRET）时返回 null */
export function decryptSecret(cipher: string | null | undefined): string | null {
  if (!cipher) return null;
  const parts = cipher.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1]!, 'base64');
    const payload = Buffer.from(parts[2]!, 'base64');
    const tag = payload.subarray(0, 16);
    const data = payload.subarray(16);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}
