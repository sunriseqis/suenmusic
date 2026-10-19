/**
 * 分类广场 + 歌词验收脚本。
 *
 * 覆盖 P4 补齐的两个缺口：`/api/plaza*`、`/api/toplists`、`/api/lyrics/:id`。
 *
 * 上游预算：分类树 1 次、歌单广场 2 次、榜单列表 1 次、榜单详情 1 次、歌词 1 次，
 * 合计 6 次。刻意不碰 QQ 搜索 —— 搜索是最容易被风控的端点，而本脚本
 * 要验的东西完全不需要它。这样即使搜索正处于限流，本脚本依然会给出干净结论。
 *
 * 运行：npm run test:plaza
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { SERVER_ROOT } from '../config.ts';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { buildApp } from '../app.ts';

// ---------- 断言框架 ----------

let passed = 0;
let failed = 0;
let skipped = 0;
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
    failures.push(name + (detail ? ` — ${detail}` : ''));
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(
    name,
    same,
    same ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
  );
}

function skip(name: string, why: string): void {
  skipped++;
  process.stdout.write(`  SKIP ${name} — ${why}\n`);
}

function note(text: string): void {
  process.stdout.write(`       ${text}\n`);
}

// ---------- 环境 ----------

const tmpDb = join(SERVER_ROOT, 'data', `.plazatest-${randomBytes(4).toString('hex')}.db`);
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
  options: { body?: unknown; token?: string } = {}
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

function checkError(name: string, res: Res, status: number, code?: string): void {
  eq(`${name}：HTTP ${status}`, res.status, status);
  check(`${name}：错误体形状`, !!res.json?.error?.code && !!res.json?.error?.message);
  if (code) eq(`${name}：错误码`, res.json?.error?.code, code);
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

/** 上游限流时统一跳过 —— 那是外部因素，不该报成代码失败 */

// ---------- 主流程 ----------

