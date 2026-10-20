/**
 * 数据层验收脚本（P1）。
 *
 * 在**临时库**上跑，绝不碰 data/suenmusic.db，跑完自动删除。
 * 覆盖：迁移幂等、账号、曲目缓存、音源缓存（含负缓存与过期）、
 *       歌单 CRUD 与重排、收藏游标分页、播放历史增量同步。
 *
 * 运行：npm run test:db
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SERVER_ROOT } from '../config.ts';
import { closeDatabase, loadMigrations, migrate, openDatabase } from '../db/index.ts';
import * as users from '../db/repo/users.ts';
import * as tracks from '../db/repo/tracks.ts';
import * as sources from '../db/repo/sources.ts';
import * as playlists from '../db/repo/playlists.ts';
import * as favorites from '../db/repo/favorites.ts';
import * as history from '../db/repo/history.ts';
import * as settings from '../db/repo/settings.ts';
import type { Track } from '../sources/qq/adapter.ts';

// ---------- 迷你断言框架 ----------

let passed = 0;
let failed = 0;
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

/**
 * 断言必定抛错。
 *
 * 可选的 `expected` 用来卡住**错误的类型**。只判断"抛了错"会放过
 * "被另一条更早的校验先拦住"这类假通过 —— 本文件就踩过：断言"重复用户名被拒绝"，
 * 实际上是被口令长度校验拦下的，测试绿着但守的不是那件事。
 */
function throws(
  name: string,
  fn: () => unknown,
  expected?: new (...args: any[]) => Error
): void {
  try {
    fn();
    check(name, false, '没有抛出异常');
  } catch (err) {
    if (!expected) {
      check(name, true);
      return;
    }
    const ok = err instanceof expected;
    check(name, ok, ok ? undefined : `期望 ${expected.name}，实际 ${(err as Error)?.name}`);
  }
}

// ---------- 夹具 ----------

function makeTrack(mid: string, name: string): Track {
  return {
    id: `qq_${mid}`,
    mid,
    name,
    ar: [{ id: `qq_ar_A${mid}`, mid: `A${mid}`, name: '测试歌手', picUrl: '' }],
    artists: [{ id: `qq_ar_A${mid}`, mid: `A${mid}`, name: '测试歌手', picUrl: '' }],
    al: {
      id: `qq_al_B${mid}`,
      mid: `B${mid}`,
      name: '测试专辑',
      picUrl: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000B.jpg',
    },
    album: { id: `qq_al_B${mid}`, name: '测试专辑', picUrl: '' },
    dt: 250_000,
    duration: 250,
    playable: true,
    matched: true,
    privilege: { playMaxbr: 0, maxbr: 0, freeTrialPrivilege: { resConsumable: false } },
  };
}

const tmpDb = join(SERVER_ROOT, 'data', `.dbtest-${randomBytes(4).toString('hex')}.db`);

function cleanup(): void {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(tmpDb + suffix, { force: true });
    } catch {
      // 清理失败不影响验收结论
    }
  }
}

// ---------- 主流程 ----------

