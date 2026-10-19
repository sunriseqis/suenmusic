/**
 * 「当前是否挂了服务端」的判断。
 *
 * 直连架构里这是所有数据层的分岔点：
 *   - 没有服务端（或没登录）→ 纯本地，一步网络都不该发
 *   - 有服务端且已登录     → 本地仍是主存储，网络是"再推一份"的备份动作
 *
 * ⚠️ 为什么必须显式判断而不能"发出去失败就算了"：
 * 基地址为空时 `/api/xxx` 会变成**相对路径**，打到同一域名下的静态服务器，
 * SPA 回退会返回 `index.html`（HTTP 200）—— `JSON.parse` 直接抛 SyntaxError，
 * 既不是 ApiError 也没有 401 分支能兜住。所以是"没配就别发"，不是"发了再容错"。
 */

import { getAccessToken, hasBackend } from '@/api/client.ts';

/** 有服务端且已登录。只有这种情况下的网络写入才有意义 */
export function serverReady(): boolean {
  return hasBackend() && getAccessToken() !== null;
}
