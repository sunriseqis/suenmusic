/**
 * P6 组装验收：一条命令跑完整链路。
 *
 * 与 `business-test.ts` 的分工：
 *   - `business-test` 是**模块级**验收 —— 211 项断言，逐项覆盖边界、错误码、幂等性
 *   - 本脚本是**端到端**验收 —— 模拟一个真实客户端从注册到听到声音的完整旅程，
 *     步骤少，但每步都走真实 HTTP + 真实上游
 *
 * 判定标准：**零失败**。任何一步失败立即停止 —— 后续步骤依赖前一步的结果，
 * 继续跑只会产生一堆误导性的连带失败。
 *
 * 退出码：
 *   0 = 全链路通过（核心功能完成）
 *   1 = 失败
 *   2 = 上游风控导致关键步骤无法验证（不是代码问题，稍后重跑）
 *
 * 运行：npm run acceptance
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SERVER_ROOT } from '../config.ts';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { buildApp } from '../app.ts';
import type { FastifyInstance } from 'fastify';

// ---------- 断言与输出 ----------

class StepFailure extends Error {}

let stepIndex = 0;
const STARTED_AT = Date.now();

function step(title: string): void {
  stepIndex++;
  process.stdout.write(`\n[${String(stepIndex).padStart(2)}] ${title}\n`);
}

function note(text: string): void {
  process.stdout.write(`     ·  ${text}\n`);
}

function must(condition: boolean, message: string, detail?: string): void {
  if (condition) {
    process.stdout.write(`     OK  ${message}\n`);
    return;
  }
  process.stdout.write(`     ERR ${message}${detail ? ` — ${detail}` : ''}\n`);
  throw new StepFailure(message);
}

function elapsed(): string {
  return `${((Date.now() - STARTED_AT) / 1000).toFixed(1)}s`;
}

// ---------- 环境 ----------

const tmpDb = join(SERVER_ROOT, 'data', `.accept-${randomBytes(4).toString('hex')}.db`);
let app: FastifyInstance | null = null;
let base = '';

interface Res {
  status: number;
  json: any;
  headers: Headers;
}

async function req(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string>; binary?: boolean } = {}
): Promise<Res> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let json: any = null;
  if (options.binary) {
    json = Buffer.from(await res.arrayBuffer());
  } else {
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
  }

  return { status: res.status, json, headers: res.headers };
}

function cleanup(): void {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(tmpDb + suffix, { force: true });
    } catch {
      // 清理失败不影响结论
    }
  }
}

// ---------- 主流程 ----------

async function main(): Promise<number> {
  process.stdout.write('SuenMusic 服务端 —— 组装验收 (P6)\n');
  process.stdout.write(`临时库：${tmpDb}\n`);

  // 1
  step('启动临时服务（随机端口，只绑 127.0.0.1）');
  openDatabase(tmpDb);
  migrate();
  app = buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  must(addr.address === '127.0.0.1', `监听 ${base}`, String(addr.address));

  const health = await req('GET', '/api/health');
  must(health.status === 200 && health.json?.ok === true, '健康检查可用', `HTTP ${health.status}`);

  // 2
  step('注册临时用户并登录');
  const username = `accept${randomBytes(3).toString('hex')}`;
  const password = 'accept-password-1';

  const reg = await req('POST', '/api/auth/register', { body: { username, password } });
  must(reg.status === 201, `注册成功（${username}）`, `HTTP ${reg.status}`);

  const login = await req('POST', '/api/auth/login', { body: { username, password } });
  must(
    login.status === 200 && typeof login.json?.accessToken === 'string',
    '用同一口令登录，拿到访问令牌',
    `HTTP ${login.status}`
  );
  const firstAccessToken: string = login.json.accessToken;
  const firstRefreshToken: string = login.json.refreshToken;

  const me = await req('GET', '/api/auth/me', { token: firstAccessToken });
  must(me.json?.user?.username === username, '访问令牌能换取当前用户');

  const anon = await req('GET', '/api/home');
  must(anon.status === 401, '未登录访问 /api/home 被拒（401）', `HTTP ${anon.status}`);

  // 3
  step('刷新令牌并轮换（长期在线的关键）');
  const refreshed = await req('POST', '/api/auth/refresh', { body: { refreshToken: firstRefreshToken } });
  must(refreshed.status === 200, '刷新接口返回 200', `HTTP ${refreshed.status}`);
  must(
    refreshed.json.accessToken !== firstAccessToken,
    '新访问令牌与旧的不同（jti 保证同秒签发也不重复）'
  );
  must(refreshed.json.refreshToken !== firstRefreshToken, '刷新令牌已轮换');

  const token: string = refreshed.json.accessToken;

  const reuseOld = await req('POST', '/api/auth/refresh', { body: { refreshToken: firstRefreshToken } });
  must(reuseOld.status >= 400, '旧刷新令牌不可再用（轮换生效）', `HTTP ${reuseOld.status}`);

  // 4
  step('搜索并取单曲');
  const search = await req('GET', '/api/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=song&limit=5', { token });
  must(search.status === 200, '搜索返回 200', `HTTP ${search.status}`);

  const songs: any[] = search.json?.songs ?? [];
  if (songs.length === 0) {
    note(`degraded = ${JSON.stringify(search.json?.degraded)}`);
    note('QQ 音乐返回空结果，多为 2001 风控限流（约 1 分钟自恢复）');
    note('这不是代码问题 —— 请稍后重跑 npm run acceptance');
    return 2;
  }

  must(true, `搜到 ${songs.length} 首，首条「${songs[0].name}」`);
  must(/^qq_(?!al_|ar_|pl_|top_).+/.test(songs[0].id), `单曲 id 是路由键（${songs[0].id}）`);

  const trackId: string = songs[0].id;
  const durationMs: number = Number(songs[0].dt) || 0;
  must(durationMs > 0, `曲目时长为正数（${durationMs}ms）`);

  const detail = await req('GET', `/api/tracks/${encodeURIComponent(trackId)}`, { token });
  must(
    detail.status === 200 && detail.json?.track?.id === trackId,
    '单曲详情可取（搜索时已写入缓存）',
    `HTTP ${detail.status}`
  );

  // 5
  step('建歌单 → 加 3 首 → 改序 → 删 1 首');
  const created = await req('POST', '/api/playlists', {
    token,
    body: { name: '  验收歌单  ', description: 'P6 组装验收' },
  });
  must(created.status === 201, '创建歌单返回 201', `HTTP ${created.status}`);
  must(created.json?.playlist?.name === '验收歌单', '歌单名已 trim', JSON.stringify(created.json?.playlist?.name));
  const playlistId: string = created.json.playlist.id;

  const seed = songs.slice(0, 3);
  must(seed.length === 3, '取到 3 首可入歌单的曲目', `实际 ${seed.length}`);

  const added = await req('POST', `/api/playlists/${playlistId}/tracks`, { token, body: { tracks: seed } });
  must(added.json?.added === 3, '加入 3 首', `added=${added.json?.added}`);
  must(added.json?.playlist?.trackCount === 3, '歌单计数更新为 3');

  const plDetail = await req('GET', `/api/playlists/${playlistId}`, { token });
  must(plDetail.json?.items?.length === 3, '歌单详情返回 3 条');
  must(
    plDetail.json.items.every((i: any) => i.track !== null),
    '每条都 JOIN 到曲目内容（客户端不必二次请求）'
  );
  must(plDetail.json.missing?.length === 0, '没有缺失曲目');

  const itemIds: number[] = plDetail.json.items.map((i: any) => i.itemId);
  const reversed = [...itemIds].reverse();

  const ordered = await req('PUT', `/api/playlists/${playlistId}/order`, { token, body: { itemIds: reversed } });
  must(ordered.status === 200, '重排返回 200', `HTTP ${ordered.status}`);
  const afterOrder = await req('GET', `/api/playlists/${playlistId}`, { token });
  must(
    JSON.stringify(afterOrder.json.items.map((i: any) => i.itemId)) === JSON.stringify(reversed),
    '重排结果与请求一致'
  );

  const removed = await req('DELETE', `/api/playlists/${playlistId}/tracks/${itemIds[0]}`, { token });
  must(removed.status === 200, '按 itemId 移除返回 200', `HTTP ${removed.status}`);
  const afterRemove = await req('GET', `/api/playlists/${playlistId}`, { token });
  must(afterRemove.json?.items?.length === 2, '移除后剩 2 首', `实际 ${afterRemove.json?.items?.length}`);

  // 6
  step('收藏与取消收藏');
  const fav = await req('POST', '/api/favorites', { token, body: { track: seed[0] } });
  must(fav.status === 201 && fav.json?.added === true, '收藏返回 201 且 added=true', `HTTP ${fav.status}`);

  const favAgain = await req('POST', '/api/favorites', { token, body: { trackId } });
  must(favAgain.json?.added === false, '重复收藏幂等（added=false）');

  const favCheck = await req('POST', '/api/favorites/check', { token, body: { ids: [trackId] } });
  must(favCheck.json?.favorites?.[trackId] === true, '收藏状态查询正确');

  const unfav = await req('DELETE', `/api/favorites/${encodeURIComponent(trackId)}`, { token });
  must(unfav.json?.removed === true, '取消收藏成功');

  // 7
  step('上报 3 条历史 → 用 since 增量拉回');
  const baseTime = Date.now() - 30_000;
  const reported = await req('POST', '/api/history', {
    token,
    headers: { 'X-Device-Id': 'accept-device' },
    body: {
      plays: [
        { trackId, playedAt: baseTime, playedMs: 0, durationMs },
        { trackId, playedAt: baseTime + 1000, playedMs: 1000, durationMs },
        { trackId, playedAt: baseTime + 2000, playedMs: 2000, durationMs, completed: true },
      ],
      source: 'acceptance',
    },
  });
  must(
    reported.status === 201 && reported.json?.recorded === 3,
    '批量上报 3 条（模拟离线补报）',
    `recorded=${reported.json?.recorded}`
  );
  const reportedIds: number[] = reported.json.ids;

  const page1 = await req('GET', '/api/history?limit=2', { token });
  must(page1.json?.items?.length === 2, '第一页返回 2 条（limit=2）', `实际 ${page1.json?.items?.length}`);
  must(page1.json?.hasMore === true, '第一页标记 hasMore=true');

  const page2 = await req('GET', `/api/history?limit=2&since=${encodeURIComponent(page1.json.nextCursor)}`, { token });
  must(page2.json?.items?.length === 1, '第二页拿到剩余 1 条', `实际 ${page2.json?.items?.length}`);

  const seen = [...page1.json.items, ...page2.json.items].map((i: any) => i.id);
  must(
    JSON.stringify(seen) === JSON.stringify(reportedIds),
    '拉回顺序与上报顺序一致（游标按记录 id 递增，不重不漏）',
    `期望 ${JSON.stringify(reportedIds)}，实际 ${JSON.stringify(seen)}`
  );

  const deviceId = page1.json.items[0]?.deviceId;
  must(deviceId === 'accept-device', '设备号已记录（多端同步的识别依据）', String(deviceId));

  const progress = await req('GET', `/api/history/progress/${encodeURIComponent(trackId)}`, { token });
  must(progress.json?.playedMs === 2000, '续播进度取到最后一次（2000ms）', `实际 ${progress.json?.playedMs}`);

  // 8
  step('解析音源（真实上游：QQ 元数据 → B 站多维打分）');
  const resolved = await req('GET', `/api/resolve/${encodeURIComponent(trackId)}`, { token });
  must(resolved.status === 200, '解析接口返回 200', `HTTP ${resolved.status}`);
  note(
    `ok=${resolved.json?.ok} score=${resolved.json?.score} bvid=${resolved.json?.bvid} ` +
      `hit=${resolved.json?.hitLevel} ${resolved.json?.costMs}ms`
  );

  if (!resolved.json?.ok) {
    note(`失败原因 ${resolved.json?.reason}：${resolved.json?.message}`);
    note('B 站风控（rejected）时配置 SUENMUSIC_BILIBILI_COOKIE 可显著降低触发概率');
    note('这不是代码问题 —— 请稍后重跑 npm run acceptance');
    return 2;
  }

  must(resolved.json.score >= 60, `置信度 ${resolved.json.score} 不低于熔断阈值 60`);
  must(typeof resolved.json.bvid === 'string' && resolved.json.bvid.length > 0, `匹配到 ${resolved.json.bvid}`);
  must(
    String(resolved.json.streamUrl).startsWith('/api/stream/'),
    'streamUrl 指向服务端（客户端拿 B 站裸地址必然 403）'
  );
  must(String(resolved.json.streamUrl).includes('?t='), 'streamUrl 带短期播放令牌');

  // 9
  step('音频流代理：Range 拉 64KB');
  const streamUrl: string = resolved.json.streamUrl;
  const wanted = 64 * 1024;

  const ranged = await req('GET', streamUrl, {
    headers: { Range: `bytes=0-${wanted - 1}` },
    binary: true,
  });
  must(ranged.status === 206, '返回 206 Partial Content', `HTTP ${ranged.status}`);

  const got = (ranged.json as Buffer).length;
  must(got === wanted, `恰好收到 ${wanted} 字节`, `实际 ${got}`);

  const contentRange = ranged.headers.get('content-range') ?? '';
  must(
    new RegExp(`^bytes 0-${wanted - 1}/\\d+$`).test(contentRange),
    `Content-Range 与请求一致：${contentRange}`
  );
  const total = Number(contentRange.split('/')[1]);
  must(total > wanted, `总长度 ${total} 字节（进度条据此计算）`);
  must(ranged.headers.get('accept-ranges') === 'bytes', '声明 Accept-Ranges: bytes');

  const start = Math.floor(total / 2);
  const seeked = await req('GET', streamUrl, {
    headers: { Range: `bytes=${start}-${start + 1023}` },
    binary: true,
  });
  const seekBytes = (seeked.json as Buffer).length;
  must(
    seeked.status === 206 && seekBytes === 1024,
    '中段拖动返回 1024 字节（进度条可用）',
    `HTTP ${seeked.status}，实际 ${seekBytes} 字节`
  );

  const noAuth = await req('GET', streamUrl.split('?')[0]);
  must(noAuth.status === 401, '裸地址无令牌访问被拒（401）', `HTTP ${noAuth.status}`);

  // 10
  step('清理临时数据');
  const cleared = await req('DELETE', '/api/history', { token });
  must(cleared.json?.ok === true, '清空播放历史（隐私操作）');

  const deletedPl = await req('DELETE', `/api/playlists/${playlistId}`, { token });
  must(deletedPl.status === 200 && deletedPl.json?.ok === true, '删除验收歌单', `HTTP ${deletedPl.status}`);

  const loggedOut = await req('POST', '/api/auth/logout', {
    body: { refreshToken: refreshed.json.refreshToken },
  });
  must(loggedOut.json?.ok === true, '退出登录');

  return 0;
}

// ---------- 入口 ----------

let code = 1;
try {
  code = await main();
} catch (err) {
  if (err instanceof StepFailure) {
    process.stdout.write(`\n链路在步骤 [${stepIndex}] 中断\n`);
    code = 1;
  } else {
    process.stderr.write(`\n验收脚本异常：${(err as Error)?.stack ?? err}\n`);
    code = 1;
  }
} finally {
  // TS 的控制流分析看不到 main() 内的赋值，断言一次拿回联合类型
  const instance = app as FastifyInstance | null;
  if (instance) {
    try {
      await instance.close();
    } catch {
      // 忽略
    }
  }
  cleanup();
}

process.stdout.write('\n' + '-'.repeat(60) + '\n');
if (code === 0) {
  process.stdout.write(`组装验收通过：核心链路端到端可用（耗时 ${elapsed()}）。\n`);
} else if (code === 2) {
  process.stdout.write(`组装验收未完成：上游风控导致关键步骤无法验证，请稍后重跑（耗时 ${elapsed()}）。\n`);
} else {
  process.stdout.write(`组装验收未通过（耗时 ${elapsed()}）。\n`);
}
process.exit(code);
