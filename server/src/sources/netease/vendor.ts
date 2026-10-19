/**
 * 网易云 vendor 的统一入口（CJS → ESM 桥）。
 *
 * vendor（`../vendors/netease/`）是从上游 api-enhanced 按依赖闭包抽取的
 * 原样 CJS 代码，只做了三处必要补丁（unblock 剔除 / anonymous_token 惰性 /
 * sk 校验放宽），见各文件内注释。业务代码一律**经过本文件**使用 vendor，
 * 不直接 import —— 互操作细节（createRequire 绑定、启动引导顺序）只在这
 * 一个文件里维护。
 *
 * 用 createRequire 而不是 ESM import：vendor 是纯 CJS，createRequire
 * 语义 100% 原生，也免去给每个 .js 写类型声明。
 */

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from '../../logger.ts';

const require = createRequire(import.meta.url);

const createRequest = require('../../vendors/netease/util/request.js');
const { cookieToJson, generateRandomChineseIP } = require('../../vendors/netease/util/index.js');
const { getXeapiPublicKey } = require('../../vendors/netease/util/xeapiKey.js');
const modSearch = require('../../vendors/netease/module/search.js');
const modSimiArtist = require('../../vendors/netease/module/simi_artist.js');
const modLyricNew = require('../../vendors/netease/module/lyric_new.js');
const modAlbum = require('../../vendors/netease/module/album.js');
const modSongUrlV1 = require('../../vendors/netease/module/song_url_v1.js');
const modLoginQrKey = require('../../vendors/netease/module/login_qr_key.js');
const modLoginQrCheck = require('../../vendors/netease/module/login_qr_check.js');
const modLoginStatus = require('../../vendors/netease/module/login_status.js');
const modRegisterAnonimous = require('../../vendors/netease/module/register_anonimous.js');

const log = createLogger('netease:vendor');

type NeteaseModule = (
  query: Record<string, unknown>,
  request: unknown
) => Promise<NeteaseEnvelope>;

export interface NeteaseEnvelope {
  status: number;
  body: Record<string, unknown> & {
    code?: number;
    cookie?: string;
    data?: Record<string, unknown>;
  };
  cookie: string[];
}

export const neteaseRequest = createRequest as unknown;

/** vendor 各模块（已绑 request 形状） */
export const netease = {
  search: modSearch as NeteaseModule,
  simiArtist: modSimiArtist as NeteaseModule,
  lyricNew: modLyricNew as NeteaseModule,
  album: modAlbum as NeteaseModule,
  songUrlV1: modSongUrlV1 as NeteaseModule,
  loginQrKey: modLoginQrKey as NeteaseModule,
  loginQrCheck: modLoginQrCheck as NeteaseModule,
  loginStatus: modLoginStatus as NeteaseModule,
};

// ---------------------------------------------------------------------------
// 启动引导（顺序是硬约束）
// ---------------------------------------------------------------------------

const tmpPath = os.tmpdir();
const KEY_PATH = path.resolve(tmpPath, 'xeapi_public_key');
const TOKEN_PATH = path.resolve(tmpPath, 'anonymous_token');

/**
 * vendor 的 bootstrap。**必须先公钥后匿名注册**：
 * `register_anonimous` 本身走 xeapi 加密通道，公钥缺失时它必然失败——
 * 先注册是鸡生蛋死锁（冒烟实测踩过）。
 *
 * 公钥接口（register_xeapikey）用 axios 直连 + 本地签名，不依赖 token，
 * 因此这个顺序总能解开。幂等：文件已存在且非空时跳过对应步骤。
 */
export async function bootstrapNeteaseVendor(): Promise<void> {
  // randomCNIP：vendor 的请求栈从这里读全局随机国内 IP
  (globalThis as Record<string, unknown>).cnIp = generateRandomChineseIP();

  try {
    if (!fs.existsSync(KEY_PATH) || fs.readFileSync(KEY_PATH, 'utf-8').length === 0) {
      const deviceId = String((globalThis as Record<string, unknown>).deviceId ?? '');
      const pk = (await getXeapiPublicKey({}, deviceId)) as Record<string, unknown>;
      fs.writeFileSync(KEY_PATH, JSON.stringify(pk), 'utf-8');
      log.info('网易云 xeapi 公钥已获取');
    }
  } catch (err) {
    // 公钥失败不阻塞启动：song_url_v1（xeapi）会失败，但搜索类接口走 weapi 不受影响
    log.warn(`xeapi 公钥获取失败（song_url_v1 将不可用）：${(err as Error)?.message ?? err}`);
  }

  try {
    if (!fs.existsSync(TOKEN_PATH) || fs.readFileSync(TOKEN_PATH, 'utf-8').length === 0) {
      const res = (await modRegisterAnonimous({}, createRequest)) as NeteaseEnvelope;
      const cookie = res?.body?.cookie;
      if (cookie) {
        fs.writeFileSync(TOKEN_PATH, cookieToJson(String(cookie)).MUSIC_A ?? '', 'utf-8');
        log.info('网易云匿名 token 已生成');
      } else {
        log.warn(`匿名注册未返回 cookie：${JSON.stringify(res?.body)?.slice(0, 200)}`);
      }
    }
  } catch (err) {
    log.warn(`匿名 token 生成失败（匿名搜索被限流概率上升）：${(err as Error)?.message ?? err}`);
  }
}
