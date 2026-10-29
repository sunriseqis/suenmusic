/**
 * 批 2 · 新歌识别（P0-E/F/G/H）实测脚本。
 *
 * 用法：
 *   node src/scripts/verify-batch3.ts            # 纯函数校验 + 真实库建池（P0-E/F + 新歌识别）
 *   node src/scripts/verify-batch3.ts --sandbox  # 临时库跑 P0-G（detail 失败后补拉）/ P0-H（打标不丢）
 *
 * 只读真实库（建池不写库；sandbox 模式全程在 /tmp 临时库里跑，不碰线上库）。
 */
const sandbox = process.argv.includes('--sandbox');
if (sandbox) {
  const { mkdirSync, rmSync } = await import('node:fs');
  const dir = '/tmp/suenmusic-verify-batch3';
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.SUENMUSIC_DB = dir + '/sandbox.db';
}

const { publishTimeMs, comparePublishTimeDesc, pickNewestReleasedAlbum, latestAlbumSongsOf, buildCandidatePool } =
  await import('../services/ai-recall.ts');
const { saveLibraryTracks } = await import('../db/repo/library.ts');
const { openDatabase, migrate, getDatabase } = await import('../db/index.ts');
const { syncLibraryTrackTags } = await import('../services/ai-tags.ts');

