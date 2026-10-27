/**
 * 业务 API 验收脚本（P4 + P5）。
 *
 * 起真实监听的实例（端口 0），用 fetch 走真实 HTTP，验完关掉删库。
 *
 * 上游调用预算刻意压到最低：整个脚本只对 QQ 搜索 1~2 次、对 B 站解析 1 次，
 * 其余全部走缓存。连续高频打上游会把自己打进风控，那时失败就成了"测试导致的失败"，
 * 反而掩盖真问题。
 *
 * 运行：npm run test:business
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SERVER_ROOT } from '../config.ts';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { buildApp } from '../app.ts';
import { biliCooldown } from '../sources/bilibili/stream.ts';
import {
  adaptQQTracks,
  dedupeRawByMid,
  withoutAccompaniment,
} from '../sources/qq/adapter.ts';
import { getSource } from '../db/repo/sources.ts';
import { getSetting } from '../db/repo/settings.ts';
import type { FastifyInstance } from 'fastify';

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
  check(name, same, same ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function skip(name: string, why: string): void {
  skipped++;
  process.stdout.write(`  SKIP ${name} — ${why}\n`);
}

function note(text: string): void {
  process.stdout.write(`       ${text}\n`);
}

// ---------- 环境 ----------

const tmpDb = join(SERVER_ROOT, 'data', `.biztest-${randomBytes(4).toString('hex')}.db`);
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
  options: { body?: unknown; token?: string; cookie?: string; headers?: Record<string, string>; binary?: boolean } = {}
): Promise<Res> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // Web 面板通道：HttpOnly cookie + CSRF 头（管理接口只认这条通道）
  if (options.cookie) {
    headers.Cookie = options.cookie;
    if (method !== 'GET' && method !== 'HEAD') headers['X-Requested-With'] = 'suenmusic';
  }
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

// ---------- 主流程 ----------

async function main(): Promise<number> {
  process.stdout.write('SuenMusic 服务端 —— 业务 API 验收 (P4 + P5)\n');
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
    body: { username: 'bizuser', password: PASSWORD },
  });
  const token: string = reg.json.accessToken;

  // 产品行为：首个账号注册成功后注册通道自动收闭（规划：注册完后由管理员决定开不开）。
  // 先验证"默认已关"，再用管理员身份打开，然后才建得到第二个号。
  const closedReg = await req('POST', '/api/auth/register', {
    body: { username: 'blockeduser', password: PASSWORD },
  });
  checkError('首个账号后注册自动收闭', closedReg, 403, 'forbidden');

  // 管理操作只认 Web 面板 cookie 会话（Bearer 一律 403）
  const sess = await req('POST', '/api/auth/session', {
    body: { username: 'bizuser', password: PASSWORD },
  });
  const m = /suen_session=[^;]*/.exec(sess.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('会话登录未下发 cookie');
  const adminCookie = m[0];
  const bearerAdmin = await req('GET', '/api/admin/users', { token });
  checkError('管理员 Bearer 被渠道闸挡下', bearerAdmin, 403, 'forbidden');

  const openReg = await req('PATCH', '/api/admin/settings', {
    cookie: adminCookie,
    body: { allowRegistration: true },
  });
  check('管理员可重新打开注册', openReg.status === 200);

  const reg2 = await req('POST', '/api/auth/register', {
    body: { username: 'otheruser', password: PASSWORD },
  });
  const token2: string = reg2.json.accessToken;

  // ---- 1. 鉴权边界 ----
  section('[1/8] 鉴权边界（未登录必须 401）');
  const protectedPaths: Array<[string, string]> = [
    ['GET', '/api/home'],
    ['GET', '/api/search?q=test'],
    ['GET', '/api/favorites'],
    ['GET', '/api/history'],
    ['GET', '/api/resolve/qq_x'],
    ['GET', '/api/artists/qq_ar_003fA5G40k6hKc/albums'],
    ['GET', '/api/bilibili/account'],
  ];
  for (const [method, path] of protectedPaths) {
    const r = await req(method, path);
    checkError(`未登录 ${method} ${path.split('?')[0]}`, r, 401, 'unauthorized');
  }

  // ---- 2. 搜索 ----
  section('[2/8] 搜索');
  checkError(
    '缺少 q 参数',
    await req('GET', '/api/search', { token }),
    400,
    'missing_param'
  );
  checkError(
    '不支持的 type',
    await req('GET', '/api/search?q=x&type=bogus', { token }),
    400,
    'invalid_type'
  );

  const search = await req('GET', '/api/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=song&limit=5', {
    token,
  });
  eq('搜索返回 200', search.status, 200);

  const songs: any[] = search.json?.songs ?? [];
  if (songs.length === 0) {
    note(`degraded = ${JSON.stringify(search.json?.degraded)}`);
    if (search.json?.degraded?.code === 2001) {
      // 上游限流不是代码缺陷：报失败会误导成"代码坏了"。
      // 而且后续大半个脚本都依赖搜索结果，继续跑只会堆出一串连带失败。
      note('QQ 2001 风控限流（约 1 分钟自恢复），依赖搜索结果的断言无法验证');
      note('这不是代码问题 —— 请稍后重跑 npm run test:business');
      return 2;
    }
    check('搜到单曲', false, '搜索结果为空');
  } else {
    check('搜到单曲', true);
    note(`命中 ${songs.length} 首，第一首：${songs[0].name}`);

    const s = songs[0];
    // 多源聚合后单曲可能来自酷狗（kg_）或网易云（ne_），三套前缀都合法
    check(
      '单曲 id 是路由键（qq_/kg_/ne_）',
      /^(?:qq_(?!al_|ar_|pl_|top_)|kg_(?!al_|ar_)|ne_(?!al_|ar_|pl_)).+/.test(s.id),
      s.id,
    );
    check('专辑 id 是路由键（*_al_<id>）', /^(?:qq|kg|ne)_al_.+/.test(s.al?.id ?? ''), s.al?.id);
    check('歌手 id 是路由键（*_ar_<id>）', /^(?:qq|kg|ne)_ar_.+/.test(s.ar?.[0]?.id ?? ''), s.ar?.[0]?.id);
    check(
      '专辑封面来自已知图床（QQ / 酷狗 / 网易云）',
      /(y\.gtimg\.cn|imge\.kugou\.com|music\.126\.net)/.test(String(s.al?.picUrl ?? '')),
      s.al?.picUrl,
    );
    check('时长为正数（毫秒）', Number(s.dt) > 0, `dt=${s.dt}`);
    eq('artists 与 ar 一致', s.artists?.length, s.ar?.length);
    check('提供播放特权字段（前端兼容）', !!s.privilege);
  }

  const artistSearch = await req('GET', '/api/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=artist', {
    token,
  });
  const artists: any[] = artistSearch.json?.artists ?? [];
  check('歌手分片能搜到结果', artists.length > 0, `实际 ${artists.length}`);

  // ---- hasMore 必须是分片级 ----
  // 旧实现只有一个顶层 `hasMore = songs.length >= limit`：
  // 搜歌手/专辑/歌单时 songs 恒为空 → hasMore 永远是 false → 明明还有下一页却翻不动。
  // 这里用"必然成立"的等式来钉住修复，不依赖上游返回多少条。
  const slicedSong = await req(
    'GET',
    '/api/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=song&limit=5',
    { token }
  );
  eq('按 song 分片搜索返回 200', slicedSong.status, 200);
  check(
    'hasMore 是分片级对象而不是单一布尔值',
    !!slicedSong.json?.hasMore && typeof slicedSong.json.hasMore === 'object',
    JSON.stringify(slicedSong.json?.hasMore)
  );
  check(
    '请求 song 分片时 hasMore.song 为 true（limit=5 必然被填满）',
    slicedSong.json?.hasMore?.song === true,
    `songs=${slicedSong.json?.songs?.length}`
  );
  check(
    '没请求的 artist 分片不谎报"还有更多"',
    slicedSong.json?.hasMore?.artist === false,
    JSON.stringify(slicedSong.json?.hasMore)
  );

  const slicedArtist = await req(
    'GET',
    '/api/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=artist&limit=3',
    { token }
  );
  eq('按 artist 分片搜索返回 200', slicedArtist.status, 200);
  const artistSliceCount: number = slicedArtist.json?.artists?.length ?? 0;
  check(
    '搜歌手时 songs 确实为空（正是这条让旧实现永远翻不动）',
    (slicedArtist.json?.songs?.length ?? 0) === 0
  );
  check(
    '搜歌手时 hasMore.artist 由歌手分片自己决定，而不是被空的 songs 一票否决',
    slicedArtist.json?.hasMore?.artist === artistSliceCount >= 3,
    `artists=${artistSliceCount} hasMore.artist=${slicedArtist.json?.hasMore?.artist}`
  );
  if (artists[0]) {
    check('歌手 id 是路由键', /^(?:qq|kg|ne)_ar_.+/.test(artists[0].id), artists[0].id);
  }

  const albumSearch = await req('GET', '/api/search?q=%E5%8F%B6%E6%83%A0%E7%BE%8E&type=album', {
    token,
  });
  const albums: any[] = albumSearch.json?.albums ?? [];
  check('专辑分片能搜到结果', albums.length > 0, `实际 ${albums.length}`);
  if (albums[0]) {
    check('专辑 id 是路由键', /^qq_al_.+/.test(albums[0].id), albums[0].id);
  }

  // ---- 3. 首页与榜单 ----
  section('[3/8] 首页与榜单');
  const home = await req('GET', '/api/home', { token });
  eq('首页返回 200', home.status, 200);
  check('返回新歌首发', (home.json?.newSongs?.length ?? 0) > 0, `${home.json?.newSongs?.length}`);
  check('返回新碟首发', (home.json?.newAlbums?.length ?? 0) > 0, `${home.json?.newAlbums?.length}`);
  check('返回核心榜单', (home.json?.toplists?.length ?? 0) > 0, `${home.json?.toplists?.length}`);
  // 「推荐歌单」是按标签固定的数据，长期不变、没有信息增量，已整块移除。
  // 显式钉住它不能回来 —— 否则哪天顺手还原，没人会注意到上游又多打了一次请求。
  check(
    '首页不再返回推荐歌单',
    home.json?.playlists === undefined,
    `playlists=${JSON.stringify(home.json?.playlists)}`
  );
  // 上游 `GetFocus` 那组运营大图与 Q 音首页真正那栏「精彩推荐」**对不上**，
  // 真正那栏走加密接口拿不到 —— 拿不到就不摆，整块移除，顶部改由新碟首发担纲。
  check(
    '首页不再返回精彩推荐大图',
    home.json?.banners === undefined,
    `banners=${JSON.stringify(home.json?.banners)?.slice(0, 60)}`
  );
  // 新碟的 id 必须是路由键，且带发行时间（首页卡片要用）
  const newAlbum = home.json?.newAlbums?.[0];
  if (newAlbum) {
    check('新碟 id 是路由键', /^qq_al_.+/.test(newAlbum.id), newAlbum.id);
    check('新碟带发行时间', typeof newAlbum.publishTime === 'string' && newAlbum.publishTime.length > 0, newAlbum.publishTime);
    check('新碟封面为 https', String(newAlbum.picUrl).startsWith('https://'), String(newAlbum.picUrl).slice(0, 60));
  }
  const topIds = (home.json?.toplists ?? []).map((t: { topId: number }) => t.topId).sort((a: number, b: number) => a - b);
  check(
    '巅峰榜固定为 飙升62/热歌26/新歌27/流行指数4',
    JSON.stringify(topIds) === JSON.stringify([4, 26, 27, 62]),
    JSON.stringify(topIds)
  );
  check(
    '首页带缓存头（减轻上游压力）',
    (home.headers.get('cache-control') ?? '').includes('max-age')
  );

  const top = await req('GET', '/api/toplist/26?limit=10', { token });
  eq('热歌榜返回 200', top.status, 200);
  check('榜单曲目非空', (top.json?.tracks?.length ?? 0) > 0, `${top.json?.tracks?.length}`);
  eq('榜单 id 规范化', top.json?.id, 'qq_top_26');
  if (top.json?.topInfo) {
    check(
      '榜单简介已转纯文本（无 HTML 标签）',
      !/<br\s*\/?>|<[a-z]+>/i.test(String(top.json.topInfo.intro ?? '')),
      String(top.json.topInfo.intro ?? '').slice(0, 80)
    );
  }
  checkError('榜单 id 非法', await req('GET', '/api/toplist/abc', { token }), 400, 'invalid_id');

  // ---- 4. 专辑 / 歌手 / 单曲 ----
  section('[4/8] 专辑 / 歌手 / 单曲');

  if (albums[0]) {
    const albumRes = await req('GET', `/api/albums/${albums[0].id}?limit=20`, { token });
    eq('专辑详情返回 200', albumRes.status, 200);
    check('专辑有曲目', (albumRes.json?.songs?.length ?? 0) > 0, `${albumRes.json?.songs?.length}`);
    check(
      '专辑歌手不空（详情 basicInfo 不含歌手，取自 data.singer.singerList）',
      (albumRes.json?.album?.artists?.length ?? 0) > 0,
      JSON.stringify(albumRes.json?.album?.artists)
    );
    const [first] = albumRes.json.songs;
    check('专辑内曲目所属专辑指向本专辑', first.al?.id === albums[0].id, `${first.al?.id} vs ${albums[0].id}`);
    check('曲目正常时 notice 为 null', albumRes.json?.notice === null, JSON.stringify(albumRes.json?.notice));
  } else {
    skip('专辑详情', '搜索未返回专辑');
  }

  // 版权受限专辑（实测样本：周深《Crush》）。
  // 新版 GetAlbumSongList 只回 `totalNum: 0`，一个字原因都不给 ——
  // 原因必须由服务端去老接口 `albumTips` 里捞回来，客户端才有准确文案。
  // 上游状态随时会变，所以两条分支都算通过，但**都不允许静默**。
  {
    const restricted = await req('GET', '/api/albums/qq_al_002cGk8c06OfJt', { token });
    eq('版权受限专辑返回 200', restricted.status, 200);
    const emptyCount = restricted.json?.songs?.length ?? 0;
    if (emptyCount === 0) {
      check(
        '曲目为空时带回上游原因 notice',
        typeof restricted.json?.notice === 'string' && restricted.json.notice.length > 0,
        JSON.stringify(restricted.json?.notice)
      );
    } else {
      check(
        `该专辑本次有 ${emptyCount} 首曲目`,
        restricted.json?.notice === null,
        `notice=${JSON.stringify(restricted.json?.notice)}（上游状态已变，不是缺陷）`
      );
    }
    check(
      '空曲目专辑仍返回歌手（否则专辑页会渲染成空白的 "by "）',
      (restricted.json?.album?.artists?.length ?? 0) > 0 &&
        !!restricted.json?.album?.artists?.[0]?.name,
      JSON.stringify(restricted.json?.album?.artists)
    );
  }

  checkError(
    '把歌手 id 传给专辑端点',
    await req('GET', '/api/albums/qq_ar_xxx', { token }),
    400,
    'invalid_id'
  );
  checkError('不存在的专辑返回 404', await req('GET', '/api/albums/qq_al_zzzznotexist', { token }), 404, 'not_found');

  if (artists[0]) {
    const artistRes = await req('GET', `/api/artists/${artists[0].id}`, { token });
    eq('歌手详情返回 200', artistRes.status, 200);
    check('歌手有名字', !!artistRes.json?.artist?.name, JSON.stringify(artistRes.json?.artist?.name));
    check(
      '歌手有头像（img1v1Url 已填）',
      !!artistRes.json?.artist?.img1v1Url,
      String(artistRes.json?.artist?.img1v1Url)
    );
    note(
      `歌手：${artistRes.json.artist.name}  专辑数=${artistRes.json.artist.albumSize}  ` +
        `MV=${artistRes.json.artist.mvSize}`
    );

    const artistSongs = await req('GET', `/api/artists/${artists[0].id}/songs?limit=10`, { token });
    eq('歌手歌曲返回 200', artistSongs.status, 200);
    if ((artistSongs.json?.songs?.length ?? 0) === 0 && artistSongs.json?.degraded?.code === 2001) {
      // 上游限流不等于"这位歌手没歌"，标跳过而不是失败
      skip('歌手歌曲', 'QQ 2001 风控限流（约 1 分钟自恢复），不是代码问题');
    } else {
      check('歌手歌曲非空', (artistSongs.json?.songs?.length ?? 0) > 0, `${artistSongs.json?.songs?.length}`);
      check(
        '歌曲以该歌手为主（按 mid 过滤生效）',
        artistSongs.json.songs.filter((x: any) =>
          (x.ar ?? []).some((a: any) => a.id === artists[0].id)
        ).length >= Math.min(3, artistSongs.json.songs.length),
        '过滤后归属该歌手的曲目过少'
      );
    }
    // ---- 歌手专辑 ----
    // 这条接的是 2026-09-11 用户反馈的"歌手详情页没有专辑列表"。
    // 上游**没有**歌手专辑专用接口（GetSingerAlbum / GetSingerAlbumList 全 40000），
    // 只能搜索 album 分片按名召回再按 mid 过滤 —— 所以这里要验的正是
    // "过滤是否真的生效"，而不是"有没有返回东西"。
    const artistAlbums = await req(
      'GET',
      `/api/artists/${artists[0].id}/albums?name=${encodeURIComponent(artistRes.json.artist.name)}&limit=20`,
      { token }
    );
    eq('歌手专辑返回 200', artistAlbums.status, 200);
    const albumList: any[] = artistAlbums.json?.albums ?? [];
    if (albumList.length === 0 && artistAlbums.json?.degraded?.code === 2001) {
      skip('歌手专辑', 'QQ 2001 风控限流，不是代码问题');
    } else {
      check('歌手专辑非空', albumList.length > 0, `${albumList.length} 张`);
      check(
        '专辑 id 是路由键（qq_al_<mid>）',
        albumList.every((a: any) => /^qq_al_.+/.test(a.id ?? '')),
        JSON.stringify(albumList.slice(0, 2).map((a: any) => a.id))
      );
      check(
        '专辑按 mid 去重（搜索会按版本重复召回）',
        new Set(albumList.map((a: any) => a.id)).size === albumList.length,
        `${albumList.length} 张中有 ${albumList.length - new Set(albumList.map((a: any) => a.id)).size} 张重复`
      );
      check(
        '专辑封面是 https（部署到 https 不会被混合内容拦掉）',
        albumList.every((a: any) => !a.picUrl || a.picUrl.startsWith('https://')),
        String(albumList[0]?.picUrl ?? '')
      );
      check(
        '专辑以该歌手为主（mid 过滤生效）',
        albumList.filter((a: any) =>
          (a.artists ?? []).some((x: any) => x.id === artists[0].id)
        ).length >= Math.min(3, albumList.length),
        '过滤后归属该歌手的专辑过少'
      );
      note(
        `歌手专辑：${albumList.slice(0, 3).map((a: any) => a.name).join(' / ')}` +
          (albumList.length > 3 ? ` …（共 ${albumList.length} 张）` : '')
      );
    }
  } else {
    skip('歌手详情与歌曲', '搜索未返回歌手');
  }

  if (songs[0]) {
    const trackRes = await req('GET', `/api/tracks/${songs[0].id}`, { token });
    eq('单曲详情返回 200', trackRes.status, 200);
    eq('命中本地缓存（搜索时已写入）', trackRes.json?.source, 'cache');
    eq('曲目 id 一致', trackRes.json?.track?.id, songs[0].id);

    const batch = await req('POST', '/api/tracks/batch', {
      token,
      body: { ids: [songs[0].id, 'qq_zzzznotexist'] },
    });
    eq('批量取曲目返回 200', batch.status, 200);
    eq('批量返回 1 首', batch.json?.tracks?.length, 1);
    eq('报告缺失 id', batch.json?.missing, ['qq_zzzznotexist']);
  }
  checkError('单曲 id 非法', await req('GET', '/api/tracks/nonsense-id', { token }), 400, 'invalid_id');

  // ---- 6. 收藏 ----
  section('[5/8] 收藏');
  if (songs[0]) {
    const fav1 = await req('POST', '/api/favorites', { token, body: { tracks: undefined, track: songs[0] } });
    eq('收藏返回 201', fav1.status, 201);
    eq('added 为 true', fav1.json?.added, true);

    const fav2 = await req('POST', '/api/favorites', { token, body: { trackId: songs[0].id } });
    eq('重复收藏返回 200', fav2.status, 200);
    eq('added 为 false（幂等）', fav2.json?.added, false);

    const favList = await req('GET', '/api/favorites', { token });
    eq('收藏列表返回 200', favList.status, 200);
    eq('收藏 1 首', favList.json?.items?.length, 1);
    eq('总数正确', favList.json?.total, 1);
    check('收藏项带曲目内容', favList.json.items[0].track !== null);
    eq('无下一页时游标为 null', favList.json?.nextCursor, null);

    const favCheck = await req('POST', '/api/favorites/check', {
      token,
      body: { ids: [songs[0].id, 'qq_notfav'] },
    });
    eq('收藏状态查询正确', favCheck.json?.favorites, {
      [songs[0].id]: true,
      qq_notfav: false,
    });

    const favTracks = await req('GET', '/api/favorites/tracks', { token });
    eq('收藏曲目内容返回 1 首', favTracks.json?.tracks?.length, 1);

    const unfav = await req('DELETE', `/api/favorites/${songs[0].id}`, { token });
    eq('取消收藏返回 200', unfav.status, 200);
    eq('removed 为 true', unfav.json?.removed, true);
    eq('重复取消返回 removed false', (await req('DELETE', `/api/favorites/${songs[0].id}`, { token })).json?.removed, false);
    eq('收藏已清空', (await req('GET', '/api/favorites', { token })).json?.total, 0);

    checkError('缺少 trackId', await req('POST', '/api/favorites', { token, body: {} }), 400, 'missing_param');
  } else {
    skip('收藏', '搜索未返回曲目');
  }

  // ---- 7. 播放历史（增量同步） ----
  section('[6/8] 播放历史与增量同步');
  const histTrackId = songs[0]?.id ?? 'qq_zzzznotexist';

  const single = await req('POST', '/api/history', {
    token,
    body: { trackId: histTrackId, playedMs: 1000, durationMs: 250000, source: 'android' },
  });
  eq('上报单条返回 201', single.status, 201);
  eq('记录 1 条', single.json?.recorded, 1);

  const baseTime = Date.now() - 60_000;
  const batch = await req('POST', '/api/history', {
    token,
    headers: { 'X-Device-Id': 'android-001' },
    body: {
      plays: Array.from({ length: 6 }, (_, i) => ({
        trackId: histTrackId,
        playedAt: baseTime + i * 1000,
        playedMs: i * 1000,
        durationMs: 250_000,
        completed: i === 5,
      })),
      source: 'web',
    },
  });
  eq('批量上报返回 201', batch.status, 201);
  eq('批量记录 6 条', batch.json?.recorded, 6);

  checkError('缺少 trackId', await req('POST', '/api/history', { token, body: {} }), 400, 'invalid_play');
  checkError(
    '游标格式非法',
    await req('GET', '/api/history?since=bogus', { token }),
    400,
    'invalid_cursor'
  );

  // 分页增量拉取：逐页推进游标，必须拿全且不重不漏
  let cursor: string | null = null;
  const collected: number[] = [];
  let rounds = 0;
  let cursorOk = true;
  let ascOk = true;
  let prev = -1;
  for (;;) {
    const url = `/api/history?limit=3${cursor ? `&since=${encodeURIComponent(cursor)}` : ''}`;
    const page = await req('GET', url, { token });
    if (page.status !== 200) {
      check('增量拉取返回 200', false, `实际 ${page.status}`);
      break;
    }
    // 游标就是记录 id（纯数字）。服务端为了让客户端"追平后能继续拿同一个游标轮询"
    // 会在无新增时回显传入的 since，所以这里不能用 nextCursor === null 判断结束。
    if (cursor !== null && !/^\d+$/.test(cursor)) cursorOk = false;
    for (const item of page.json.items ?? []) {
      if (item.id <= prev) ascOk = false;
      prev = item.id;
      collected.push(item.id);
    }
    cursor = page.json.nextCursor;
    rounds++;
    // 结束条件看"这一页还有没有数据 / 还有没有下一页"，而不是游标是否变 null
    if ((page.json.items?.length ?? 0) === 0 || !page.json.hasMore) break;
    if (cursor === null || rounds > 10) break;
  }
  check('游标格式合法', cursorOk);
  eq('增量拉取共 7 条', collected.length, 7);
  eq('增量拉取无重复', new Set(collected).size, 7);
  check('增量拉取严格递增', ascOk);
  check('分页轮次 > 1（确实分页了）', rounds > 1, `轮次=${rounds}`);

  const caughtUp = await req('GET', `/api/history?since=${encodeURIComponent(cursor ?? '')}`, { token });
  eq('追平后 hasMore 为 false', caughtUp.json?.hasMore, false);
  eq('追平后无新增', caughtUp.json?.items?.length, 0);

  const newPlay = await req('POST', '/api/history', {
    token,
    // playedAt 必须晚于前面那条单条上报 —— 它没传 playedAt，用的是服务端 now()。
    // 若这里给一个较早的时间，/progress 的"最后一次"取到的仍是那条。
    body: { trackId: histTrackId, playedAt: Date.now() + 500, playedMs: 9000 },
  });
  const delta = await req('GET', `/api/history?since=${encodeURIComponent(cursor!)}`, { token });
  eq('增量恰好 1 条', delta.json?.items?.length, 1);
  eq('增量内容正确', delta.json?.items?.[0]?.id, newPlay.json.ids[0]);
  eq('增量带曲目内容', delta.json?.items?.[0]?.track !== null, true);

  // 设备号来自 X-Device-Id 头，只有批量那 6 条带过（id 从 2 起）；
  // 上面这条单条上报没带设备号，拿它断言会得到空串。
  const firstBatch = await req('GET', '/api/history?limit=1&since=1', { token });
  eq('设备号已记录', firstBatch.json?.items?.[0]?.deviceId, 'android-001');

  const recent = await req('GET', '/api/history/recent?limit=10', { token });
  eq('最近播放返回 200', recent.status, 200);
  eq('去重后仅 1 首（同一首歌）', recent.json?.items?.length, 1);
  const recentRaw = await req('GET', '/api/history/recent?limit=50&dedupe=false', { token });
  eq('不去重返回全部 8 条', recentRaw.json?.items?.length, 8);

  const progress = await req('GET', `/api/history/progress/${encodeURIComponent(histTrackId)}`, { token });
  eq('续播进度返回 200', progress.status, 200);
  eq('取到最后一次进度', progress.json?.playedMs, 9000);
  checkError(
    '没有记录的曲目取进度',
    await req('GET', '/api/history/progress/qq_zzzznotexist', { token }),
    404,
    'not_found'
  );

  const batchProgress = await req('POST', '/api/history/progress', {
    token,
    body: { ids: [histTrackId, 'qq_zzzznotexist'] },
  });
  eq('批量取进度只返回有记录的', Object.keys(batchProgress.json?.progress ?? {}), [histTrackId]);

  const histTracks = await req('GET', '/api/history/tracks', { token });
  eq('历史曲目内容返回 1 首', histTracks.json?.tracks?.length, 1);

  const delOne = await req('DELETE', `/api/history/${newPlay.json.ids[0]}`, { token });
  eq('删除单条返回 200', delOne.status, 200);
  checkError('重复删除返回 404', await req('DELETE', `/api/history/${newPlay.json.ids[0]}`, { token }), 404, 'not_found');
  checkError(
    '跨用户删除无效',
    await req('DELETE', `/api/history/${collected[0]}`, { token: token2 }),
    404,
    'not_found'
  );

  // ---- 8. 音源解析（P5 前置） ----
  section('[7/8] 音源解析');
  if (biliCooldown.active()) {
    skip('音源解析与流转发', 'B 站处于冷却窗口，避免继续打上游');
  } else {
    const resolve = await req('GET', `/api/resolve/${encodeURIComponent(histTrackId)}`, { token });
    eq('解析返回 200', resolve.status, 200);
    note(
      `解析结果 ok=${resolve.json?.ok} score=${resolve.json?.score} ` +
        `bvid=${resolve.json?.bvid} hit=${resolve.json?.hitLevel} ${resolve.json?.costMs}ms`
    );

    if (resolve.json?.ok) {
      check('置信度不低于阈值', resolve.json.score >= 60, `score=${resolve.json.score}`);
      check('给出 bvid', !!resolve.json.bvid);
      check(
        'streamUrl 指向服务端而非 B 站',
        String(resolve.json.streamUrl).startsWith('/api/stream/'),
        String(resolve.json.streamUrl)
      );
      check('streamUrl 带播放令牌', String(resolve.json.streamUrl).includes('?t='));
      check('给出匹配详情（便于排查误匹配）', !!resolve.json.matchedTitle);
      check('给出候选榜', Array.isArray(resolve.json.topCandidates));
      check('给出令牌有效期', resolve.json.streamTokenExpiresInSec > 0);

      // ---- 9. 音频流转发（P5） ----
      section('[9/9] 音频流转发（Range 透传）');
      const streamUrl: string = resolve.json.streamUrl;

      // 9.1 无凭据必须被拒
      const noAuth = await req('GET', streamUrl.split('?')[0]);
      checkError('无令牌访问流', noAuth, 401, 'unauthorized');

      // 9.2 篡改令牌必须被拒
      const badToken = await req('GET', `${streamUrl.split('?')[0]}?t=9999999999999.deadbeef`);
      checkError('伪造流令牌', badToken, 401, 'unauthorized');

      // 9.3 令牌不能横向复用（换个 trackId 用同一个 t）
      const crossToken = await req(
        'GET',
        `/api/stream/qq_zzzznotexist?t=${new URL(streamUrl, base).searchParams.get('t')}`
      );
      checkError('令牌不能跨曲目复用', crossToken, 401, 'unauthorized');

      // 9.4 Range 请求
      const ranged = await req('GET', streamUrl, {
        headers: { Range: 'bytes=0-1023' },
        binary: true,
      });
      eq('Range 请求返回 206', ranged.status, 206);
      eq('返回恰好 1024 字节', (ranged.json as Buffer).length, 1024);
      const contentRange = ranged.headers.get('content-range') ?? '';
      check('返回 Content-Range', /^bytes 0-1023\/\d+$/.test(contentRange), contentRange);
      eq('声明支持 Range', ranged.headers.get('accept-ranges'), 'bytes');
      const total = Number(contentRange.split('/')[1]);
      check('总长度合理（> 100KB）', total > 100_000, `total=${total}`);
      check('带 Content-Type', !!ranged.headers.get('content-type'), ranged.headers.get('content-type') ?? '');

      // 9.5 全量请求
      const full = await req('GET', streamUrl, { binary: true });
      eq('无 Range 返回 200', full.status, 200);
      eq('声明支持 Range', full.headers.get('accept-ranges'), 'bytes');
      check('全量比 1KB 大得多', (full.json as Buffer).length > 1024 * 100);

      // 9.6 从中段拖动（进度条场景）
      const totalBytes = total;
      const start = Math.floor(totalBytes / 2);
      const seek = await req('GET', streamUrl, {
        headers: { Range: `bytes=${start}-${start + 2047}` },
        binary: true,
      });
      eq('中段拖动返回 206', seek.status, 206);
      eq('拖动返回 2048 字节', (seek.json as Buffer).length, 2048);
      check(
        'Content-Range 起点与请求一致',
        (seek.headers.get('content-range') ?? '').startsWith(`bytes ${start}-${start + 2047}/`),
        seek.headers.get('content-range') ?? ''
      );
      // 2026-09-11 实测教训：缺 Content-Length 时 Chromium 把 seekable 算成空区间，
      // 整条流不可 seek（拖动被静默弹回缓冲区）。206 的 Content-Length 即区间字节数，
      // 必须与实际发送长度一致 —— 用这条断言钉住，防止将来被当冗余删掉。
      check(
        '拖动响应带精确的 Content-Length（Chromium seekable 的前提）',
        seek.headers.get('content-length') === '2048',
        `content-length=${seek.headers.get('content-length') ?? '缺失'}`
      );

      // 9.7 HEAD 请求 —— 唯一用处是问"这文件多大"。
      // 上游对普通 HEAD 回 Content-Length（200），对带 Range 的 HEAD 回 Content-Range（206），
      // 两者都能表达总长度，因此接受任一。**绝不能是 0 或缺失** ——
      // 客户端会据此认为音频是空的，比不返回更糟（这个坑真实存在过）。
      const head = await req('HEAD', streamUrl);
      check('HEAD 返回 200 或 206', [200, 206].includes(head.status), `实际 ${head.status}`);
      const headLen = head.headers.get('content-length') ?? '';
      const headRange = head.headers.get('content-range') ?? '';
      check(
        'HEAD 给出音频总长度（Content-Length 或 Content-Range）',
        (!!headLen && headLen !== '0') || !!headRange,
        `content-length=${headLen || '缺失'} content-range=${headRange || '缺失'}`
      );
      if (headRange) {
        const total = Number(/\/(\d+)\s*$/.exec(headRange)?.[1] ?? 0);
        check('Content-Range 里的总长度为正', total > 100_000, `实际 ${total}`);
      }
      check('HEAD 声明支持 Range', head.headers.get('accept-ranges') === 'bytes', head.headers.get('accept-ranges') ?? '缺失');

      // 9.8 Bearer 也能拉流（程序化调用）
      const viaBearer = await req('GET', '/api/stream/' + encodeURIComponent(histTrackId), {
        token,
        headers: { Range: 'bytes=0-99' },
        binary: true,
      });
      eq('Bearer 令牌也能拉流', viaBearer.status, 206);
      eq('返回 100 字节', (viaBearer.json as Buffer).length, 100);

      // 9.9 失效缓存端点
      const invalidate = await req('POST', `/api/stream/${encodeURIComponent(histTrackId)}/invalidate`, { token });
      eq('失效缓存返回 200', invalidate.status, 200);
      eq('失效后持久缓存已清', getSource(histTrackId) === null, true);
    } else {
      skip('音频流转发', `解析失败：${resolve.json?.reason} ${resolve.json?.message}`);
      note('若是 rejected（B 站风控），配置 SUENMUSIC_BILIBILI_COOKIE 可显著降低触发概率');
    }
  }

  // ---------------------------------------------------------------------
  section('[9b] B 站扫码登录（真实上游：一次二维码请求）');
  // ---------------------------------------------------------------------
  //
  // 只验到"能拿到二维码、二维码里真的是那个登录地址"为止 ——
  // 再往下必须有人拿手机扫，脚本做不到。所以这里不做假绿：
  // 只断言**可验证的那一段**，扫码之后的链路由 api-test 的接口契约覆盖。
  {
    const qr = await req('POST', '/api/bilibili/qrcode', { cookie: adminCookie });
    eq('取二维码返回 200', qr.status, 200);
    check('返回 qrcode_key', typeof qr.json?.qrcodeKey === 'string' && qr.json.qrcodeKey.length > 0);
    check(
      '返回 B 站登录页地址',
      typeof qr.json?.url === 'string' && qr.json.url.includes('bilibili.com'),
      String(qr.json?.url ?? '').slice(0, 70)
    );

    const image = String(qr.json?.qrImage ?? '');
    check(
      '二维码是一张内联 SVG（不依赖任何外部图床）',
      image.startsWith('data:image/svg+xml;base64,'),
      image.slice(0, 40)
    );

    if (image.startsWith('data:image/svg+xml;base64,')) {
      const svg = Buffer.from(image.slice('data:image/svg+xml;base64,'.length), 'base64').toString(
        'utf8'
      );
      // 真实条数取决于 URL 长度与掩码，只卡"确实画了图形"这个下限
      const segments = (svg.match(/M\d+/g) ?? []).length;
      check('二维码 SVG 里画了深色模块', segments > 200, `${segments} 段`);
      check('二维码 SVG 带静默区与白底', svg.includes('fill="#ffffff"'));
    }

    // 轮询一次：没人扫码时必须是 pending，而不是报错或"已登录"
    if (typeof qr.json?.qrcodeKey === 'string') {
      const poll = await req('GET', `/api/bilibili/qrcode/${qr.json.qrcodeKey}`, { cookie: adminCookie });
      eq('轮询返回 200', poll.status, 200);
      eq('没人扫码时状态是 pending', poll.json?.state, 'pending');
      check('轮询结果不带账号信息', poll.json?.account === undefined);

      const after = await req('GET', '/api/bilibili/account', { token });
      eq('poll 不会误把未登录写成已登录', after.json?.configured, false);
    }
  }

  // ---------------------------------------------------------------------
  section('[9b2] 网易云手机号登录（已移除：接口应返回 404）');
  // ---------------------------------------------------------------------
  //
  // 2026-09-11 用户拍板：密码/验证码登录被网易云反作弊与风险判定反复
  // 拦截，登录方式只保留扫码。这里断言旧接口确实不存在了。
  {
    const gone = await req('POST', '/api/netease/login', {
      token,
      body: { phone: '13800138000', password: 'x'.repeat(8) },
    });
    eq('登录接口已移除（404）', gone.status, 404);
    const captchaGone = await req('POST', '/api/netease/captcha', {
      token,
      body: { phone: '13800138000' },
    });
    eq('验证码接口已移除（404）', captchaGone.status, 404);
    eq('库里无遗留密码密文', getSetting('netease.password_cipher'), null);
    eq('库里无遗留手机号', getSetting('netease.phone'), null);
  }

  // ---------------------------------------------------------------------
  section('[9c] 伴奏版过滤（纯逻辑，不打上游）');
  // ---------------------------------------------------------------------
  //
  // 用户实测反馈：原曲与伴奏曲在列表里**显示成同一个名字**。
  // 根因不是显示截断 —— QQ 搜索分片里 `name` 只给主名（"如果爱忘了"），
  // 后缀只在 `title` 里（"如果爱忘了 (伴奏)"），而适配器取的是 name。
  {
    const items = [
      { name: '如果爱忘了', title: '如果爱忘了' },
      { name: '如果爱忘了', title: '如果爱忘了 (伴奏)' },
      { name: '小幸运', title: '小幸运 (KARAOKE版)' },
      { name: '起风了', title: '起风了（伴奏）' },
    ];
    const kept = withoutAccompaniment(items);
    eq('4 首里过滤掉 2 首伴奏', kept.length, 2);
    check(
      '保留原曲与 KARAOKE 版（后者只按伴奏规则不该误杀）',
      kept.map((x: any) => x.title).join('|') === '如果爱忘了|小幸运 (KARAOKE版)',
      kept.map((x: any) => x.title).join('|')
    );
    // ⚠️ 每条用例都要**留一条非伴奏**当"垫底"：
    // 全部被过滤时函数会原样返回（安全阀），期望 0 会反过来失败 ——
    // 上两条用例第一版就是这么写错的。
    eq(
      '半角 (伴奏) 能识别',
      withoutAccompaniment([{ title: 'A (伴奏)' }, { title: 'Z' }]).length,
      1
    );
    eq(
      '全角（伴奏）能识别',
      withoutAccompaniment([{ title: 'B（伴奏）' }, { title: 'Z' }]).length,
      1
    );
    // 老响应可能没有 title，只剩 name —— 那时也得判得出来
    eq(
      '没有 title 时退回 name 也能判',
      withoutAccompaniment([{ name: 'C (伴奏)' }, { name: 'Z' }]).length,
      1
    );
    // ⚠️ 全是伴奏时不能把列表清成空：空态会被误读成版权限制
    eq(
      '全是伴奏时原样返回（不把列表清成空）',
      withoutAccompaniment([{ name: 'D (伴奏)' }]).length,
      1
    );

    // ---- 按 mid 去重 ----
    // 上游确实会返回重复项：用户实测周深《大梦归》同一首出现两次，
    // 客户端就渲染出两行一模一样的歌。
    const dupes = [
      { mid: 'AAA', name: '大梦归' },
      { mid: 'AAA', name: '大梦归' },
      { mid: 'BBB', name: '另一首' },
    ];
    eq('重复 mid 只保留一条', dedupeRawByMid(dupes).length, 2);
    check(
      '保留的是首次出现的那条，顺序不变',
      dedupeRawByMid(dupes).map((x: any) => x.mid).join(',') === 'AAA,BBB'
    );
    // 取不到 mid 的条目不能靠空 key 被误删
    eq(
      '取不到 mid 时原样保留（不靠空 key 误删）',
      dedupeRawByMid([{ name: 'x' }, { name: 'x' }]).length,
      2
    );
    eq('songmid 也算同一首', dedupeRawByMid([{ songmid: 'S1' }, { mid: 'S1' }]).length, 1);

    // ---- 专辑详情的 songInfo 包装（这次真正漏掉的）----
    //
    // `GetAlbumSongList` 每项形如 `{ songInfo: {...}, listenCount }`，
    // 曲目真正的 name/title/mid 全在 songInfo 里。曾经只对**外层**做过滤，
    // 读到的是 undefined → 伴奏判不出来、去重也落空 →
    // 周深《大梦归》显示成两行一模一样的"大梦归"（用户实测报的）。
    const wrapped = [
      { songInfo: { mid: 'M1', name: '大梦归', title: '大梦归' } },
      { songInfo: { mid: 'M2', name: '大梦归', title: '大梦归 (伴奏)' } },
    ];
    eq(
      'songInfo 包装下伴奏也被过滤（只留原曲）',
      adaptQQTracks(wrapped).length,
      1
    );
    check(
      '留下的是原曲那条（mid = M1）',
      adaptQQTracks(wrapped)[0]?.mid === 'M1',
      `实际 ${adaptQQTracks(wrapped)[0]?.mid}`
    );
    // 包装结构下 mid 必须照样读得到 —— 读不到就说明解包又失效了
    check(
      '包装结构下仍读得到 mid（不是哑曲目）',
      adaptQQTracks(wrapped).every(t => Boolean(t.mid)),
      adaptQQTracks(wrapped).map(t => t.mid).join(',')
    );
  }

  // ---- 汇总 ----
  process.stdout.write('\n' + '-'.repeat(60) + '\n');
  if (failed === 0) {
    process.stdout.write(
      `业务 API 验收通过：${passed} 项通过` + (skipped ? `，${skipped} 项跳过。\n` : '，全部通过。\n')
    );
    return skipped > 0 ? 2 : 0;
  }
  process.stdout.write(`业务 API 验收未通过：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过。\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  return 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  process.stderr.write(`验收脚本异常：${(err as Error)?.stack ?? err}\n`);
  code = 1;
} finally {
  // TS 的控制流分析看不到 main() 内的赋值，会把顶层 app 收窄成 null；
  // 断言一次拿回声明的联合类型，否则 close() 会被推断在 never 上。
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
process.exit(code);
