/**
 * 核心链路验证脚本。
 *
 * 不启动任何 HTTP 服务，直接调模块 —— 目的是证明
 * 「QQ 元数据 -> B 站候选打分 -> 熔断 -> 取流 -> Range 可用」
 * 这条链路在 Node 环境里能独立站住。这条不通，包再漂亮的 API 也没有意义。
 *
 * 运行：npm run verify -- "笨蛋 陈奕迅"
 */

import { config, SERVER_ROOT } from '../config.ts';
import { logger, setLogLevel } from '../logger.ts';
import { fetchAudioStream, resolveTrackSource } from '../sources/bilibili/stream.ts';
import { searchQQ } from '../sources/qq/search.ts';

const log = logger.child('verify');

function line(text = ''): void {
  process.stdout.write(text + '\n');
}

function step(n: number, total: number, title: string): void {
  line('');
  line(`[${n}/${total}] ${title}`);
}

function ok(text: string): void {
  line(`       OK   ${text}`);
}

function bad(text: string): void {
  line(`       FAIL ${text}`);
}

function info(text: string): void {
  line(`            ${text}`);
}

async function main(): Promise<number> {
  setLogLevel(config.logLevel);

  const keyword = process.argv[2] || '笨蛋 陈奕迅';
  const TOTAL = 4;
  let failed = 0;

  line('SuenMusic 服务端 —— 核心链路验证');
  line(`配置：db=${config.dbPath.replace(SERVER_ROOT, '.')}  阈值=${config.matchThreshold}  ` +
    `B 站 Cookie=${config.bilibiliCookie ? '已配置' : '未配置'}`);

  // ---- 1. QQ 搜索 ----
  step(1, TOTAL, `QQ 搜索 "${keyword}"`);
  const search = await searchQQ(keyword, {
    limit: 10,
    slices: ['song', 'singer', 'album', 'songlist'],
  });

  info(`songs=${search.songs.length} singers=${search.artists.length} ` +
    `albums=${search.albums.length} playlists=${search.playlists.length}`);

  if (search.degraded.slices.length) {
    bad(`分片被上游拒绝：${search.degraded.slices.join(',')} (code=${search.degraded.code})`);
    if (search.degraded.code === 2001) {
      info('这是 QQ 的瞬时限流，暂停约 1 分钟自行恢复，不是代码问题');
    }
    failed++;
  }

  const track = search.songs[0];
  if (!track) {
    bad('没有拿到任何单曲，后续步骤无法继续');
    return 1;
  }
  ok(`${track.name} / ${track.ar.map(a => a.name).join('、')} / ${track.duration}s`);
  info(`id=${track.id}  专辑=${track.al.name}  专辑路由键=${track.al.id}`);

  // ---- 2. B 站候选匹配 ----
  step(2, TOTAL, 'B 站候选检索与置信度打分');
  const resolve = await resolveTrackSource({
    id: track.id,
    name: track.name,
    artists: track.ar.map(a => a.name),
    durationMs: track.dt,
  });

  if (!resolve.ok) {
    bad(`匹配失败：reason=${resolve.reason}  ${resolve.message ?? ''}`);
    if (resolve.reason === 'rejected') {
      info('需要在 server/.env 里配置 SUENMUSIC_BILIBILI_COOKIE');
    }
    if (resolve.topCandidates?.length) {
      info('候选榜（前 5）：');
      for (const c of resolve.topCandidates) {
        info(`  ${String(c.score).padStart(5)} 分  ${c.durationSec}s  ${c.title}`);
      }
    }
    return 1;
  }

  ok(`bvid=${resolve.bvid}  置信度=${resolve.score}`);
  info(`命中：${resolve.matchedTitle}`);
  info(`UP 主：${resolve.matchedAuthor}  时长差=${resolve.durationDiff}s`);
  if (resolve.topCandidates && resolve.topCandidates.length > 1) {
    info('候选榜：');
    for (const c of resolve.topCandidates) {
      info(`  ${String(c.score).padStart(5)} 分  ${c.bvid}  ${c.title}`);
    }
  }

  // ---- 3. 取流 ----
  step(3, TOTAL, '取音频流地址');
  const sourceUrl = resolve.sourceUrl;
  if (!sourceUrl) {
    bad('没有拿到音频地址');
    return 1;
  }
  const streamType = resolve.fallbackStream ? 'durl 兜底' : 'DASH';
  ok(`${streamType}  码率=${resolve.bandwidth}  ${sourceUrl.slice(0, 72)}...`);

  // ---- 4. Range 探测 ----
  // 播放器拖进度条靠 Range，不透传就只能从头下完，所以这一步必须验。
  step(4, TOTAL, 'Range 请求探测（进度条拖动依赖它）');
  try {
    const res = await fetchAudioStream(sourceUrl, 'bytes=0-1023');
    if (res.status === 206) {
      const buf = Buffer.from(await res.arrayBuffer());
      ok(`HTTP 206  ${buf.length} 字节  content-range=${res.headers.get('content-range')}`);
    } else if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      ok(`HTTP ${res.status}  ${buf.length} 字节（未返回 206，拖进度条可能受限）`);
    } else {
      bad(`HTTP ${res.status} ${res.statusText}`);
      failed++;
    }
  } catch (err) {
    bad(`请求音频失败：${(err as Error)?.message ?? err}`);
    failed++;
  }

  line('');
  if (failed === 0) {
    line('结论：核心链路在服务端可用。');
    return 0;
  }
  line(`结论：有 ${failed} 项未通过。`);
  return 1;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    log.error(`验证脚本异常：${(err as Error)?.stack ?? err}`);
    process.exit(1);
  });