function main(): number {
  process.stdout.write('SuenMusic 服务端 —— 数据层验收 (P1)\n');
  process.stdout.write(`临时库：${tmpDb}\n`);

  openDatabase(tmpDb);

  // ---- 1. 迁移 ----
  section('[1/8] 迁移');
  // 断言跟着迁移文件数走，而不是写死数字 ——
  // 否则每加一个迁移都要回来改测试，而那句改动本身不验证任何东西。
  const migrationCount = loadMigrations().length;
  const applied = migrate();
  check(
    `首次迁移应用了全部 ${migrationCount} 个版本`,
    applied === migrationCount,
    `实际 ${applied}`
  );
  const again = migrate();
  eq('重复迁移是幂等的（返回 0）', again, 0);

  const tables = (
    openDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map(r => r.name);
  for (const t of ['users', 'tokens', 'tracks', 'play_sources', 'playlists', 'playlist_items', 'favorites', 'play_history', 'app_settings']) {
    check(`表存在：${t}`, tables.includes(t));
  }
  check('外键已开启', (openDatabase().prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1);

  // ---- 2. 账号 ----
  section('[2/8] 账号');
  const alice = users.createUser({ username: 'alice', password: 'secret-pass-1' });
  check('创建用户返回 id', alice.id > 0);
  eq('对外信息不含口令字段', Object.keys(alice).sort(), ['createdAt', 'displayName', 'id', 'role', 'username']);
  throws(
    '重复用户名被拒绝',
    () => users.createUser({ username: 'alice', password: 'secret-pass-x' }),
    users.UsernameTakenError
  );
  throws(
    '用户名大写变体也算重复（COLLATE NOCASE）',
    () => users.createUser({ username: 'ALICE', password: 'secret-pass-x' }),
    users.UsernameTakenError
  );
  check('正确口令可登录', !!users.authenticate('alice', 'secret-pass-1'));
  check('错误口令被拒绝', users.authenticate('alice', 'wrong') === null);
  check('不存在的用户返回 null', users.authenticate('nobody', 'x') === null);
  throws(
    '非法用户名被拒绝',
    () => users.createUser({ username: 'a b', password: 'secret-pass-x' }),
    users.InvalidUsernameError
  );
  // 口令策略必须由仓储层自己守住：CLI（npm run user:add）绕开 HTTP 直接调它，
  // 校验只写在服务层就会被绕过去
  throws(
    '过短口令被拒绝',
    () => users.createUser({ username: 'weakuser', password: 'x' }),
    users.WeakPasswordError
  );
  throws(
    '过长口令被拒绝',
    () => users.createUser({ username: 'longpw', password: 'a'.repeat(201) }),
    users.WeakPasswordError
  );
  check('用户名规则校验', users.isValidUsername('good_name-1') && !users.isValidUsername('a'));

  const bob = users.createUser({ username: 'bob', password: 'secret-pass-2', displayName: 'Bob' });
  eq('displayName 生效', bob.displayName, 'Bob');
  eq('displayName 缺省回落到用户名', alice.displayName, 'alice');

  // 令牌纪元：改口令必须让它 +1，否则改密前签发的访问令牌仍会通过校验。
  // 单独建一个用户来验，避免扰动 alice 后续的断言。
  const pwUser = users.createUser({ username: 'pwprobe', password: 'probe-pass-1' });
  eq('初始令牌纪元为 1', users.getTokenEpoch(pwUser.id), 1);
  eq('覆写口令成功', users.updatePassword(pwUser.id, 'probe-pass-2'), true);
  eq('改口令后令牌纪元递增', users.getTokenEpoch(pwUser.id), 2);
  check('新口令可登录', !!users.authenticate('pwprobe', 'probe-pass-2'));
  check('旧口令已失效', users.authenticate('pwprobe', 'probe-pass-1') === null);
  throws(
    '覆写口令同样强制长度策略',
    () => users.updatePassword(pwUser.id, 'x'),
    users.WeakPasswordError
  );
  eq('失败的覆写不改变令牌纪元', users.getTokenEpoch(pwUser.id), 2);
  eq('不存在的用户源取纪元返回 0', users.getTokenEpoch(999_999), 0);

  // ---- 3. 曲目缓存 ----
  section('[3/8] 曲目缓存');
  const t1 = makeTrack('001', '第一首');
  const t2 = makeTrack('002', '第二首');
  const t3 = makeTrack('003', '第三首');

  eq('批量写入返回条数', tracks.upsertTracks([t1, t2, t3]), 3);
  eq('无效条目被过滤', tracks.upsertTracks([null, undefined, { ...t1, id: '' }]), 0);
  eq('按 id 取回', tracks.getTrack(t1.id)?.name, '第一首');
  eq('按传入顺序返回多首', tracks.getTracks([t2.id, t1.id]).map(t => t.name), ['第二首', '第一首']);
  eq('缺失的 id 被跳过而非报错', tracks.getTracks([t1.id, 'qq_不存在']).length, 1);
  eq('去重后取回', tracks.getTracks([t1.id, t1.id]).length, 1);

  const renamed = { ...t1, name: '第一首（改名）' };
  tracks.upsertTracks([renamed]);
  eq('upsert 覆盖已有记录', tracks.getTrack(t1.id)?.name, '第一首（改名）');
  eq('总数不因 upsert 增长', tracks.countTracks(), 3);

  // ---- 4. 音源缓存 ----
  section('[4/8] 音源缓存');
  const futureDeadline = Math.floor(Date.now() / 1000) + 1800;
  const okResult = {
    ok: true,
    bvid: 'BV1TEST',
    sourceUrl: `https://example.bilivideo.com/x.m4s?deadline=${futureDeadline}`,
    score: 90,
    matchedTitle: '命中标题',
    matchedAuthor: 'UP',
    durationDiff: 1,
    bandwidth: 204_320,
  };
  sources.saveSource(t1.id, okResult);

  const cached = sources.getSource(t1.id);
  check('成功结果可读回', !!cached);
  eq('bvid 保留', cached?.bvid, 'BV1TEST');
  check(
    '过期时间取自 URL 的 deadline（留 60s 余量）',
    Math.abs((cached?.expiresAt ?? 0) - (futureDeadline * 1000 - 60_000)) < 1000,
    `实际 ${cached?.expiresAt}`
  );
  const restored = sources.rowToResult(cached!);
  eq('行 → ResolveResult 往返一致', [restored.ok, restored.bvid, restored.score], [true, 'BV1TEST', 90]);

  sources.saveSource(t2.id, { ok: false, reason: 'below_threshold', bvid: null, sourceUrl: null, score: 40, message: '分数不足' });
  const neg = sources.getSource(t2.id);
  check('负缓存被落库', !!neg && neg.ok === false);
  eq('负缓存保留失败原因', neg?.reason, 'below_threshold');
  const negResult = sources.rowToResult(neg!);
  eq('负缓存还原后 ok=false', negResult.ok, false);

  // 手动把过期时间改到过去，验证过期即不可见
  openDatabase()
    .prepare('UPDATE play_sources SET expires_at = ? WHERE track_id = ?')
    .run(Date.now() - 1000, t2.id);
  check('过期条目不可读', sources.getSource(t2.id) === null);
  eq('清理过期条目', sources.pruneSources() >= 1, true);

  const counts = sources.countSources();
  eq('统计：总数 1', counts.total, 1);
  eq('统计：成功 1', counts.positive, 1);

  // computeExpiry 无 deadline 时退回固定 TTL
  const noDeadline = sources.computeExpiry('https://example.com/a.m4s');
  check('无 deadline 时退回固定 TTL', noDeadline > Date.now() + 25 * 60 * 1000);

  // ---- 5. 歌单 ----
  section('[5/8] 歌单');
  const pl = playlists.createPlaylist(alice.id, { name: '  我的歌单  ' });
  eq('歌单名被 trim', pl.name, '我的歌单');
  eq('新歌单曲目数为 0', pl.trackCount, 0);
  throws('空歌单名被拒绝', () => playlists.createPlaylist(alice.id, { name: '   ' }));
  throws('超长歌单名被拒绝', () => playlists.createPlaylist(alice.id, { name: 'x'.repeat(65) }));

  const pl2 = playlists.createPlaylist(alice.id, { name: '第二个' });
  eq('歌单列表按创建顺序', playlists.listPlaylists(alice.id).map(p => p.name), ['我的歌单', '第二个']);
  eq('bob 看不到 alice 的歌单', playlists.listPlaylists(bob.id).length, 0);
  check('跨用户取歌单返回 null', playlists.getPlaylist(bob.id, pl.id) === null);
  check('跨用户无权写', !playlists.ownsPlaylist(bob.id, pl.id));

  const added = playlists.addTracks(alice.id, pl.id, [t1.id, t2.id, t3.id]);
  eq('追加 3 首', added.added, 3);
  const dup = playlists.addTracks(alice.id, pl.id, [t1.id, t3.id]);
  eq('重复曲目被跳过', [dup.added, dup.skipped], [0, 2]);
  eq('歌单曲目数', playlists.getPlaylist(alice.id, pl.id)?.trackCount, 3);

  const items = playlists.listPlaylistItems(pl.id);
  eq('曲目顺序与加入顺序一致', items.map(i => i.track?.name), ['第一首（改名）', '第二首', '第三首']);
  check('曲目详情已 JOIN 回来', items[0].track !== null);
  eq('封面回落到首曲封面', playlists.getPlaylist(alice.id, pl.id)?.coverUrl.endsWith('T002R300x300M000B.jpg'), true);

  const reordered = playlists.reorder(alice.id, pl.id, [items[2].id, items[0].id, items[1].id]);
  check('重排成功', reordered);
  eq(
    '重排后顺序正确',
    playlists.listPlaylistItems(pl.id).map(i => i.track?.name),
    ['第三首', '第一首（改名）', '第二首']
  );
  check('重排条目数不符时拒绝', !playlists.reorder(alice.id, pl.id, [items[0].id]));
  check('重排含未知条目时拒绝', !playlists.reorder(alice.id, pl.id, [items[0].id, items[1].id, 999_999]));

  check('按 item 移除', playlists.removeItem(alice.id, pl.id, items[2].id));
  eq('移除后剩 2 首', playlists.listPlaylistItems(pl.id).length, 2);
  eq('按 track_id 移除', playlists.removeTrack(alice.id, pl.id, t2.id), 1);

  const updated = playlists.updatePlaylist(alice.id, pl.id, { name: '改名后', description: '说明' });
  eq('更新歌单', [updated?.name, updated?.description], ['改名后', '说明']);

  eq('删除歌单', playlists.deletePlaylist(alice.id, pl2.id), true);
  eq('删除后仅剩 1 个', playlists.countPlaylists(alice.id), 1);

  // 级联删除
  playlists.createPlaylist(alice.id, { name: '待级联' });
  const cascadeId = playlists.listPlaylists(alice.id).find(p => p.name === '待级联')!.id;
  playlists.addTracks(alice.id, cascadeId, [t1.id]);
  users.createUser({ username: 'temp', password: 'temp-pass-1' });
  const tempUser = users.findUserByUsername('temp')!;
  const tempPl = playlists.createPlaylist(tempUser.id, { name: 'temp 的歌单' });
  playlists.addTracks(tempUser.id, tempPl.id, [t1.id]);
  openDatabase().prepare('DELETE FROM users WHERE id = ?').run(tempUser.id);
  eq('删用户级联删歌单', playlists.countPlaylists(tempUser.id), 0);
  eq(
    '删用户级联删歌单条目',
    openDatabase()
      .prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?')
      .get(tempPl.id) as { n: number },
    { n: 0 }
  );

  // ---- 6. 收藏 ----
  section('[6/8] 收藏');
  eq('首次收藏返回 true', favorites.addFavorite(alice.id, t1.id), true);
  eq('重复收藏返回 false（幂等）', favorites.addFavorite(alice.id, t1.id), false);
  eq('收藏数为 1', favorites.countFavorites(alice.id), 1);

  for (let i = 0; i < 5; i++) {
    const t = makeTrack(`F${i}`, `收藏曲 ${i}`);
    tracks.upsertTracks([t]);
    favorites.addFavorite(alice.id, t.id);
  }
  eq('收藏总数为 6', favorites.countFavorites(alice.id), 6);

  const page1 = favorites.listFavorites(alice.id, { limit: 4 });
  eq('第一页取 4 条', page1.items.length, 4);
  check('第一页有下一页游标', page1.nextCursor !== null);
  const page2 = favorites.listFavorites(alice.id, {
    limit: 4,
    beforeCreatedAt: page1.nextCursor!.createdAt,
    beforeTrackId: page1.nextCursor!.trackId,
  });
  eq('第二页取到剩余 2 条', page2.items.length, 2);
  check('第二页无更多', page2.nextCursor === null);

  const allIds = [...page1.items, ...page2.items].map(i => i.trackId);
  eq('两页拼接无重复', new Set(allIds).size, 6);
  check('曲目详情已 JOIN', page1.items.every(i => i.track !== null));

  check('isFavorite 为真', favorites.isFavorite(alice.id, t1.id));
  eq('取消收藏', favorites.removeFavorite(alice.id, t1.id), true);
  check('取消后 isFavorite 为假', !favorites.isFavorite(alice.id, t1.id));
  eq('取消收藏数为 5', favorites.countFavorites(alice.id), 5);

  // ---- 7. 播放历史 ----
  section('[7/8] 播放历史（增量同步）');
  const base = Date.now() - 60_000;
  for (let i = 0; i < 7; i++) {
    history.recordPlay({
      userId: alice.id,
      trackId: t1.id,
      playedAt: base + i * 1000,
      playedMs: i * 1000,
      durationMs: 250_000,
      completed: i === 6,
      source: i % 2 === 0 ? 'web' : 'android',
      deviceId: 'dev-1',
    });
  }
  for (let i = 0; i < 3; i++) {
    history.recordPlay({
      userId: bob.id,
      trackId: t2.id,
      playedAt: base + i * 1000,
      playedMs: 0,
      durationMs: 250_000,
    });
  }
  eq('alice 历史 7 条', history.countHistory(alice.id), 7);
  eq('bob 历史 3 条（互不干扰）', history.countHistory(bob.id), 3);

  // 分页模拟：模拟客户端只拿 3 条一页，反复续拉直到追平
  let cursor: string | null = null;
  const collected: number[] = [];
  let rounds = 0;
  let cursorFormatOk = true;
  for (;;) {
    const page = history.listHistory(alice.id, { since: cursor, limit: 3 });
    if (page.items.length === 0) break;
    collected.push(...page.items.map(i => i.id));
    cursor = page.nextCursor;
    // 游标就是记录 id（纯数字）。它必须能被 decodeCursor 解析，否则会静默
    // 退化成"每页都从头发" —— 不报错但数据全乱，必须显式守住。
    if (cursor !== null && !/^\d+$/.test(cursor)) cursorFormatOk = false;
    rounds++;
    if (rounds > 10) break; // 防御死循环
  }
  check('游标格式合法（纯记录 id）', cursorFormatOk);
  eq('增量拉取共拿到 7 条', collected.length, 7);
  eq('增量拉取无重复', new Set(collected).size, 7);
  eq('增量拉取顺序单调递增', collected.every((v, i) => i === 0 || v > collected[i - 1]), true);
  eq('分页轮次为 3', rounds, 3);

  const afterCatchUp = history.listHistory(alice.id, { since: cursor });
  eq('追平后返回空', afterCatchUp.items.length, 0);
  eq('追平后游标回显传入值（客户端可继续用它轮询）', afterCatchUp.nextCursor, cursor);

  // 新增一条后，用旧游标应恰好拿到这一条
  const newId = history.recordPlay({ userId: alice.id, trackId: t3.id, playedAt: base + 60_000 });
  const delta = history.listHistory(alice.id, { since: cursor });
  eq('增量恰好 1 条', delta.items.length, 1);
  eq('增量内容正确', delta.items[0].id, newId);

  // 同毫秒多条：游标靠 id 兜底，不会漏
  const sameMs = base + 120_000;
  const ids = [0, 1, 2].map(() =>
    history.recordPlay({ userId: alice.id, trackId: t2.id, playedAt: sameMs })
  );
  const sameMsPage = history.listHistory(alice.id, { since: cursor, limit: 10 });
  eq('同毫秒 3 条都被拉到', sameMsPage.items.filter(i => ids.includes(i.id)).length, 3);

  const recent = history.recentTracks(alice.id, { limit: 10 });
  eq('最近播放去重后为 3 首', recent.length, 3);
  check('最近播放按时间倒序', recent[0].playedAt >= recent[recent.length - 1].playedAt);
  eq('去重后每首只出现一次', new Set(recent.map(r => r.trackId)).size, recent.length);

  const raw = history.recentTracks(alice.id, { limit: 50, dedupe: false });
  eq('不去重时返回全部 11 条', raw.length, 11);

  const progress = history.lastProgress(alice.id, t1.id);
  eq('跨端续播取到最后一次进度', progress?.playedMs, 6000);

  eq('删除单条历史', history.deleteHistoryEntry(alice.id, newId), true);
  eq('删除后剩 10 条', history.countHistory(alice.id), 10);

  const aliceEntryId = history.listHistory(alice.id, { limit: 1 }).items[0].id;
  eq('跨用户删除无效', history.deleteHistoryEntry(bob.id, aliceEntryId), false);
  eq('跨用户删除后 alice 数据未变', history.countHistory(alice.id), 10);

  eq('清空历史', history.clearHistory(alice.id), 10);
  eq('清空后为 0', history.countHistory(alice.id), 0);

  // ---- 8. 应用设置（服务端自己持有的凭证）----
  section('[8/8] 应用设置');
  //
  // 这张表存的是**全站共用**的配置（目前只有一个 B 站 Cookie），
  // 不属于任何用户 —— 所以这里刻意不涉及 user_id。
  eq('空库时读不到任何设置', settings.getSetting('bilibili.cookie'), null);
  eq('空库时计数为 0', settings.countSettings(), 0);

  settings.setSetting('bilibili.cookie', 'SESSDATA=abc123; bili_jct=def');
  eq(
    '写入后能原样读回',
    settings.getSetting('bilibili.cookie'),
    'SESSDATA=abc123; bili_jct=def'
  );
  eq('写入后计数为 1', settings.countSettings(), 1);

  const firstWrite = settings.getSettingRow('bilibili.cookie');
  check('写入会记录时间戳', (firstWrite?.updatedAt ?? 0) > 0);

  // 覆盖写不能变成两行 —— 键值表的经典事故是漏了 ON CONFLICT
  settings.setSetting('bilibili.cookie', 'SESSDATA=xyz789');
  eq('重复写入是覆盖而不是新增一行', settings.countSettings(), 1);
  eq('覆盖后读到新值', settings.getSetting('bilibili.cookie'), 'SESSDATA=xyz789');

  // 空字符串与"不存在"必须是两种状态：前者是"存了一个空值"，
  // 后者是"没存过"。读设置时把两者混为一谈，会让"清空配置"变得无法表达。
  settings.setSetting('empty.one', '');
  eq('空字符串读回来是空串而不是 null', settings.getSetting('empty.one'), '');
  eq('不存在的键才是 null', settings.getSetting('nope.nope'), null);

  settings.deleteSetting('bilibili.cookie');
  eq('删除后读不到', settings.getSetting('bilibili.cookie'), null);
  eq('删除后计数减一', settings.countSettings(), 1);
  settings.deleteSetting('bilibili.cookie');
  eq('重复删除不报错', settings.getSetting('bilibili.cookie'), null);

  // ---- 汇总 ----
  process.stdout.write('\n' + '-'.repeat(60) + '\n');
  if (failed === 0) {
    process.stdout.write(`数据层验收通过：${passed} 项全部通过。\n`);
    return 0;
  }
  process.stdout.write(`数据层验收未通过：${passed} 通过 / ${failed} 失败。\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  return 1;
}

let code = 1;
try {
  code = main();
} catch (err) {
  process.stderr.write(`验收脚本异常：${(err as Error)?.stack ?? err}\n`);
  code = 1;
} finally {
  cleanup();
}
process.exit(code);
