/**
 * lyric.ts 的单元断言（纯逻辑，不打上游、不起服务）。
 *
 * 运行：npm run test:unit（web/ 下）
 * 惯例与服务端验收脚本一致：check/eq 两个原语，FAIL 全列出来再退出。
 */

import { parseLrc, parseLyrics, activeLineIndex } from '../src/utils/lyric.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

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

process.stdout.write('\n[1] 基础解析\n');
{
  const lines = parseLrc('[00:01.50]hello\n[00:05]world\n[01:02.345]third');
  eq('三行全部解析', lines.length, 3);
  eq('厘秒换算成毫秒（.50 → 1500）', lines[0]!.time, 1500);
  eq('无小数部分的时间戳（05 → 5000）', lines[1]!.time, 5000);
  eq('三位毫秒原样（2.345 → 62345）', lines[2]!.time, 62345);
  eq('行文本保持干净', lines[1]!.text, 'world');
  eq('按时间升序', lines.map(l => l.time).every((t, i, a) => i === 0 || t > a[i - 1]!), true);
}

process.stdout.write('\n[2] 多时间戳行与乱序\n');
{
  const lines = parseLrc('[00:20.00]chorus\n[00:10.00]verse\n[00:30.00][01:00.00]chorus again');
  eq('一行两个时间戳展开成两行', lines.length, 4);
  eq('同时间戳保持出现顺序', lines[0]!.text, 'verse');
  eq('重复副歌第二份在 60s', lines[3]!.time, 60000);
}

process.stdout.write('\n[3] 元数据与 offset\n');
{
  const { lines, meta } = parseLyrics(
    '[ti:晴天]\n[ar:周杰伦]\n[offset:500]\n[00:10.00]story\n[00:20.00]小黄'
  );
  eq('offset 正值让歌词提前（10s → 9.5s）', lines[0]!.time, 9500);
  check('元数据进了 meta 且不是歌词行', meta.length === 2 && lines.every(l => !l.text.includes('晴天')), meta.join('|'));
  check('offset 只影响时间不影响文本', lines[0]!.text === 'story');

  const { lines: neg } = parseLyrics('[offset:-2000]\n[00:05.00]x');
  eq('offset 负值推后（5s → 7s）', neg[0]!.time, 7000);
  const { lines: clamped } = parseLyrics('[offset:99999]\n[00:05.00]x');
  eq('offset 把时间推到负数时钳到 0', clamped[0]!.time, 0);
}

process.stdout.write('\n[4] 翻译对齐\n');
{
  const { lines } = parseLyrics(
    '[00:10.00]靠近你怎么突然就没声了\n[00:20.00]霞光淡去',
    '[00:10.00]Nearing you, suddenly silent\n[00:20.001]Sunset fades'
  );
  eq('原行对上翻译（完全同时间戳）', lines[0]!.trans, 'Nearing you, suddenly silent');
  eq('容差内（±1ms 抖动）也对上', lines[1]!.trans, 'Sunset fades');

  const { lines: far } = parseLyrics('[00:10.00]a', '[00:11.00]b');
  eq('超出容差的翻译不对齐', far[0]!.trans, undefined);

  // 翻译比原文多：每条翻译只消费一次，不重复挂
  const { lines: one2many } = parseLyrics(
    '[00:10.00]a\n[00:20.00]b',
    '[00:10.000]x\n[00:10.005]x2\n[00:20.000]y'
  );
  eq('第一条原文挂最近的翻译', one2many[0]!.trans, 'x');
  eq('被消费过的翻译不再复用（第二条挂 y）', one2many[1]!.trans, 'y');
}

process.stdout.write('\n[5] 空与异常输入\n');
{
  eq('空歌词解析为空', parseLrc('').length, 0);
  const { lines, meta } = parseLyrics('', '');
  eq('空输入 lines 空', lines.length, 0);
  eq('空输入 meta 空', meta.length, 0);

  const { lines: junk } = parseLyrics('这不是歌词\n[00:01.00]real line');
  eq('无时间戳散行不算歌词行', junk.length, 1);
  eq('散行进了 meta（可兜底展示）', parseLyrics('这不是歌词').meta[0], '这不是歌词');

  const bad = parseLrc('[75:99.00]impossible\n[00:01.00]ok');
  eq('非法时间戳（秒 ≥ 60）的行不进歌词行', bad.length, 1);
  eq('保留下的是合法行', bad[0]!.text, 'ok');
  eq('非法行落到 meta（不悄悄丢内容）', parseLyrics('[75:99.00]impossible').meta[0], '[75:99.00]impossible');
}

process.stdout.write('\n[6] 当前行计算（activeLineIndex）\n');
{
  const lines = parseLrc('[00:10.00]a\n[00:20.00]b\n[00:30.00]c');
  eq('还没唱到第一行 → -1', activeLineIndex(lines, 9_999), -1);
  eq('正好在行起点 → 该行', activeLineIndex(lines, 10_000), 0);
  eq('行中间 → 该行', activeLineIndex(lines, 15_000), 0);
  eq('刚过下一行起点 → 下一行', activeLineIndex(lines, 20_001), 1);
  eq('播到最后 → 最后一行', activeLineIndex(lines, 999_999), 2);
  eq('空歌词 → -1', activeLineIndex([], 10_000), -1);
}

process.stdout.write('\n[7] // 占位符与换行符格式化\n');
{
  const lrc = '[00:01.00]//\n[00:05.00]第一句 // 第二句\n[00:10.00]尾部斜杠 //\n[00:15.00]// 头部斜杠';
  const tlyric = '[00:01.00]//\n[00:05.00]Line 1 // Line 2\n[00:10.00]//\n[00:15.00]Translated';
  const { lines } = parseLyrics(lrc, tlyric);
  eq('纯 // 占位行被过滤（4 行剩 3 行）', lines.length, 3);
  eq('行内 // 被格式化为换行符', lines[0]!.text, '第一句\n第二句');
  eq('翻译行内 // 被格式化为换行符', lines[0]!.trans, 'Line 1\nLine 2');
  eq('尾部 // 被清理', lines[1]!.text, '尾部斜杠');
  eq('纯 // 翻译占位不作为有效翻译挂载', lines[1]!.trans, undefined);
  eq('头部 // 被清理', lines[2]!.text, '头部斜杠');
  eq('正常翻译正确对齐', lines[2]!.trans, 'Translated');
}

process.stdout.write('\n------------------------------------------------------------\n');
if (failed > 0) {
  process.stdout.write(`单元断言失败：${passed} 项通过，${failed} 项失败\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write(`单元断言通过：${passed} 项全部通过。\n`);
