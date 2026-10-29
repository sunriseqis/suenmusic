/**
 * HTTP 层验收脚本（P3）。
 *
 * 起一个**真实监听的 Fastify 实例**（端口 0 = 由系统分配，绝不撞用户跑着的服务），
 * 用 fetch 打真实 HTTP，验完关掉、删库。
 *
 * 覆盖：健康检查、注册、登录、令牌校验、刷新轮换、退出、
 *       会话管理、登录节流、错误体形状、CORS 预检、未知路由。
 *
 * 运行：npm run test:api
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SERVER_ROOT, config } from '../config.ts';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { buildApp } from '../app.ts';
import { clearLoginThrottle } from '../services/auth.ts';
import { signJwt } from '../utils/jwt.ts';
import type { FastifyInstance } from 'fastify';

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

function note(text: string): void {
  process.stdout.write(`       ${text}\n`);
}

// ---------- 环境 ----------

const tmpDb = join(SERVER_ROOT, 'data', `.apitest-${randomBytes(4).toString('hex')}.db`);
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
  options: { body?: unknown; token?: string; cookie?: string; rawBody?: string; headers?: Record<string, string> } = {}
): Promise<Res> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // Web 面板通道：HttpOnly cookie + CSRF 头（管理接口只认这条通道）
  if (options.cookie) {
    headers.Cookie = options.cookie;
    if (method !== 'GET' && method !== 'HEAD') headers['X-Requested-With'] = 'suenmusic';
  }
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
  });

  const raw = Buffer.from(await res.arrayBuffer());
  const text = raw.toString('utf8');
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  return { status: res.status, json, headers: res.headers };
}

/** Web 面板通道：走 /api/auth/session 拿 HttpOnly cookie（管理接口只认这条） */
async function webCookie(username: string, password: string): Promise<string> {
  const res = await req('POST', '/api/auth/session', { body: { username, password } });
  const raw = res.headers.get('set-cookie') ?? '';
  const m = /suen_session=[^;]*/.exec(raw);
  if (!m) throw new Error(`会话登录未下发 cookie：${raw.slice(0, 80)}`);
  return m[0];
}