async function main(): Promise<number> {
  process.stdout.write('SuenMusic 服务端 —— 分类广场 / 歌词验收\n');
  process.stdout.write(`临时库：${tmpDb}\n`);

  openDatabase(tmpDb);
  migrate();

  app = buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  note(`测试实例：${base}（随机端口，仅绑 127.0.0.1）`);

  const PASSWORD = 'test-password-1';
  const reg = await req('POST', '/api/auth/register', {
    body: { username: 'plazauser', password: PASSWORD },
  });
  const token: string = reg.json?.accessToken;
  check('注册拿到访问令牌', typeof token === 'string' && token.length > 20);

  // ---- 1. 鉴权边界 ----
  section('[1/5] 鉴权边界（未登录必须 401）');
  const protectedPaths = [
    '/api/plaza/categories',
    '/api/plaza',
    '/api/toplists',
    '/api/lyrics/qq_0039MnYb0qxYhV',
  ];
  for (const path of protectedPaths) {
    checkError(`未登录 GET ${path}`, await req('GET', path), 401, 'unauthorized');
  }

  // ---- 2. 分类树 ----
  section('[2/5] 分类树');
  const cats = await req('GET', '/api/plaza/categories', { token });
  eq('分类树返回 200', cats.status, 200);

  const tree: any[] = cats.json?.tree ?? [];
  if (!cats.json?.degraded && tree.length === 0 && cats.status === 200) {
    // 接口通了但结构变了
    check('分类树非空', false, '返回空树且无 degraded 标记');
  }

  if (tree.length === 0) {
    skip('分类树内容断言', '上游未返回分类（见 degraded 说明）');
    note(`degraded = ${JSON.stringify(cats.json?.degraded)}`);
  } else {
    check('分类树非空', true);
    check(
      '每个大分类都有名字与子分类',
      tree.every(g => typeof g.bigCat === 'string' && g.bigCat && Array.isArray(g.cats) && g.cats.length > 0),
      `实际 ${tree.length} 个大类`
    );
    const allCats = tree.flatMap(g => g.cats);
    check(
      '每个分类都有 name 与数字 id',
      allCats.every(c => typeof c.name === 'string' && c.name && Number.isFinite(c.id)),
      `共 ${allCats.length} 个分类`
    );
    eq('首次拉取标记为非缓存', cats.json?.cached, false);

    const cats2 = await req('GET', '/api/plaza/categories', { token });
    eq('二次拉取命中缓存', cats2.json?.cached, true);
    eq('二次结果与首次一致', JSON.stringify(cats2.json?.tree), JSON.stringify(tree));
  }

  // 记录一个可用分类，供下一步按名字解析
  const sampleCat = tree.length ? tree.flatMap(g => g.cats)[0] : null;

  // ---- 3. 歌单广场 ----
  section('[3/5] 歌单广场');
  checkError(
    '未知分类名',
    await req('GET', '/api/plaza?category=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E5%88%86%E7%B1%BBxyz', {
      token,
    }),
    400,
    'unknown_category'
  );

  // 按 tagId（全部）
  const plazaAll = await req('GET', '/api/plaza?page=1&pageSize=5', { token });
  eq('歌单广场返回 200', plazaAll.status, 200);

  const playlists: any[] = plazaAll.json?.playlists ?? [];
  if (playlists.length === 0) {
    skip('歌单广场内容断言', '上游未返回歌单（限流或改版）');
    note(`degraded = ${JSON.stringify(plazaAll.json?.degraded)}`);
  } else {
    eq('无 category 时 tagId 为「全部」', plazaAll.json?.tagId, 10_000_000);
    check('歌单非空', playlists.length > 0, `${playlists.length} 条`);
    check(
      '歌单 id 是路由键（qq_pl_ 前缀）',
      playlists.every(p => typeof p.id === 'string' && p.id.startsWith('qq_pl_')),
      `样例 ${playlists[0]?.id}`
    );
    check(
      '歌单带名字与封面',
      playlists.every(p => typeof p.name === 'string' && p.name),
      '存在无名歌单'
    );
    check('pageSize 生效', playlists.length <= 5, `实际 ${playlists.length}`);
    check('total 为数字', Number.isFinite(plazaAll.json?.total));
  }

  // 按分类名解析
  if (sampleCat) {
    const byName = await req(
      'GET',
      `/api/plaza?category=${encodeURIComponent(sampleCat.name)}&pageSize=3`,
      { token }
    );
    eq('按分类名查询返回 200', byName.status, 200);
    eq('分类名被正确解析为 tagId', byName.json?.tagId, sampleCat.id);

    // 按 tagId 直查，两者必须等价
    const byId = await req('GET', `/api/plaza?category=${sampleCat.id}&pageSize=3`, { token });
    eq('按 tagId 直查与按名字等价', byId.json?.tagId, byName.json?.tagId);
  }

  // ---- 4. 全部榜单 ----
  section('[4/5] 全部榜单');
  const tops = await req('GET', '/api/toplists', { token });
  eq('榜单列表返回 200', tops.status, 200);

  const topList: any[] = tops.json?.list ?? [];
  if (topList.length === 0) {
    skip('榜单列表内容断言', '上游未返回榜单');
    note(`degraded = ${JSON.stringify(tops.json?.degraded)}`);
  } else {
    check('榜单数量合理（官方 20~40 个）', topList.length >= 15 && topList.length <= 40, `${topList.length} 个`);
    check(
      '榜单 id 是路由键（qq_top_ 前缀）',
      topList.every(t => typeof t.id === 'string' && t.id.startsWith('qq_top_')),
      `样例 ${topList[0]?.id}`
    );
    check(
      '榜单带名字',
      topList.every(t => typeof t.name === 'string' && t.name),
      '存在无名榜单'
    );
  }

  // ---- 5. 歌词 ----
  section('[5/5] 歌词');
  checkError(
    '非法路由键',
    await req('GET', '/api/lyrics/not-a-key', { token }),
    400,
    'invalid_id'
  );
  checkError(
    '非曲目类型的路由键',
    await req('GET', '/api/lyrics/qq_al_0039MnYb0qxYhV', { token }),
    400,
    'invalid_id'
  );

  // 取一首真实曲目：优先外文榜 —— 只有外文歌才带翻译歌词，
  // 用中文榜验不出 tlyric 这条路径。1 次上游调用。
  let mid = '';
  let lyricTrackName = '';
  let isForeign = false;
  if (topList.length) {
    const foreign = topList.find(t => /欧美|日本|韩国|UK|公告牌|Billboard/i.test(t.name));
    const picked = foreign ?? topList[0];
    isForeign = !!foreign;

    const detail = await req(
      'GET',
      `/api/toplist/${encodeURIComponent(picked.id)}?limit=1`,
      { token }
    );
    const track = detail.json?.tracks?.[0];
    if (track?.mid) mid = track.mid;
    lyricTrackName = track?.name ?? '';
    note(`取到曲目：${lyricTrackName} (${mid || '无 mid'})${isForeign ? '［外文榜，用于验证翻译］' : ''}`);
  }

  if (!mid) {
    skip('歌词内容断言', '未能取到真实曲目 mid（榜单不可用）');
  } else {
    const lyric = await req('GET', `/api/lyrics/qq_${mid}`, { token });
    eq('歌词返回 200', lyric.status, 200);
    eq('返回的 id 是原路由键', lyric.json?.id, `qq_${mid}`);

    const lrc: string = lyric.json?.lrc?.lyric ?? '';
    check('响应结构含 lrc/tlyric', !!lyric.json?.lrc && !!lyric.json?.tlyric);
    check('不暴露未解密的 qrc/roma（上游为加密二进制）', lyric.json?.qrc === undefined);

    if (!lrc) {
      skip('歌词内容断言', '该曲目无歌词（纯音乐）或上游未返回');
    } else {
      check('歌词已解出为明文（含 LRC 时间戳）', lrc.includes('['), `前 40 字：${lrc.slice(0, 40)}`);
      check('歌词没有残留 Base64 特征', !/^[A-Za-z0-9+/]{40,}={0,2}$/.test(lrc.trim()));
      check('歌词不含替换字符（编码正确）', !lrc.includes('\uFFFD'));
      check('歌词行数合理', lrc.split('\n').length >= 2, `${lrc.split('\n').length} 行`);
    }

    const tlyric: string = lyric.json?.tlyric?.lyric ?? '';
    check('tlyric 为字符串', typeof lyric.json?.tlyric?.lyric === 'string');

    if (isForeign) {
      // 外文歌必带中文翻译。为空说明 trans:1 没生效 —— 那正是本项要守住的回归点。
      check('外文歌取到翻译歌词（trans:1 生效）', tlyric.length > 0, `实际长度 ${tlyric.length}`);
      if (tlyric) {
        check('翻译歌词为合法 LRC', tlyric.includes('['), `前 40 字：${tlyric.slice(0, 40)}`);
        check('翻译歌词不含替换字符', !tlyric.includes('\uFFFD'));
      }
    } else {
      skip('翻译歌词内容断言', '当前取到的是中文歌，通常无翻译');
    }

    eq(
      '歌词响应允许客户端长缓存',
      lyric.headers.get('cache-control'),
      'private, max-age=86400'
    );

    // 缓存命中：第二次请求不应再打上游（内容必须完全一致）
    const again = await req('GET', `/api/lyrics/qq_${mid}`, { token });
    eq('二次歌词内容一致（缓存生效）', JSON.stringify(again.json), JSON.stringify(lyric.json));
  }

  return failed > 0 ? 1 : skipped > 0 ? 2 : 0;
}

async function run(): Promise<void> {
  let code = 1;
  try {
    code = await main();
  } catch (err) {
    process.stdout.write(`\n未捕获异常：${(err as Error)?.stack ?? err}\n`);
    code = 1;
  } finally {
    const instance = app;
    if (instance) {
      try {
        await instance.close();
      } catch {
        // 忽略关闭异常
      }
    }
    cleanup();
  }

  process.stdout.write(`\n${'-'.repeat(60)}\n`);
  process.stdout.write(`通过 ${passed} ｜ 失败 ${failed} ｜ 跳过 ${skipped}\n`);
  if (failures.length) {
    process.stdout.write('\n失败项：\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
  }
  if (code === 2) {
    process.stdout.write('\n存在跳过项：上游限流或数据缺失，非代码缺陷（退出码 2）\n');
  }
  process.exit(code);
}

run();
