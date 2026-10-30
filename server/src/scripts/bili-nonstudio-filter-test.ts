/**
 * B 站候选「非录音室版本」过滤的单元测试（无数据库、无网络，纯函数）。
 *
 * 重点有两面：
 *   · **该拦的拦住**：直拍 / 饭拍 / 打歌舞台 / 现场 / 演唱会 / 音乐节 / 直播 ——
 *     这类视频标题几乎总带标记，且 40+25+15−20 仍能过阈值（软惩罚挡不住）。
 *   · **不该拦的一个都不许拦**：Alive / Deliver / Lively / Concerted 这类正常标题
 *     不能被 live / concert 的子串误杀；原曲自身是现场版时整池都不许过滤。
 *
 * 运行：npm run test:bili-filter
 */
import { filterStudioCandidates, isNonStudioTitle } from '../sources/bilibili/matcher.ts';

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

function blocked(title: string): void {
  check(`拦下：${title}`, isNonStudioTitle(title) === true);
}

function kept(title: string): void {
  check(`放行：${title || '(空标题)'}`, isNonStudioTitle(title) === false);
}

function titles(list: ReadonlyArray<{ title: string }>): string[] {
  return list.map(c => c.title);
}

function main(): number {
  section('1) 直拍 / 饭拍 / 打歌舞台（原 LIVE_KEYWORDS 完全没覆盖的那批）');
  blocked('【4K直拍】周杰伦《晴天》前排视角');
  blocked('晴天 饭拍 无修音');
  blocked('打歌舞台 4K 60帧');
  blocked('直拍合集');

  section('2) 现场 / 演唱会 / 音乐节 / 直播');
  blocked('晴天 演唱会版');
  blocked('周杰伦 音乐节 压轴 晴天');
  blocked('2024 跨年晚会 晴天');
  blocked('直播回放 完整版');
  blocked('巡演 返场 晴天');

  section('3) 拉丁词按词边界（live / fancam / concert / livehouse）');
  blocked('LIVE at Budokan');
  blocked('Fancam 4K 竖屏');
  blocked('Concert Highlights 2024');
  blocked('Livehouse 现场收音');

  section('4) 正常录音室标题必须放行（子串误杀防线）');
  kept('周杰伦 - 晴天 【官方MV】');
  kept('晴天 无损音质 高音质');
  kept('一路向北 完整版 4K修复');
  kept('Alive');
  kept('Deliver');
  kept('Lively 版本');
  kept('Concerted effort');
  kept('官方音源 未删减');
  kept('');

  section('5) 整池过滤：只留录音室版本');
  const pool = [
    { title: '【官方MV】晴天 - 周杰伦' },
    { title: '【4K直拍】晴天 前排' },
    { title: '晴天 演唱会版' },
    { title: '晴天 无损音质' },
  ];
  check(
    '原曲非现场版：直拍/演唱会版被滤掉',
    JSON.stringify(titles(filterStudioCandidates('晴天', pool))) ===
      JSON.stringify(['【官方MV】晴天 - 周杰伦', '晴天 无损音质'])
  );
  check(
    '原曲自身是现场版：整池原样返回（不许自我否决）',
    filterStudioCandidates('晴天 (Live)', pool).length === pool.length
  );
  check(
    '全被筛掉是合法结果（返回空，不做兜底回填）',
    filterStudioCandidates('晴天', [
      { title: '晴天 直拍' },
      { title: '晴天 现场版' },
    ]).length === 0
  );
  check(
    '入参不被就地修改（返回新数组）',
    filterStudioCandidates('晴天', pool) !== pool
  );
  check('空候选池返回空', filterStudioCandidates('晴天', []).length === 0);

  process.stdout.write('\n' + '-'.repeat(60) + '\n');
  if (failed === 0) {
    process.stdout.write(`B 站非录音室版本过滤单测通过：${passed} 项全部通过。\n`);
    return 0;
  }
  process.stdout.write(`B 站非录音室版本过滤单测未通过：${passed} 通过 / ${failed} 失败。\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  return 1;
}

process.exit(main());