/** 断言错误体形状统一为 { error: { code, message } } */
function checkErrorShape(name: string, res: Res, expectedStatus: number, expectedCode?: string): void {
  eq(`${name}：HTTP ${expectedStatus}`, res.status, expectedStatus);
  check(
    `${name}：错误体形状`,
    !!res.json?.error && typeof res.json.error.code === 'string' && typeof res.json.error.message === 'string',
    JSON.stringify(res.json).slice(0, 160)
  );
  if (expectedCode) {
    eq(`${name}：错误码`, res.json?.error?.code, expectedCode);
  }
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
  process.stdout.write('SuenMusic 服务端 —— HTTP 层验收 (P3)\n');
  process.stdout.write(`临时库：${tmpDb}\n`);

  openDatabase(tmpDb);
  migrate();

  app = buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  note(`测试实例：${base}（随机端口，仅绑定 127.0.0.1）`);

  const PASSWORD = 'test-password-1';

  // ---- 1. 健康检查 ----
  section('[1/8] 健康检查');
  const health = await req('GET', '/api/health');
  eq('公开健康检查返回 200', health.status, 200);
  eq('ok 为 true', health.json?.ok, true);

  const detailUnauth = await req('GET', '/api/health/detail');
  checkErrorShape('未登录访问详情', detailUnauth, 401, 'unauthorized');

  // ---- 1b. 公开的认证配置 ----
  // 守的是"登录页死锁"：客户端必须在**未登录**时就知道注册是否开放，
  // 否则永远不知道该不该显示注册入口。这个信息原本只存在于需要鉴权的
  // /api/health/detail，等于谁都拿不到。
  section('[1b] 公开认证配置');
  const cfg = await req('GET', '/api/auth/config');
  eq('无需登录即可访问', cfg.status, 200);
  eq('返回注册开放状态', typeof cfg.json?.registrationOpen, 'boolean');
  eq('空库时还没有账号', cfg.json?.hasUsers, false);
  eq('空库时首个账号永远可注册', cfg.json?.registrationOpen, true);
  eq('透出口令长度下限供前端预校验', cfg.json?.passwordMinLength, 8);
  eq('配置不参与缓存', cfg.headers.get('cache-control'), 'no-store');
  check('配置不含任何口令痕迹', !JSON.stringify(cfg.json).includes('password_'));

  // ---- 2. 注册 ----
  section('[2/8] 注册');
  const reg = await req('POST', '/api/auth/register', {
    body: { username: 'tester', password: PASSWORD, displayName: '测试账号' },
  });
  eq('注册返回 201', reg.status, 201);
  eq('返回用户信息', reg.json?.user?.username, 'tester');
  eq('displayName 生效', reg.json?.user?.displayName, '测试账号');
  check('返回访问令牌', typeof reg.json?.accessToken === 'string' && reg.json.accessToken.length > 20);
  check('返回刷新令牌', typeof reg.json?.refreshToken === 'string' && reg.json.refreshToken.length > 20);
  check('返回访问令牌过期时刻', typeof reg.json?.accessExpiresAt === 'number');
  check('响应不含口令字段', !JSON.stringify(reg.json).includes('password'));

  let accessToken: string = reg.json.accessToken;
  let refreshToken: string = reg.json.refreshToken;
  const userId: number = reg.json.user.id;

  // 产品行为：首个账号注册后注册通道自动收闭（规划：注册完后由管理员决定开不开）。
  // 先验证已关，再用这个管理员身份打开 —— 后面重复用户名 / 弱口令等校验
  // 都要求在"敞开"状态下才会走到，否则会被 403 挡住。
  checkErrorShape(
    '首个账号后注册自动收闭',
    await req('POST', '/api/auth/register', { body: { username: 'blocked', password: PASSWORD } }),
    403,
    'forbidden'
  );
  // 管理操作只认 Web 面板的 cookie 会话：先证明 Bearer 被打，
  // 再证明同一个人走 cookie 能过——两头都钉死，渠道闸才算验收。
  const adminCookie = await webCookie('tester', PASSWORD);
  const bearerAdmin = await req('GET', '/api/admin/users', { token: accessToken });
  checkErrorShape('管理员 Bearer 也被渠道闸挡下', bearerAdmin, 403, 'forbidden');
  const cookieAdmin = await req('GET', '/api/admin/users', { cookie: adminCookie });
  eq('同一管理员走 cookie 通道放行', cookieAdmin.status, 200);

  const openReg = await req('PATCH', '/api/admin/settings', {
    cookie: adminCookie,
    body: { allowRegistration: true },
  });
  eq('管理员重新打开注册', openReg.status, 200);

  checkErrorShape(
    '重复用户名',
    await req('POST', '/api/auth/register', { body: { username: 'tester', password: PASSWORD } }),
    409,
    'username_taken'
  );
  checkErrorShape(
    '用户名大写变体也算重复',
    await req('POST', '/api/auth/register', { body: { username: 'TESTER', password: PASSWORD } }),
    409,
    'username_taken'
  );
  checkErrorShape(
    '密码过短',
    await req('POST', '/api/auth/register', { body: { username: 'shortpw', password: 'abc' } }),
    400,
    'weak_password'
  );
  checkErrorShape(
    '用户名含空格',
    await req('POST', '/api/auth/register', { body: { username: 'a b', password: PASSWORD } }),
    400,
    'invalid_username'
  );
  checkErrorShape(
    '缺少用户名',
    await req('POST', '/api/auth/register', { body: { password: PASSWORD } }),
    400,
    'invalid_username'
  );
  checkErrorShape(
    '缺少密码',
    await req('POST', '/api/auth/register', { body: { username: 'nopw' } }),
    400,
    'invalid_password'
  );

  // 第二个用户，用于隔离验证
  const reg2 = await req('POST', '/api/auth/register', {
    body: { username: 'tester2', password: PASSWORD },
  });
  eq('可注册第二个用户', reg2.status, 201);
  const token2: string = reg2.json.accessToken;
  const refresh2: string = reg2.json.refreshToken;

  // ---- 3. 登录 ----
  section('[3/8] 登录');
  checkErrorShape(
    '错误密码',
    await req('POST', '/api/auth/login', { body: { username: 'tester', password: 'wrong-password' } }),
    401,
    'unauthorized'
  );
  checkErrorShape(
    '不存在的用户（与密码错误同码，避免用户枚举）',
    await req('POST', '/api/auth/login', { body: { username: 'nobody-here', password: 'whatever1' } }),
    401,
    'unauthorized'
  );

  const login = await req('POST', '/api/auth/login', { body: { username: 'tester', password: PASSWORD } });
  eq('正确凭据登录返回 200', login.status, 200);
  eq('返回同一个用户', login.json?.user?.id, userId);
  check('登录换发了新令牌', login.json?.accessToken !== accessToken);

  accessToken = login.json.accessToken;
  refreshToken = login.json.refreshToken;
  clearLoginThrottle();

  // ---- 4. 访问令牌校验 ----
  section('[4/8] 访问令牌校验');
  checkErrorShape('无令牌访问 /me', await req('GET', '/api/auth/me'), 401, 'unauthorized');
  checkErrorShape(
    '畸形令牌',
    await req('GET', '/api/auth/me', { token: 'not-a-jwt' }),
    401,
    'unauthorized'
  );

  const tampered = `${accessToken.slice(0, -3)}xyz`;
  checkErrorShape(
    '签名被篡改',
    await req('GET', '/api/auth/me', { token: tampered }),
    401,
    'unauthorized'
  );

  // 用同一密钥签一个已过期的令牌 —— 签名合法但 exp 已过
  const expired = signJwt({ sub: userId, typ: 'access', epo: 1 }, config.jwtSecret, -60_000);
  checkErrorShape(
    '已过期的合法签名令牌',
    await req('GET', '/api/auth/me', { token: expired }),
    401,
    'unauthorized'
  );

  // 不存在的用户 id（令牌有效但用户已删）
  const ghost = signJwt({ sub: 999_999, typ: 'access', epo: 1 }, config.jwtSecret, 60_000);
  checkErrorShape(
    '令牌指向已删除用户',
    await req('GET', '/api/auth/me', { token: ghost }),
    401,
    'unauthorized'
  );

  // 令牌纪元落后（等价于"改密之前签发"）。签名和时限都合法，只有 epo 是旧的，
  // 必须被拒 —— 这是"改密码让所有设备下线"成立的关键一步。
  const staleEpoch = signJwt({ sub: userId, typ: 'access', epo: 0 }, config.jwtSecret, 60_000);
  checkErrorShape(
    '令牌纪元过旧被拒（等价于改密前签发）',
    await req('GET', '/api/auth/me', { token: staleEpoch }),
    401,
    'unauthorized'
  );

  const me = await req('GET', '/api/auth/me', { token: accessToken });
  eq('有效令牌访问 /me 返回 200', me.status, 200);
  eq('返回正确用户', me.json?.user?.id, userId);
  check('响应不含口令字段', !JSON.stringify(me.json).includes('password'));

  // ---- 5. 刷新与轮换 ----
  section('[5/8] 刷新令牌轮换');

  const refreshed = await req('POST', '/api/auth/refresh', { body: { refreshToken } });
  eq('刷新返回 200', refreshed.status, 200);
  check('换发了新的访问令牌', refreshed.json?.accessToken !== accessToken);
  check('换发了新的刷新令牌', refreshed.json?.refreshToken !== refreshToken);

  const oldRefresh = refreshToken;
  accessToken = refreshed.json.accessToken;
  refreshToken = refreshed.json.refreshToken;

  checkErrorShape(
    '旧刷新令牌已被轮换作废',
    await req('POST', '/api/auth/refresh', { body: { refreshToken: oldRefresh } }),
    401,
    'unauthorized'
  );
  checkErrorShape(
    '伪造的刷新令牌',
    await req('POST', '/api/auth/refresh', { body: { refreshToken: 'forged-token-value' } }),
    401,
    'unauthorized'
  );
  checkErrorShape(
    '缺少 refreshToken',
    await req('POST', '/api/auth/refresh', { body: {} }),
    400,
    'bad_request'
  );

  const afterRotate = await req('GET', '/api/auth/me', { token: accessToken });
  eq('轮换后的新访问令牌可用', afterRotate.status, 200);

  // ---- 6. 会话管理 ----
  section('[6/8] 会话管理与退出');

  const sessions = await req('GET', '/api/auth/sessions', { token: accessToken });
  eq('会话列表返回 200', sessions.status, 200);
  const sessionList: any[] = sessions.json?.sessions ?? [];
  check('至少有两个活跃会话（注册 + 登录轮换后）', sessionList.length >= 2, `实际 ${sessionList.length}`);
  check('会话不含令牌明文', !JSON.stringify(sessions.json).includes(refreshToken));

  // tester2 不能吊销 tester 的会话
  const foreignRevoke = await req('POST', '/api/auth/revoke', {
    token: token2,
    body: { sessionId: sessionList[0].id },
  });
  checkErrorShape('跨账号吊销会话被拒绝', foreignRevoke, 403, 'forbidden');

  // 吊销**另一个**会话（不能吊销自己当前用的那个，否则下面的退出断言会假失败）。
  // 列表按创建时间倒序，sessionList[0] 是刚轮换出来的当前会话，取最后一个。
  const otherSessionId = sessionList[sessionList.length - 1].id;
  const selfRevoke = await req('POST', '/api/auth/revoke', {
    token: accessToken,
    body: { sessionId: otherSessionId },
  });
  eq('吊销自己的其他会话成功', selfRevoke.status, 200);
  eq('吊销返回 true', selfRevoke.json?.revoked, true);

  const sessionsAfter = await req('GET', '/api/auth/sessions', { token: accessToken });
  check(
    '被吊销的会话已不在列表中',
    !(sessionsAfter.json?.sessions ?? []).some((s: any) => s.id === otherSessionId)
  );
  check(
    '当前会话仍然有效',
    (sessionsAfter.json?.sessions ?? []).some((s: any) => s.id === sessionList[0].id)
  );

  checkErrorShape(
    '缺少 sessionId',
    await req('POST', '/api/auth/revoke', { token: accessToken, body: {} }),
    400,
    'bad_request'
  );

  // 退出当前设备
  const logout = await req('POST', '/api/auth/logout', { body: { refreshToken } });
  eq('退出返回 200', logout.status, 200);
  eq('退出已吊销令牌', logout.json?.revoked, true);
  checkErrorShape(
    '退出后刷新令牌失效',
    await req('POST', '/api/auth/refresh', { body: { refreshToken } }),
    401,
    'unauthorized'
  );

  const logoutIdempotent = await req('POST', '/api/auth/logout', { body: { refreshToken } });
  eq('重复退出仍返回 200（幂等）', logoutIdempotent.status, 200);
  eq('重复退出 revoked 为 false', logoutIdempotent.json?.revoked, false);

  // tester2 退出所有设备
  const logoutAll = await req('POST', '/api/auth/logout-all', { token: token2 });
  eq('退出所有设备返回 200', logoutAll.status, 200);
  eq('吊销了 1 个会话', logoutAll.json?.revoked, 1);
  checkErrorShape(
    '退出所有设备后刷新令牌失效',
    await req('POST', '/api/auth/refresh', { body: { refreshToken: refresh2 } }),
    401,
    'unauthorized'
  );
  checkErrorShape('退出所有设备需登录', await req('POST', '/api/auth/logout-all'), 401, 'unauthorized');

  // ---- 6b. 修改口令 ----
  // 语义：改密码 = 所有设备下线，当前设备自动续上（返回一对新令牌）。
  section('[6b] 修改口令');
  const pwReg = await req('POST', '/api/auth/register', {
    body: { username: 'pwchanger', password: 'origin-pass-1' },
  });
  eq('改密测试账号注册成功', pwReg.status, 201);
  const pwAccess: string = pwReg.json.accessToken;
  const pwRefresh: string = pwReg.json.refreshToken;

  const cfgNow = await req('GET', '/api/auth/config');
  eq('已有账号后 hasUsers 变为 true', cfgNow.json?.hasUsers, true);

  checkErrorShape(
    '旧密码错误时改密被拒',
    await req('PATCH', '/api/auth/password', {
      token: pwAccess,
      body: { oldPassword: 'not-the-old-one', newPassword: 'brand-new-pass-1' },
    }),
    401,
    'unauthorized'
  );
  checkErrorShape(
    '新密码过短被拒',
    await req('PATCH', '/api/auth/password', {
      token: pwAccess,
      body: { oldPassword: 'origin-pass-1', newPassword: 'short' },
    }),
    400,
    'weak_password'
  );
  checkErrorShape(
    '缺少新密码',
    await req('PATCH', '/api/auth/password', {
      token: pwAccess,
      body: { oldPassword: 'origin-pass-1' },
    }),
    400,
    'invalid_password'
  );
  checkErrorShape(
    '改密需登录',
    await req('PATCH', '/api/auth/password', {
      body: { oldPassword: 'origin-pass-1', newPassword: 'brand-new-pass-1' },
    }),
    401,
    'unauthorized'
  );

  // 失败的尝试绝不能已经把口令改掉
  eq(
    '失败的改密尝试未改动口令',
    (
      await req('POST', '/api/auth/login', {
        body: { username: 'pwchanger', password: 'origin-pass-1' },
      })
    ).status,
    200
  );

  const pwChange = await req('PATCH', '/api/auth/password', {
    token: pwAccess,
    body: { oldPassword: 'origin-pass-1', newPassword: 'brand-new-pass-1' },
  });
  eq('改密返回 200', pwChange.status, 200);
  const newAccess: string = pwChange.json?.accessToken;
  const newRefresh: string = pwChange.json?.refreshToken;
  check('返回新的访问令牌', typeof newAccess === 'string' && newAccess !== pwAccess);
  check('返回新的刷新令牌', typeof newRefresh === 'string' && newRefresh !== pwRefresh);
  eq('改密后仍是同一用户', pwChange.json?.user?.username, 'pwchanger');

  // 旧刷新令牌必须立即失效 —— 泄露的令牌不能活过改密
  checkErrorShape(
    '改密后旧刷新令牌失效',
    await req('POST', '/api/auth/refresh', { body: { refreshToken: pwRefresh } }),
    401,
    'unauthorized'
  );

  // 旧**访问**令牌也必须失效。无状态 JWT 收不回来，靠 users.token_epoch 比对实现；
  // 少了这一步，"所有设备下线"就只兑现一半（要等满 TTL）。
  checkErrorShape(
    '改密后旧访问令牌失效',
    await req('GET', '/api/auth/me', { token: pwAccess }),
    401,
    'unauthorized'
  );

  // 回归断言：改密接口当场签发的新令牌不能被令牌纪元误伤。
  const meAfter = await req('GET', '/api/auth/me', { token: newAccess });
  eq('改密后新访问令牌立即可用', meAfter.status, 200);
  eq('新令牌对应正确的用户', meAfter.json?.user?.username, 'pwchanger');

  // 会话数必须在"用新密码再登录一次"**之前**查 —— 那次登录会新增一个会话
  const pwSessions = await req('GET', '/api/auth/sessions', { token: newAccess });
  eq('改密后只剩当前一个会话', (pwSessions.json?.sessions ?? []).length, 1);

  eq(
    '旧密码不能再登录',
    (
      await req('POST', '/api/auth/login', {
        body: { username: 'pwchanger', password: 'origin-pass-1' },
      })
    ).status,
    401
  );
  eq(
    '新密码可以登录',
    (
      await req('POST', '/api/auth/login', {
        body: { username: 'pwchanger', password: 'brand-new-pass-1' },
      })
    ).status,
    200
  );

  // ---- 7. 登录节流 ----
  section('[7/8] 登录节流（防字典攻击）');
  clearLoginThrottle();
  await req('POST', '/api/auth/register', { body: { username: 'throttle', password: PASSWORD } });
  clearLoginThrottle();

  // 回归断言：登录**不得**套用注册的密码长度策略。
  // 曾经的实现里短密码会先被 400 拦下，根本进不了节流计数 ——
  // 攻击者可以无限试探而一次都不计入封禁。正确行为是 401 并计入。
  const shortPwLogin = await req('POST', '/api/auth/login', {
    body: { username: 'throttle', password: 'abc' },
  });
  checkErrorShape('登录短密码返回 401（而非 400）', shortPwLogin, 401, 'unauthorized');
  clearLoginThrottle();

  let blockedAt = -1;
  const WRONG = 'wrong-password-attempt';
  for (let i = 1; i <= config.loginMaxAttempts + 1; i++) {
    const r = await req('POST', '/api/auth/login', {
      body: { username: 'throttle', password: `${WRONG}-${i}` },
    });
    if (i <= config.loginMaxAttempts) {
      if (r.status !== 401) {
        check(`第 ${i} 次失败尝试应返回 401`, false, `实际 ${r.status} ${JSON.stringify(r.json)}`);
        break;
      }
      continue;
    }
    if (r.status === 429) {
      blockedAt = i;
      check('节流响应带明确文案', /重试/.test(r.json?.error?.message ?? ''), JSON.stringify(r.json));
      check('节流错误码正确', r.json?.error?.code === 'too_many_requests');
    }
  }
  eq(`第 ${config.loginMaxAttempts + 1} 次尝试被节流`, blockedAt, config.loginMaxAttempts + 1);

  const blockedCorrect = await req('POST', '/api/auth/login', {
    body: { username: 'throttle', password: PASSWORD },
  });
  eq('节流期间正确密码也被拒（防时序侧信道）', blockedCorrect.status, 429);

  // 节流按 IP+用户名 计数，换个用户名不应被牵连
  const otherUser = await req('POST', '/api/auth/login', {
    body: { username: 'tester', password: PASSWORD },
  });
  eq('节流不牵连其他用户名', otherUser.status, 200);
  clearLoginThrottle();

  const afterClear = await req('POST', '/api/auth/login', {
    body: { username: 'throttle', password: PASSWORD },
  });
  eq('节流窗口重置后正确密码可登录', afterClear.status, 200);
  clearLoginThrottle();

  // ---- 8. 错误体 / CORS / 未知路由 ----
  section('[8/8] 错误体、CORS、未知路由');

  const notFound = await req('GET', '/api/does-not-exist');
  checkErrorShape('未知路由', notFound, 404, 'not_found');

  const malformed = await req('POST', '/api/auth/login', { rawBody: '{ this is not json' });
  checkErrorShape('畸形 JSON', malformed, 400, 'bad_request');

  const preflight = await req('OPTIONS', '/api/health', {
    headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'GET' },
  });
  eq('预检返回 204', preflight.status, 204);
  eq('允许来源', preflight.headers.get('access-control-allow-origin'), '*');
  check(
    '允许 Range 请求头（音频拖进度条必需）',
    (preflight.headers.get('access-control-allow-headers') ?? '').includes('Range')
  );
  check(
    '暴露 Content-Range（否则前端拿不到总长度）',
    (preflight.headers.get('access-control-expose-headers') ?? '').includes('Content-Range')
  );

  const withOrigin = await req('GET', '/api/health', { headers: { Origin: 'http://localhost:8080' } });
  eq('实际请求也带 CORS 头', withOrigin.headers.get('access-control-allow-origin'), '*');

  // 健康详情（需登录）
  const detail = await req('GET', '/api/health/detail', { token: accessToken });
  eq('登录后健康详情返回 200', detail.status, 200);
  check('包含 QQ 冷却状态', typeof detail.json?.cooldowns?.qq?.active === 'boolean');
  check('包含 B 站冷却状态', typeof detail.json?.cooldowns?.bilibili?.active === 'boolean');
  check('包含上游调用统计', typeof detail.json?.upstream?.search === 'number');
  check('包含解析器统计', typeof detail.json?.resolver?.memorySize === 'number');
  eq(
    '数据库用户数正确（tester / tester2 / pwchanger / throttle）',
    detail.json?.database?.users,
    4
  );
  check(
    '不回显 B 站 Cookie 原文',
    !JSON.stringify(detail.json).includes('cookie') ||
      detail.json?.config?.bilibiliCookie === '未配置' ||
      detail.json?.config?.bilibiliCookie === '已配置'
  );

  // ---------------------------------------------------------------------
  section('[8b] B 站账号接口（全站共用的出网身份，必须登录后才能碰）');
  // ---------------------------------------------------------------------
  //
  // 这四个接口改的是**全站共用**的凭证 —— 不设防就等于把服务端出网身份
  // 交给任何能访问端口的人。所以先逐个卡未登录必须 401。
  for (const [method, path] of [
    ['GET', '/api/bilibili/account'],
    ['POST', '/api/bilibili/qrcode'],
    ['GET', '/api/bilibili/qrcode/some-key'],
    ['DELETE', '/api/bilibili/account'],
  ] as const) {
    const res = await req(method, path);
    checkErrorShape(`${method} ${path} 未登录被拒`, res, 401, 'unauthorized');
  }

  // 未配置时（测试环境既没有环境变量也没有库内凭证）
  const biliStatus = await req('GET', '/api/bilibili/account', { token: accessToken });
  eq('已登录时能读到 B 站账号状态', biliStatus.status, 200);
  eq('测试环境未配置凭证', biliStatus.json?.configured, false);
  eq('来源为 none', biliStatus.json?.source, 'none');
  eq('没有账号信息', biliStatus.json?.account, null);
  eq('没有 SESSDATA', biliStatus.json?.hasSessdata, false);
  eq('没东西可退出', biliStatus.json?.canLogout, false);

  // 退出：本来就没有库内凭证，应当是一次无副作用的成功
  const biliLogout = await req('DELETE', '/api/bilibili/account', { cookie: adminCookie });
  eq('退出登录返回 200', biliLogout.status, 200);
  eq('没有环境变量可回落', biliLogout.json?.revertedToEnv, false);

  const biliAfterLogout = await req('GET', '/api/bilibili/account', { token: accessToken });
  eq('退出后仍未配置', biliAfterLogout.json?.configured, false);

  // 空 key 要在到达上游之前就被挡住 —— 否则会拿空参数去打 B 站
  const biliEmptyKey = await req('GET', '/api/bilibili/qrcode/%20', { cookie: adminCookie });
  checkErrorShape('空白 qrcode_key 被拒', biliEmptyKey, 400, 'bad_request');

  // ---------------------------------------------------------------------
  section('[8c] AI 模型与分配的渠道分界');
  // ---------------------------------------------------------------------
  //
  // 约定（2026-10-18 边界文档 + 10-20 渠道闸）：
  //   模型增删改/测试 —— 只能从 Web 面板（cookie 会话）发起，Bearer 一律 403
  //   分配（决策/复核）—— 任何登录用户、任何渠道都能改
  const modelsByBearer = await req('GET', '/api/ai/models', { token: accessToken });
  checkErrorShape('GET /api/ai/models 管理员 Bearer 被渠道闸挡下', modelsByBearer, 403, 'forbidden');
  const testByBearer = await req('POST', '/api/ai/models/test', {
    token: accessToken,
    body: {},
  });
  checkErrorShape('POST /api/ai/models/test 管理员 Bearer 被渠道闸挡下', testByBearer, 403, 'forbidden');
  const modelsByCookie = await req('GET', '/api/ai/models', { cookie: adminCookie });
  eq('cookie 通道能读模型清单', modelsByCookie.status, 200);

  // 2026-10-20：分工指派收回 Web 面板管理员专属（用户拍板：其他用户不可改
  // 不可见），独立 assignment 接口已删除 —— 现在应是 404，不是 200/403。
  const assign = await req('GET', '/api/ai/assignment', { token: accessToken });
  eq('独立分配接口已删除（不可见）', assign.status, 404);
  const badAssign = await req('PATCH', '/api/ai/assignment', {
    token: accessToken,
    body: { decideProfileId: 'no-such-model' },
  });
  eq('独立分配接口 PATCH 同样已删除', badAssign.status, 404);

  // 分配改走模型配置保存（管理员 cookie 通道），且缺省分配字段保留当前指派
  const modelsView = await req('GET', '/api/ai/models', { cookie: adminCookie });
  check(
    '模型清单带分工指派字段',
    typeof modelsView.json?.decideProfileId === 'string'
      && Array.isArray(modelsView.json?.profiles)
  );
  const keepAssign = await req('POST', '/api/ai/models', {
    cookie: adminCookie,
    body: {
      profiles: (modelsView.json?.profiles ?? []).map(
        (p: { id: string; name: string; baseUrl: string; model: string }) => ({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          model: p.model,
        })
      ),
    },
  });
  eq('缺省分配字段时保存成功', keepAssign.status, 200);
  check(
    '保存后指派保留不变',
    keepAssign.json?.config?.decideProfileId === modelsView.json?.decideProfileId
  );

  // cookie 下发接口随直连模式废止（2026-10-20 删）：应该是 404，不是 403/401
  const cred = await req('GET', '/api/sources/credentials', { token: accessToken });
  eq('凭证下发接口已删除', cred.status, 404);

  // ---- 汇总 ----
  process.stdout.write('\n' + '-'.repeat(60) + '\n');
  if (failed === 0) {
    process.stdout.write(`HTTP 层验收通过：${passed} 项全部通过。\n`);
    return 0;
  }
  process.stdout.write(`HTTP 层验收未通过：${passed} 通过 / ${failed} 失败。\n`);
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
      // 忽略关闭异常
    }
  }
  cleanup();
}
process.exit(code);
