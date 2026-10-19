/**
 * QQ 音乐 RPC 客户端。
 *
 * 浏览器端靠 webpack dev-server 的 /qq-api 代理绕跨域；服务端直连即可，
 * 只需要补上 Referer —— QQ 会校验来源。
 */

import { config } from '../../config.ts';
import { createLogger } from '../../logger.ts';
import { BROWSER_UA, QQ_REFERER } from '../../utils/constants.ts';
import { requestJson } from '../../utils/http.ts';

const log = createLogger('qq');

const MUSICU_ENDPOINT = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

export type QQComm = Record<string, unknown>;

/**
 * 首页 / 榜单 / 歌单广场使用的默认上下文。
 * 实测：search_type 之外的接口用这个即可。
 */
export const COMM_DEFAULT: QQComm = { ct: 24, cv: 0 };

/**
 * 搜索接口必须使用该上下文，否则 musicu.fcg 会返回空的 song 列表。
 * 实测 ct:24 时 song 恒为 0，ct:19 才正常。
 */
export const COMM_SEARCH: QQComm = { ct: 19, cv: 1859, uin: '0' };

/**
 * 通用 QQ 音乐 RPC 请求。
 *
 * @param modules 形如 { toplist: { module: '...', method: '...', param: {} } }
 * @param comm    上下文，搜索必须传 COMM_SEARCH
 */
export async function requestQQMusic<T = unknown>(
  modules: Record<string, unknown>,
  comm: QQComm = COMM_DEFAULT
): Promise<T> {
  const payload = { comm: { ...comm }, ...modules };

  const res = await requestJson<T>(MUSICU_ENDPOINT, {
    method: 'POST',
    headers: { Referer: QQ_REFERER, 'User-Agent': BROWSER_UA },
    body: payload,
    timeoutMs: config.upstreamTimeoutMs,
  });

  log.debug(`RPC [${Object.keys(modules).join(',')}]`);
  return res;
}
