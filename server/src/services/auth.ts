/**
 * 认证服务。
 *
 * 令牌策略：
 *   - **访问令牌**：JWT HS256，短时效（默认 2h），无状态，服务端不查库
 *   - **刷新令牌**：随机串，长时效（默认 30d），落库存摘要，可逐个吊销
 *
 * 刷新时**轮换**（rotation）：旧刷新令牌立即作废，换发新的。
 * 这样令牌泄露后的可用窗口被压缩到"下一次刷新之前"，同时保留可吊销性。
 */

import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import { toNumber } from '../db/index.ts';
import * as tokensRepo from '../db/repo/tokens.ts';
import * as usersRepo from '../db/repo/users.ts';
import { getSetting } from '../db/repo/settings.ts';
import { PASSWORD_MIN_LENGTH } from '../utils/password.ts';
import { InvalidUsernameError, UsernameTakenError, WeakPasswordError } from '../db/repo/users.ts';
import type { PublicUser } from '../db/repo/users.ts';
import { signJwt, verifyJwt } from '../utils/jwt.ts';
import {
  badRequest,
  conflict,
  forbidden,
  tooManyRequests,
  unauthorized,
} from '../http/errors.ts';

const log = createLogger('auth');

// 口令长度策略定义在 utils/password.ts。仓储层（含 CLI 这条绕过 HTTP 的路径）
// 必须自己守住它，因此常量不能放在本文件 —— 否则会与 db/repo/users.ts 形成循环依赖。

export interface AuthSession {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  /** 访问令牌过期时刻（毫秒时间戳），客户端据此提前续期 */
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

// ---------- 登录节流 ----------
//
// 服务端可能暴露在公网，登录接口必须能顶住字典攻击。
// 内存实现够用：单进程部署，重启后计数清零不会造成实质风险。

interface AttemptRecord {
  count: number;
  firstAt: number;
}

const attempts = new Map<string, AttemptRecord>();

/** @returns 需要等待的毫秒数；0 表示可以尝试 */
export function loginThrottleCheck(key: string): number {
  const rec = attempts.get(key);
  if (!rec) return 0;

  if (Date.now() - rec.firstAt > config.loginWindowMs) {
    attempts.delete(key);
    return 0;
  }

  if (rec.count < config.loginMaxAttempts) return 0;
  return rec.firstAt + config.loginWindowMs - Date.now();
}

export function loginThrottleFail(key: string): void {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.firstAt > config.loginWindowMs) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  rec.count++;
}

export function loginThrottleReset(key: string): void {
  attempts.delete(key);
}

/** 仅供测试使用 */
export function clearLoginThrottle(): void {
  attempts.clear();
}

// ---------- 入参归一化 ----------
//
// **注册与登录的校验规则必须分开**：
//   - 注册要执行密码强度策略（长度下限）
//   - 登录**不能**执行强度策略。原因有二：
//     a) 强度策略属于"设置口令"环节，登录只是比对，不该关心口令长什么样
//     b) 若将来调高下限，老用户用原密码将永远登不进来
//   更要命的是，登录时先做强度校验会让非法输入**绕过节流计数**
//   —— 攻击者可以无限试探而一次都不计入封禁。

export interface Credentials {
  username: unknown;
  password: unknown;
  displayName?: unknown;
  userAgent?: string;
}

function normalizeCommon(input: Credentials): { username: string; password: string } {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';

  if (!username) throw badRequest('请填写用户名', 'invalid_username');
  if (!password) throw badRequest('请填写密码', 'invalid_password');

  return { username, password };
}

/**
 * 仅注册使用：在通用校验之上追加显示名处理。
 *
 * 口令强度**刻意不在这里校验**，它由仓储层的 `createUser` 强制。
 * 理由：`npm run user:add` 这条 CLI 路径绕开 HTTP 直接调仓储，
 * 校验写在这里就会被它绕过。仓储层抛 `WeakPasswordError`，本文件负责映射成 400。
 */
function normalizeRegisterCredentials(input: Credentials): {
  username: string;
  password: string;
  displayName?: string;
} {
  const { username, password } = normalizeCommon(input);

  return {
    username,
    password,
    displayName:
      typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 64) : undefined,
  };
}

