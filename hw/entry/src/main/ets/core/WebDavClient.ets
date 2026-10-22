/**
 * WebDAV 备份传输（T10 批次 C，对齐 web `offline/webdav.ts`）。
 *
 * 只在用户点「上传/下载」时发请求；目标固定为 `${url}/suenmusic.sm`。
 * Basic 认证；地址/账号/口令由设置页持有、AppState 偏好持久化，这里不存任何状态。
 */

import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { ApiError } from './APIClient';

export class WebDavClient {
  /** 备份文件名（与 web 同名：换端后同一个盘能互相认出对方的备份） */
  static readonly FILE_NAME = 'suenmusic.sm';

  private static target(url: string): string {
    let base = url.trim();
    while (base.endsWith('/')) { base = base.substring(0, base.length - 1); }
    return base + '/' + WebDavClient.FILE_NAME;
  }

  private static authHeader(user: string, pass: string): Record<string, string> {
    if (user.length === 0) { return {}; }
    const cred = user + ':' + pass;
    const bytes = new util.TextEncoder().encodeInto(cred);
    const b64 = new util.Base64Helper().encodeToStringSync(bytes);
    return { 'Authorization': 'Basic ' + b64 };
  }

  /** 上传备份文本（PUT；HTTP ≥ 400 视为失败，原因带状态码） */
  static async put(url: string, user: string, pass: string, text: string): Promise<void> {
    if (url.trim().length === 0) {
      throw new ApiError(0, 'invalid', '请填写 WebDAV 地址');
    }
    const req = http.createHttp();
    try {
      const res = await req.request(WebDavClient.target(url), {
        method: http.RequestMethod.PUT,
        header: WebDavClient.mergeHeaders(WebDavClient.authHeader(user, pass),
          { 'Content-Type': 'application/json' }),
        extraData: text,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 15000,
        readTimeout: 60000
      });
      if (res.responseCode < 200 || res.responseCode >= 300) {
        throw new ApiError(res.responseCode, 'webdav', `上传失败（HTTP ${res.responseCode}）`);
      }
    } catch (e) {
      if (e instanceof ApiError) { throw e; }
      throw new ApiError(0, 'webdav', '连不上 WebDAV 服务，请检查地址与网络');
    } finally {
      req.destroy();
    }
  }

  /** 下载备份文本（GET；404 = 盘上还没有备份） */
  static async get(url: string, user: string, pass: string): Promise<string> {
    if (url.trim().length === 0) {
      throw new ApiError(0, 'invalid', '请填写 WebDAV 地址');
    }
    const req = http.createHttp();
    try {
      const res = await req.request(WebDavClient.target(url), {
        method: http.RequestMethod.GET,
        header: WebDavClient.authHeader(user, pass),
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 15000,
        readTimeout: 60000
      });
      if (res.responseCode < 200 || res.responseCode >= 300) {
        throw new ApiError(res.responseCode, 'webdav', `下载失败（HTTP ${res.responseCode}）`);
      }
      const text = typeof res.result === 'string' ? res.result : '';
      if (text.length === 0) {
        throw new ApiError(res.responseCode, 'empty', '下载到空文件');
      }
      return text;
    } catch (e) {
      if (e instanceof ApiError) { throw e; }
      throw new ApiError(0, 'webdav', '连不上 WebDAV 服务，请检查地址与网络');
    } finally {
      req.destroy();
    }
  }

  private static mergeHeaders(a: Record<string, string>, b: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    const aKeys = Object.keys(a);
    for (let i = 0; i < aKeys.length; i++) { out[aKeys[i]] = a[aKeys[i]]; }
    const bKeys = Object.keys(b);
    for (let i = 0; i < bKeys.length; i++) { out[bKeys[i]] = b[bKeys[i]]; }
    return out;
  }
}
