/**
 * 翻奏 / 钢琴 / 纯音乐判定的单元测试（无数据库、无网络，纯函数）。
 *
 * 重点不是"命中多少关键词"，而是**不误杀原曲**：
 *   - 伍思凯《爱的钢琴手》：曲名和专辑都带「钢琴」，但那是原唱，必须为 false；
 *   - NCT DREAM《八音盒 (Life Is Still Going On)》：曲名带「八音盒」，同样是原曲；
 *   - 「Recovered」这类拉丁词不能被 \bcover\b 当成 cover 版本。
 *
 * 运行：npm run test:content-filter
 */
import { isCoverOrInstrumental, hasCoverKeyword, type CoverProbe } from '../services/content-filter.ts';

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

/** 造一条最小可判定的曲目（字段形状与 QQ Track 一致） */
function track(name: string, artist: string, album: string) {
  return {
    name,
    ar: [{ name: artist }],
    artists: [{ name: artist }],
    al: { name: album },
    album: { name: album },
  };
}

function isCover(label: string, t: CoverProbe): void {
  check(`${label} → 判为翻奏/纯音乐`, isCoverOrInstrumental(t) === true);
}

function isOriginal(label: string, t: CoverProbe): void {
  check(`${label} → 判为原曲`, isCoverOrInstrumental(t) === false);
}

function main(): number {
  process.stdout.write('SuenMusic 服务端 —— 翻奏/纯音乐判定单测\n');

  section('1) 专辑/歌手命中：钢琴翻奏应当为 true');
  // 实测样本：每日推荐里真实漏进来的条目
  isCover('心雨 | 赵海洋 | 夜色钢琴曲', track('心雨', '赵海洋', '夜色钢琴曲'));
  isCover('涟漪 | Lawrence | 谱普钢琴集', track('涟漪', 'Lawrence', '谱普钢琴集'));
  isCover('听海 | 王崴 | 玫瑰钢琴', track('听海', '王崴', '玫瑰钢琴'));
  isCover('对不起我爱你 | 陈冠宇 | 陈冠宇钢琴演奏专辑', track('对不起, 我爱你', '陈冠宇', '陈冠宇钢琴演奏专辑-对不起,我爱你'));
  isCover('歌手名带「钢琴」', track('练习', '姜创钢琴', '流行改编作品集'));
  isCover('歌手名就是「纯音乐」', track('告白气球', '纯音乐', '抖音热门'));
  isCover('英文专辑 Piano Covers', track('Hello', 'Someone', 'Piano Covers Vol.2'));
  isCover('专辑含 instrumental', track('Hello', 'Someone', 'Instrumental Hits'));
  isCover('专辑含 cover（词边界）', track('Hello', 'Someone', 'Top Cover Collection'));

  section('2) 同名专辑不算证据：伍思凯《爱的钢琴手》是原曲');
  // 专辑名 == 曲名时，「钢琴」来自原曲标题本身，不构成翻奏证据
  isOriginal('爱的钢琴手 | 伍思凯 | 爱的钢琴手', track('爱的钢琴手', '伍思凯', '爱的钢琴手'));
  isOriginal('八音盒 (Life Is Still Going On) | NCT DREAM', track('八音盒 (Life Is Still Going On)', 'NCT DREAM', 'Hello Future - The 1st Album Repackage'));

  section('3) 仅曲名命中：需要第二份证据');
  isCover('曲名含「纯音乐」', track('纯音乐 - 夜的钢琴曲', '未知', '合集'));
  isCover('曲名含「伴奏」', track('等到明天以后伴奏', '叶炫清', '单曲'));
  isCover('曲名含「演奏版」', track('晴天 (钢琴演奏版)', '周杰伦', '单曲'));

  section('4) 正常原曲不得误杀');
  isOriginal('一路向北 | 周杰伦 | 十一月的萧邦', track('一路向北', '周杰伦', '十一月的萧邦'));
  isOriginal('富士山下 | 陈奕迅 | What\'s Going On...?', track('富士山下', '陈奕迅', "What's Going On...?"));
  isOriginal('曲名含「改编」但只有弱证据', track('吹灭小山河 (网友改编)', '宇宙潦草小狗', '下一首单曲循环'));
  isOriginal('英文单词 Recovered 不是 cover', track('Recovered', 'Artist', 'Recovered'));
  isOriginal('空元数据不判脏', { name: '', ar: [], al: { name: '' } });

  section('5) 拉丁关键词词边界（hasCoverKeyword，直接测底层）');
  check('Piano 命中', hasCoverKeyword('Piano Version') === true);
  check('钢琴Piano 相邻也命中（中文非 \\w，边界成立）', hasCoverKeyword('钢琴Piano') === true);
  check('Recovered 不命中', hasCoverKeyword('Recovered') === false);
  check('Pianola 不命中（非独立单词）', hasCoverKeyword('Pianola') === false);
  check('空串不命中', hasCoverKeyword('') === false);

  section('6) 结构兼容：只给 artists 别名、只给 album 别名也要能判');
  check(
    'artists/album 别名可用',
    isCoverOrInstrumental({ name: '心雨', artists: [{ name: '赵海洋' }], album: { name: '夜色钢琴曲' } }) === true
  );

  process.stdout.write('\n' + '-'.repeat(60) + '\n');
  if (failed === 0) {
    process.stdout.write(`翻奏/纯音乐判定单测通过：${passed} 项全部通过。\n`);
    return 0;
  }
  process.stdout.write(`翻奏/纯音乐判定单测未通过：${passed} 通过 / ${failed} 失败。\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  return 1;
}

process.exit(main());