function issueSession(user: PublicUser, userAgent = ''): AuthSession {
  // 带上当前令牌纪元。改密会把它 +1，于是改密前签发的访问令牌全部立即失效 ——
  // 无状态 JWT 收不回来，靠的就是这个整数比较（见 verifyAccessToken）。
  const accessToken = signJwt(
    { sub: user.id, typ: 'access', epo: usersRepo.getTokenEpoch(user.id) },
    config.jwtSecret,
    config.accessTokenTtlMs
  );
  const refresh = tokensRepo.issueRefreshToken(user.id, config.refreshTokenTtlMs, userAgent);

  return {
    user,
    accessToken,
    refreshToken: refresh.token,
    accessExpiresAt: Date.now() + config.accessTokenTtlMs,
    refreshExpiresAt: refresh.expiresAt,
  };
}

/**
 * 是否允许注册。
 *
 * 首个账号永远放行；之后以管理员的开关（app_settings.allow_registration）为准，
 * 没设置过才回落到环境变量。这样界面上的开关能立即生效，不必重启。
 */
/**
 * 有效口令长度：管理员可调高，但不能低于代码里的硬下限。
 * 返回给登录页做预校验，也在注册时兜底。
 */
export function passwordMinLength(): number {
  const raw = Number(getSetting('password_min_length'));
  if (!Number.isFinite(raw) || raw <= PASSWORD_MIN_LENGTH) return PASSWORD_MIN_LENGTH;
  return Math.min(Math.floor(raw), 64);
}

export function registrationAllowed(): boolean {
  if (usersRepo.countUsers() === 0) return true;
  const v = getSetting('allow_registration');
  return v === null ? config.allowRegistration : v === '1';
}

export function register(input: Credentials): AuthSession {
  const { username, password, displayName } = normalizeRegisterCredentials(input);

  // 个人部署场景：允许关闭注册，但"库里一个用户都没有"时永远放行，
  // 否则关掉注册就再也建不出第一个账号了
  if (!registrationAllowed()) {
    throw forbidden('本服务已关闭注册');
  }
  const minLen = passwordMinLength();
  if (password.length < minLen) {
    throw badRequest(`口令至少 ${minLen} 位`);
  }

  try {
    const user = usersRepo.createUser({ username, password, displayName });
    log.info(`新用户注册：${user.username} (id=${user.id})`);
    return issueSession(user, input.userAgent);
  } catch (err) {
    if (err instanceof UsernameTakenError) {
      throw conflict('该用户名已被占用', 'username_taken');
    }
    if (err instanceof InvalidUsernameError) {
      // 格式非法是"请求本身不对"（400），不是资源冲突（409）
      throw badRequest(
        '用户名只能包含字母、数字、下划线和连字符，长度 3-32 位',
        'invalid_username'
      );
    }
    if (err instanceof WeakPasswordError) {
      // 口令策略由仓储层强制（CLI 走同一条路），这里只负责翻译成 HTTP 语义
      throw badRequest(err.message, 'weak_password');
    }
    throw err;
  }
}

export interface LoginInput {
  username: unknown;
  password: unknown;
  userAgent?: string;
  /** 用于节流的标识，通常是客户端 IP */
  throttleKey: string;
}

export function login(input: LoginInput): AuthSession {
  // 登录只校验"字段非空"，不校验口令强度 —— 理由见 normalizeCommon 上方的注释
  const { username, password } = normalizeCommon(input);
  const key = `${input.throttleKey}|${username.toLowerCase()}`;

  const waitMs = loginThrottleCheck(key);
  if (waitMs > 0) {
    log.warn(`登录被节流：${key}，还需等待 ${Math.ceil(waitMs / 1000)}s`);
    throw tooManyRequests(
      `登录尝试过于频繁，请在 ${Math.ceil(waitMs / 1000)} 秒后重试`
    );
  }

  const user = usersRepo.authenticate(username, password);
  if (!user) {
    loginThrottleFail(key);
    // 不区分"用户不存在"与"密码错误"，避免用户枚举
    throw unauthorized('用户名或密码错误');
  }

  loginThrottleReset(key);
  log.info(`登录成功：${user.username} (id=${user.id})`);
  return issueSession(user, input.userAgent);
}

