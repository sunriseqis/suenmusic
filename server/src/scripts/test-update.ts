import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { versionCodeOf, cacheDir } from '../services/github-update.ts';
import { compareVersionName } from '../services/update-types.ts';
import { signUpdateToken, verifyUpdateToken } from '../utils/update-token.ts';
import { buildApp } from '../app.ts';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { SERVER_ROOT } from '../config.ts';
import { createUser } from '../db/repo/users.ts';
import { login } from '../services/auth.ts';

console.log('Testing Update Channel...');

// 1. 版本号算法测试
assert.strictEqual(versionCodeOf('2.0.0'), 2000000);
assert.strictEqual(versionCodeOf('1.5.0'), 1050000);
assert.strictEqual(versionCodeOf('2.1.3'), 2010300);

// 2. 版本号比对测试
assert.strictEqual(compareVersionName('2.0.0', '1.5.0'), 1);
assert.strictEqual(compareVersionName('2.0.0', '2.0.0'), 0);
assert.strictEqual(compareVersionName('1.5.0', '2.0.0'), -1);

// 3. 短期 Token 签发与验证测试（双端下载）
for (const p of ['harmony', 'ios'] as const) {
  const token = signUpdateToken(p);
  assert(token.length > 0, `${p} token should not be empty`);
  assert.strictEqual(verifyUpdateToken(p, token), true, `${p} token should be valid`);
  assert.strictEqual(verifyUpdateToken(p === 'harmony' ? 'ios' : 'harmony', token), false, 'token should not cross-validate other platforms');
}

// 4. 双端 HTTP 接口测试
const testDb = join(SERVER_ROOT, `data/.test-update-${randomBytes(4).toString('hex')}.db`);
openDatabase(testDb);
migrate();

const user = createUser({ username: 'testuser', password: 'Password123!', displayName: 'Tester' });
const session = login({ username: 'testuser', password: 'Password123!', throttleKey: '127.0.0.1' });
const authHeader = { authorization: `Bearer ${session.accessToken}` };

const app = buildApp();
await app.ready();

// 模拟本地已缓存 2.0.0 产物
for (const p of ['harmony', 'ios'] as const) {
  const ext = p === 'harmony' ? 'hap' : 'ipa';
  const dir = cacheDir(p);
  mkdirSync(dir, { recursive: true });
  const fileName = `suenmusic-2.0.0.${ext}`;
  const filePath = join(dir, fileName);
  writeFileSync(filePath, `fake-${p}-binary-content-1234567890`);
  const meta = {
    fileName,
    path: filePath,
    versionName: '2.0.0',
    versionCode: 2000000,
    size: 32,
    sha256: null,
  };
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(meta));
}

// 测试 4.1：鸿蒙端老版本检查更新 (1.0.0 -> 有可用更新)
const hwRes1 = await app.inject({
  method: 'GET',
  url: '/api/update/check?platform=harmony&version_name=1.0.0&version_code=1000000',
  headers: authHeader,
});
assert.strictEqual(hwRes1.statusCode, 200);
const hwData1 = JSON.parse(hwRes1.payload);
assert.strictEqual(hwData1.available, true);
assert.strictEqual(hwData1.latest.versionName, '2.0.0');
assert.strictEqual(hwData1.latest.versionCode, 2000000);
assert(hwData1.downloadToken.length > 0);

// 测试 4.2：鸿蒙端最新版本检查更新 (2.0.0 -> 已是最新)
const hwRes2 = await app.inject({
  method: 'GET',
  url: '/api/update/check?platform=harmony&version_name=2.0.0&version_code=2000000',
  headers: authHeader,
});
assert.strictEqual(hwRes2.statusCode, 200);
const hwData2 = JSON.parse(hwRes2.payload);
assert.strictEqual(hwData2.available, false);

// 测试 4.3：iOS端老版本检查更新 (1.0.0 -> 有可用更新)
const iosRes1 = await app.inject({
  method: 'GET',
  url: '/api/update/check?platform=ios&version_name=1.0.0&version_code=1000000',
  headers: authHeader,
});
assert.strictEqual(iosRes1.statusCode, 200);
const iosData1 = JSON.parse(iosRes1.payload);
assert.strictEqual(iosData1.available, true);
assert.strictEqual(iosData1.latest.versionName, '2.0.0');
assert.strictEqual(iosData1.latest.versionCode, 2000000);
assert(iosData1.downloadToken.length > 0);

// 测试 4.4：iOS端最新版本检查更新 (2.0.0 -> 已是最新)
const iosRes2 = await app.inject({
  method: 'GET',
  url: '/api/update/check?platform=ios&version_name=2.0.0&version_code=2000000',
  headers: authHeader,
});
assert.strictEqual(iosRes2.statusCode, 200);
const iosData2 = JSON.parse(iosRes2.payload);
assert.strictEqual(iosData2.available, false);

// 测试 4.5：双端通过短期 token 下载（模拟浏览器或侧载工具直接发起，不需要 Authorization 头）
for (const p of ['harmony', 'ios'] as const) {
  const token = signUpdateToken(p);
  const dlRes = await app.inject({
    method: 'GET',
    url: `/api/update/download?platform=${p}&token=${token}`,
  });
  assert.strictEqual(dlRes.statusCode, 200);
  assert(dlRes.payload.startsWith(`fake-${p}-binary`));
}

// 测试 4.6：下载 Range 断点续传测试 (206 Partial Content)
const token = signUpdateToken('harmony');
const rangeRes = await app.inject({
  method: 'GET',
  url: `/api/update/download?platform=harmony&token=${token}`,
  headers: {
    range: 'bytes=0-5',
  },
});
assert.strictEqual(rangeRes.statusCode, 206);
assert.strictEqual(rangeRes.payload, 'fake-h');

// 清理测试临时库
await app.close();
closeDatabase();
rmSync(testDb, { force: true });

console.log('✔ All update core assertions and dual-platform HTTP tests passed successfully!');