const results: string[] = [];
const check = (name: string, pass: boolean, detail: string): void => {
  results.push((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
};

const NOW = Date.parse('2026-10-29T12:00:00Z');

if (!sandbox) {
  // ---- P0-E：混合格式（epoch 数字串 + ISO + 空串 + '0'）按真实时间戳排序 ----
  const epochNewest = String(Date.UTC(2026, 9, 20)); // 2026-10-20，真·最新
  const mixed = [
    { id: 'i1', mid: 'i1', name: 'ISO 专辑', size: 8, publishTime: '2026-10-01' },
    { id: 'e1', mid: 'e1', name: 'epoch 专辑', size: 8, publishTime: epochNewest },
    { id: 'e2', mid: 'e2', name: 'epoch 秒', size: 8, publishTime: String(Math.floor(Date.UTC(2026, 8, 1) / 1000)) },
    { id: 'z1', mid: 'z1', name: '空串', size: 8, publishTime: '' },
    { id: 'z2', mid: 'z2', name: '占位 0', size: 8, publishTime: '0' },
  ] as any[];
  const oldPick = [...mixed].sort((a, b) => String(b.publishTime ?? '').localeCompare(String(a.publishTime ?? '')))[0];
  const newPick = pickNewestReleasedAlbum(mixed, NOW);
  const order = [...mixed].sort(comparePublishTimeDesc).map(a => a.id);
  check(
    'P0-E 混合格式按真实时间戳选最新',
    newPick?.id === 'e1' && oldPick.id === 'i1',
    '旧(localeCompare)=' + oldPick.id + ' 新=' + newPick?.id + ' 顺序=' + order.join(',')
  );
  check(
    'P0-E NaN（空串/占位 0）排最后',
    order.slice(-2).every(id => id === 'z1' || id === 'z2'),
    '尾部=' + order.slice(-2).join(',')
  );
  check(
    'P0-E 时间戳归一',
    publishTimeMs(mixed[1]) === Date.UTC(2026, 9, 20) &&
      publishTimeMs(mixed[2]) === Date.UTC(2026, 8, 1) &&
      publishTimeMs(mixed[0]) === Date.parse('2026-10-01') &&
      Number.isNaN(publishTimeMs(mixed[3])) &&
      Number.isNaN(publishTimeMs(mixed[4])),
    'ms=' + publishTimeMs(mixed[1]) + ' 秒=' + publishTimeMs(mixed[2])
  );

  // ---- P0-F：未来/预售专辑不进候选 ----
  const future = { id: 'f1', mid: 'f1', name: '预售专辑', size: 8, publishTime: '2027-01-01' };
  const realNew = { id: 'r1', mid: 'r1', name: '真实新专辑', size: 8, publishTime: '2026-10-20' };
  const pickF = pickNewestReleasedAlbum([future, realNew] as any[], NOW);
  check('P0-F 未来专辑被排除、不遮蔽真实新专辑', pickF?.id === 'r1', '选中=' + pickF?.id);
  check('P0-F 只有未来专辑时无候选', pickNewestReleasedAlbum([future] as any[], NOW) === undefined, 'ok');

  // ---- 真实库建池：新歌识别 ----
  const t0 = Date.now();
  const { candidates, counts } = await buildCandidatePool(1);
  const seedNew = candidates.filter(c => c.source === 'seedNew');
  const futureInPool = seedNew.filter(c => {
    const ts = Date.parse(String((c.track.al as { publishTime?: string } | undefined)?.publishTime ?? ''));
    return Number.isFinite(ts) && ts > Date.now();
  });
  console.log('=== 建池（user 1）' + ((Date.now() - t0) / 1000).toFixed(1) + 's · 候选 ' + candidates.length + ' 首 ===');
  console.log('来源分布 ' + JSON.stringify(counts));
  console.log('本尊新歌（seedNew）' + seedNew.length + ' 首：');
  for (const c of seedNew.slice(0, 12)) {
    console.log('  · ' + c.track.name + ' — ' + (c.track.ar ?? [])[0]?.name + ' | 专辑 ' + ((c.track.al as { name?: string } | undefined)?.name ?? '?'));
  }
  check('新歌识别 seedNew 非空（建池侧）', seedNew.length > 0, 'seedNew=' + seedNew.length);
  check('P0-F 建池结果无未来专辑曲目', futureInPool.length === 0, '未来专辑曲目=' + futureInPool.length);
} else {
  // ---- P0-G：detail 失败后下次必须重试（不是判 fresh 跳过）----
  const db = openDatabase(process.env.SUENMUSIC_DB);
  migrate(db);
  const queueCount = (): number =>
    Number((getDatabase().prepare('SELECT COUNT(*) AS c FROM library_build_queue').get() as { c: number }).c);
  const seed = { name: '测试歌手', mid: 'qq_ar_test' };
  let gateCalls = 0;
  let detailFails = true;
  let gateOpen = true;
  const probe = {
    listAlbums: async () => [{ id: 'al1', mid: 'al1', name: '新专辑', size: 8, publishTime: '2026-10-20' }] as any[],
    loadSongs: async () =>
      detailFails ? [] : [{ id: 's1', name: '歌一', ar: [{ name: '测试歌手' }], al: { name: '新专辑' } }] as any[],
    gate: async () => {
      gateCalls += 1;
      return gateOpen;
    },
  };
  await latestAlbumSongsOf(1, seed, 10, probe);
  const q1 = queueCount();
  gateOpen = false;
  const gBefore = gateCalls;
  await latestAlbumSongsOf(1, seed, 10, probe);
  check('P0-G detail 失败后不置 fresh（下次仍检查上游）', gateCalls === gBefore + 1, 'gate ' + gBefore + '→' + gateCalls);
  check('P0-G detail 失败后入队补拉', queueCount() > q1, 'queue ' + q1 + '→' + queueCount());

  gateOpen = true;
  detailFails = false;
  await latestAlbumSongsOf(1, seed, 10, probe);
  const gBefore2 = gateCalls;
  const q2 = queueCount();
  gateOpen = false;
  await latestAlbumSongsOf(1, seed, 10, probe);
  check(
    'P0-G 成功后置 fresh（冷却中不再检查上游、不重复入队）',
    gateCalls === gBefore2 && queueCount() === q2,
    'gate ' + gBefore2 + '→' + gateCalls + ' queue ' + q2 + '→' + queueCount()
  );

  // ---- P0-H：重入库保住 payload_json 里的 styles/language ----
  const t1 = { id: 'kg_t1', name: '测试曲目', ar: [{ name: '测试歌手' }], al: { name: '专辑甲' }, duration: 200 } as any;
  saveLibraryTracks('qq_ar_test', [t1]);
  syncLibraryTrackTags(50);
  const readPayload = (id: string): any =>
    JSON.parse((getDatabase().prepare('SELECT payload_json FROM library_tracks WHERE id = ?').get(id) as { payload_json: string }).payload_json);
  const tagged = readPayload('kg_t1');
  saveLibraryTracks('qq_ar_test', [{ ...t1, name: '测试曲目（Remastered）', al: { name: '专辑甲（新版）' }, duration: 201 }]);
  const after = readPayload('kg_t1');
  check(
    'P0-H 重入库保留 styles/language',
    JSON.stringify(tagged.styles) === JSON.stringify(after.styles) &&
      tagged.language === after.language &&
      (tagged.styles ?? []).length > 0,
    '打标后=' + JSON.stringify({ styles: tagged.styles, language: tagged.language }) + ' 重入库后=' + JSON.stringify({ styles: after.styles, language: after.language })
  );
  check(
    'P0-H 其余字段照旧覆盖',
    after.name === '测试曲目（Remastered）' && after.al?.name === '专辑甲（新版）' && after.duration === 201,
    'name=' + after.name + ' al=' + after.al?.name + ' dur=' + after.duration
  );
  getDatabase().prepare('UPDATE library_tracks SET payload_json = ? WHERE id = ?').run(JSON.stringify({ ...t1, name: '测试曲目（Remastered）' }), 'kg_t1');
  check('P0-H 对照：旧裸覆盖会丢标（证明该用例能抓到 bug）', readPayload('kg_t1').styles === undefined, 'ok');
}

console.log(results.join('\n'));
console.log('SUMMARY ' + results.filter(r => r.startsWith('PASS')).length + '/' + results.length + ' passed');
process.exit(results.every(r => r.startsWith('PASS')) ? 0 : 1);