/**
 * 刷新会话。
 *
 * 轮换语义：旧刷新令牌立即吊销，换发新的一对令牌。
 * 若同一旧令牌被重复使用（说明有两方持有），第二次会失败 —— 这正是想要的信号。
 */
export function refresh(refreshToken: string, userAgent = ''): AuthSession {
  const row = tokensRepo.findValidRefreshToken(refreshToken);
  if (!row) throw unauthorized('刷新令牌无效或已过期，请重新登录');

  const userRow = usersRepo.findUserById(row.userId);
  if (!userRow) {
    tokensRepo.revokeRefreshToken(row.id);
    throw unauthorized('账号不存在');
  }

  tokensRepo.revokeRefreshToken(row.id);
  log.debug(`刷新令牌已轮换：userId=${row.userId}`);

  return issueSession(usersRepo.toPublicUser(userRow), userAgent);
}

export function logout(refreshToken: string): boolean {
  const row = tokensRepo.findValidRefreshToken(refreshToken);
  if (!row) return false;
  return tokensRepo.revokeRefreshToken(row.id);
}

export function logoutAll(userId: number): number {
  return tokensRepo.revokeAllForUser(userId);
}

/** 由访问令牌还原当前用户。令牌无效 / 已因改密作废 / 用户已删则返回 null。 */
export function verifyAccessToken(token: string): PublicUser | null {
  const payload = verifyJwt(token, config.jwtSecret);
  if (!payload) return null;

  const row = usersRepo.findUserById(payload.sub);
  if (!row) return null;

  // 改口令后，改密前签发的访问令牌立即作废。
  //
  // 无状态 JWT 本身收不回来，只能靠"令牌携带的纪元 vs 库里的当前纪元"比较。
  // 用法上是 fail-closed：`epo` 缺失（老令牌）按 0 处理，必然被拒绝。
  if ((payload.epo ?? 0) < toNumber(row.token_epoch)) {
    return null;
  }

  return usersRepo.toPublicUser(row);
}

export interface ChangePasswordInput {
  /** 来自访问令牌，不接受客户端自报 */
  userId: number;
  oldPassword: unknown;
  newPassword: unknown;
  userAgent?: string;
}

/**
 * 修改口令。
 *
 * **语义：改密码 = 所有设备下线，当前设备自动续上。**
 * 返回的是**一对新令牌**，客户端必须覆盖保存（旧的刷新令牌已随本次操作吊销）。
 *
 * 为什么吊销全部而不只是"其他设备"：访问令牌是无状态 JWT，
 * 没法从它反推出对应的刷新令牌行，也就无从判断"哪些是其他设备"。
 * 全吊销再补发一对，既实现了同样的效果，又顺带保证了
 * **已经泄露的刷新令牌在改密码后立即失效** —— 这正是用户改密码时最想要的结果。
 */
export function changePassword(input: ChangePasswordInput): AuthSession {
  const oldPassword = typeof input.oldPassword === 'string' ? input.oldPassword : '';
  const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';

  if (!oldPassword) throw badRequest('请填写当前密码', 'invalid_password');
  if (!newPassword) throw badRequest('请填写新密码', 'invalid_password');

  if (!usersRepo.verifyUserPassword(input.userId, oldPassword)) {
    // 401 而非 400：这是"身份没通过验证"，与参数格式无关
    throw unauthorized('当前密码不正确');
  }

  try {
    // 新口令走与注册完全相同的强度策略 —— 同样由仓储层强制，这里只做错误映射
    usersRepo.updatePassword(input.userId, newPassword);
  } catch (err) {
    if (err instanceof WeakPasswordError) {
      throw badRequest(err.message, 'weak_password');
    }
    throw err;
  }

  // 顺序不能反：先发新令牌再吊销，会把刚签发的那个一起吊销掉
  const revoked = tokensRepo.revokeAllForUser(input.userId);
  log.warn(`口令已修改：userId=${input.userId}，同时吊销 ${revoked} 个会话`);

  const row = usersRepo.findUserById(input.userId);
  if (!row) throw unauthorized('账号不存在');

  return issueSession(usersRepo.toPublicUser(row), input.userAgent);
}
