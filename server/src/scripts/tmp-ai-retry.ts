/** 临时验收脚本（验收完即删）：复核退避重试 5s → 20s 的真实间隔。 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { setSetting } from '../db/repo/settings.ts';
import { reviewPicks } from '../services/ai-review.ts';

const tmpDb = join(tmpdir(), `suenmusic-retry-${process.pid}-${Date.now()}.db`);
openDatabase(tmpDb);
migrate();

let hits = 0;
const stamps: number[] = [];
const server = createServer((req, res) => {
  hits += 1;
  stamps.push(Date.now());
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    if (hits <= 4) {
      // 前 4 次一律 429：ai-client 内部各重试一次，于是外层拿到 ratelimit 后走 5s/20s 退避
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"reject":[]}' }, finish_reason: 'stop' }],
        usage: { total_tokens: 1 },
      })
    );
  });
});

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

setSetting(
  'ai.models.config',
  JSON.stringify({
    profiles: [
      { id: 'p1', name: 'tmp', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' },
    ],
    decideProfileId: 'p1',
    reviewProfileId: 'p1',
  })
);

const startedAt = Date.now();
const outcome = await reviewPicks(
  [{ id: 'qq_a', name: '歌A', artist: '人A', source: 'seedNew', listNo: 1, reason: '理由' }],
  { lines: [] }
);
const elapsed = Date.now() - startedAt;

const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
process.stdout.write(
  `\n结果：${JSON.stringify({ status: outcome.status, rejects: outcome.status === 'ok' ? outcome.rejects.size : null, hits, elapsedMs: elapsed, gapsMs: gaps })}\n`
);

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (!cond) failures += 1;
  process.stdout.write(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}\n`);
};
check("5 次调用后成功 → status='ok'", outcome.status === 'ok');
check('打回 0 首', outcome.status === 'ok' && outcome.rejects.size === 0);
check('共 5 次请求（1 次内部重试 + 2 轮退避）', hits === 5, `hits=${hits}`);
// gaps: [内部重试, 5s 退避, 内部重试, 20s 退避]
check('退避 1 ≈ 5s', Math.abs((gaps[1] ?? 0) - 5000) < 1200, `gaps=${JSON.stringify(gaps)}`);
check('退避 2 ≈ 20s', Math.abs((gaps[3] ?? 0) - 20000) < 1500, `gaps=${JSON.stringify(gaps)}`);
check('总耗时 ≥ 25s', elapsed >= 25000, `elapsed=${elapsed}ms`);

server.close();
closeDatabase();
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(tmpDb + suffix, { force: true });
  } catch {
    /* ignore */
  }
}
process.stdout.write(`\nEXIT=${failures === 0 ? 0 : 1}\n`);
process.exit(failures === 0 ? 0 : 1);
