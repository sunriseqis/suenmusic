/**
 * 直连可行性验证：直接跑服务端自己的音源适配器，不经任何 HTTP 服务端接口。
 *
 * 这测的就是「把这套 sources/ 代码原样搬到三端原生层能不能拿到数据」。
 * 环境上不设任何凭据（SUENMUSIC_BILIBILI_COOKIE / NETEASE_COOKIE 全空，
 * 且用全新的临时库，避免读到 app_settings 里的生产凭据）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'direct-verify-'));
process.env.SUENMUSIC_DB = join(tmp, 'probe.db');
process.env.SUENMUSIC_JWT_SECRET = 'probe-only-not-a-real-secret';
delete process.env.SUENMUSIC_BILIBILI_COOKIE;
delete process.env.SUENMUSIC_NETEASE_COOKIE;
delete process.env.SUENMUSIC_AI_BASE_URL;

const { openDatabase, closeDatabase } = await import('../src/db/index.ts');
const { migrate } = await import('../src/db/index.ts');
openDatabase();
migrate();

const { searchQQ } = await import('../src/sources/qq/search.ts');
const { bootstrapNeteaseVendor } = await import('../src/sources/netease/vendor.ts');
const { netease, neteaseRequest } = await import('../src/sources/netease/vendor.ts');
const bili = await import('../src/sources/bilibili/stream.ts');

function line(s = ''): void {
  process.stdout.write(`${s}\n`);
}
function head(t: string): void {
  line();
  line('='.repeat(66));
  line(` ${t}`);
  line('='.repeat(66));
}

line('环境确认：无任何凭据（bilibili.cookie / netease.cookie 均为空）');

// ---------------- 1. QQ音乐 ----------------
head('1. QQ音乐 —— 元数据');
try {
  const r = await searchQQ('周杰伦', { limit: 5 });
  line(`  命中歌曲 ${r.songs.length} 首，专辑 ${r.albums.length}，歌手 ${r.artists.length}`);
  line(`  降级切片：${JSON.stringify(r.degraded)}`);
  const first = r.songs[0];
  if (first) {
    line(`  第一首：${first.name} — ${first.artists?.map((a: any) => a.name).join('/')}`);
    line(`  mid=${first.mid}`);
  }
} catch (e) {
  line(`  ✗ 失败：${e instanceof Error ? e.message : String(e)}`);
}

// ---------------- 2. 网易云 ----------------
head('2. 网易云 —— 元数据（先 vendor bootstrap 拿匿名 token）');
try {
  await bootstrapNeteaseVendor();
  const r = await netease.search({ keywords: '周杰伦', type: 1, limit: 5, offset: 0 }, neteaseRequest);
  const list = r?.body?.song?.list ?? r?.result?.songs ?? [];
  line(`  命中歌曲 ${Array.isArray(list) ? list.length : '未知'} 首`);
  if (Array.isArray(list) && list[0]) {
    line(`  第一首：${list[0].name} — ${(list[0].ar ?? []).map((a: any) => a.name).join('/')}`);
    line(`  id=${list[0].id}`);
  }
} catch (e) {
  line(`  ✗ 失败：${e instanceof Error ? e.message : String(e)}`);
}

// ---------------- 3. B站 ----------------
head('3. B站 —— 元数据 + 播放地址（无 Cookie）');
try {
  const cands = await bili.searchCandidates('周杰伦', ['林俊杰']);
  const arr = Array.isArray(cands) ? cands : [];
  line(`  搜索候选 ${arr.length} 个`);
  if (arr[0]) {
    const c: any = arr[0];
    line(`  第一候选：bvid=${c.bvid} title=${String(c.title ?? '').slice(0, 40)} score=${c.score}`);
    const stream = await bili.getAudioStream(c.bvid);
    if (stream) {
      line(`  ✓ 拿到音频地址：${String(stream.url).slice(0, 110)}`);
      line(`  码率=${stream.bandwidth}  来源=${stream.source}`);
    } else {
      line('  ✗ getAudioStream 返回 null（未登录时的预期表现）');
    }
  }
} catch (e) {
  line(`  ✗ 失败：${e instanceof Error ? e.message : String(e)}`);
}

// ---------------- 4. B站音频 CDN 实取 ----------------
head('4. B站音频 CDN —— 不带 Referer 实取首个字节');
try {
  const cands = await bili.searchCandidates('周杰伦', ['林俊杰']);
  const c: any = Array.isArray(cands) ? cands[0] : null;
  if (c) {
    const s = await bili.getAudioStream(c.bvid);
    if (s?.url) {
      const viaServer = await fetch(s.url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com' },
      });
      line(`  带 Referer：HTTP ${viaServer.status}  type=${viaServer.headers.get('content-type')}`);
      const bare = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      line(`  不带 Referer：HTTP ${bare.status}  type=${bare.headers.get('content-type')}`);
    }
  }
} catch (e) {
  line(`  ✗ 失败：${e instanceof Error ? e.message : String(e)}`);
}

line();
line('探针结束。');
closeDatabase();
process.exit(0);