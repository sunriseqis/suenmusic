/**
 * 服务端配置。
 *
 * 与浏览器端的根本差别：所有可变状态都从环境变量注入，不再读 Vuex store。
 * 这是让同一套匹配逻辑能同时服务网页端和安卓端的前提。
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createLogger, type LogLevel } from './logger.ts';

/** server/ 根目录（本文件位于 server/src/） */
export const SERVER_ROOT = resolve(import.meta.dirname, '..');

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /**
   * 整库备份归档（`.sm`）的输出目录。
   *
   * 来自 `SUENMUSIC_BACKUP_DIR`，缺省 `<数据库文件所在目录>/backups`。
   * fnOS 的启动脚本（fn/cmd/main）已经 export 它指向共享目录；启动时 mkdir。
   */
  backupDir: string;
  /**
   * 前端构建产物目录，存在则由本服务直接伺服（单端口部署）。
   *
   * 默认为 monorepo 里的 `../web/dist`。**目录不存在时自动退回「只提供 API」**，
   * 所以只含 `src/` 的 server 镜像（`server/Dockerfile` 就是那种）行为不变。
   */
  webRoot: string;
  bilibiliCookie: string;
  /** 网易云 Cookie（高音质音源 + 相似歌手）。登录后写 app_settings，此为环境变量兜底 */
  neteaseCookie: string;
  jwtSecret: string;
  /** 匹配熔断阈值（0-100），低于该分数拒绝播放 */
  matchThreshold: number;
  upstreamTimeoutMs: number;
  logLevel: LogLevel;
  /**
   * JWT 密钥是否只是「本次进程内临时生成」（= 既没配 env，也没落库）。
   *
   * config 在模块加载期读不到数据库，所以这里初始表示「env 没配」；
   * DB 打开后由 services/jwt-secret.ts 的 applyPersistedJwtSecret() 换成
   * app_settings 里持久化的那把，并把本标记置 false（S-20）。
   * 仍为 true = 只可能是持久化失败，此时重启会让所有令牌失效。
   */
  jwtSecretIsEphemeral: boolean;
  /** 访问令牌有效期（毫秒） */
  accessTokenTtlMs: number;
  /** 刷新令牌有效期（毫秒） */
  refreshTokenTtlMs: number;
  /** 是否允许任意用户注册。关闭后仅允许创建第一个账号（个人部署用） */
  allowRegistration: boolean;
  /** 允许的跨域来源，`*` 表示不限制。仅影响带 Authorization 的 API，不涉及 Cookie */
  corsOrigins: string[];
  /** 登录失败节流：窗口内允许的失败次数 */
  loginMaxAttempts: number;
  /** 登录失败节流窗口（毫秒） */
  loginWindowMs: number;
  /**
   * 更新来源。
   *   `github` —— 从 GitHub Releases 检查最新构建并缓存到本地（唯一来源）
   *   `off`    —— 关闭更新通道（`/api/update/check` 返回 not_configured）
   *
   * （老的 `ugreen` 分享源已按用户要求于 2026-10-21 删除。）
   */
  updateSource: 'github' | 'off';
  /** GitHub 仓库（`owner/repo`），`updateSource=github` 时必填 */
  updateGithubRepo: string;
  /** GitHub token（可选）：把 API 限额从 60/小时提到 5000/小时 */
  updateGithubToken: string;
  /**
   * GitHub API 基地址（可选）。默认 `https://api.github.com`。
   *
   * 给国内环境用：可以把请求指向自建反代或镜像（例如 `https://gh.example.com/api`），
   * 与 `updateGithubProxy`（只代理**产物下载**）分开配置 —— 用文件代理前缀去套 JSON API
   * 通常会失败，所以两者不共用同一个变量。
   */
  updateGithubApiBase: string;

  /** 产物本地缓存目录（docker 挂卷 / fnOS 数据目录都指到能持久化的地方） */
  updateCacheDir: string;
  /** 后台轮询 GitHub 的间隔（分钟，0 = 不自动轮询，只响应手动 force） */
  updatePollMinutes: number;
  /**
   * 业务时区相对**系统时区**的额外小时偏移。
   *
   * 留空（默认）= 自动判定：系统跑在 UTC 时补 +8（容器镜像默认不设 TZ，
   * 而「今天」「每天 00:30」必须是用户本地时间）；系统已是本地时区则不补。
   * 显式设成 0 表示完全跟随系统时区。
   */
  tzOffsetHours: number | null;
  /**
   * Fastify 的 `trustProxy`。
   *
   * **不能无条件 true**：那等于采信任何客户端发来的 `X-Forwarded-For`，
   * 而登录节流按 IP 分桶 —— 攻击者每个请求换一个伪造 IP 就永远撞不到上限，
   * 字典攻击变成无限次（2026-10-20 审计 P1）。
   *
   * 取值语义（`SUENMUSIC_TRUST_PROXY`）：
   *   - 留空（默认）→ `false`：只信 TCP 对端地址，最安全；
   *   - `127.0.0.1,10.0.0.0/8` → 只信这些代理传来的 XFF（推荐用法）；
   *   - `true` → 全信（直连暴露时等于放弃 IP 维度的节流，需显式承担风险）。
   */
  trustProxy: boolean | string[];
}

function envStr(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** 读一个可选数字；未配置或非法返回 null（区别于「配了 0」） */
function envNumOrNull(key: string): number | null {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function envList(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 解析 `SUENMUSIC_UPDATE_SOURCE`。
 *
 * 缺省策略：配了 `SUENMUSIC_UPDATE_GITHUB_REPO` 就用 github，否则 **off**。
 * （ugreen 源已于 2026-10-21 移除，不再有"没配就沿用老源"的兜底。）
 */
function envUpdateSource(name: string): 'github' | 'off' {
  const raw = envStr(name, '').trim().toLowerCase();
  if (raw === 'github' || raw === 'off') return raw;
  if (raw !== '') {
    throw new Error(`${name} 只能是 github / off，收到：${raw}`);
  }
  // 公开仓库有默认值 → 默认开启；用户可在 Web 设置页关掉
  return 'github';
}

/** 解析 SUENMUSIC_TRUST_PROXY，语义见 Config.trustProxy 的注释 */
function envTrustProxy(key: string): boolean | string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return false;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '*' || v === 'all') return true;
  if (v === 'false' || v === '0' || v === 'none') return false;
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function envLogLevel(key: string, fallback: LogLevel): LogLevel {
  const raw = process.env[key];
  return LOG_LEVELS.includes(raw as LogLevel) ? (raw as LogLevel) : fallback;
}

// ---------------------------------------------------------------------------
// JWT 密钥可用性检查（fail-fast）
// ---------------------------------------------------------------------------

/** 见过太多次的占位值 —— 它们公开在仓库里，等于没有密钥 */
const PLACEHOLDER_SECRET_PATTERNS = [
  /change[_-]?me/,
  /your[_-]?(production|secret|jwt)/,
  /placeholder/,
  /^example/,
  /^secret$/,
  /^test$/,
];

/** HS256 密钥最短长度。低于这个长度的十六进制串实际熵不足 */
const MIN_SECRET_LENGTH = 32;

/**
 * 启动即拒：占位密钥 / 过短密钥直接抛错。
 *
 * 为什么必须硬失败而不是 warning：
 *   HS256 的密钥是**离线可验证**的。部署者照抄 `.env.example` 忘了替换时，
 *   任何人拿到仓库就知道签名密钥，可以离线签发 `{sub:1, typ:'access', epo:1}`
 *   （新装库的 token_epoch 恒为 1）→ 直接以管理员身份调用 /api/admin/*。
 *   这条路径没有任何运行期症状，只能靠启动时拦住。
 *
 * 留空不算错：那是「未配置」的合法状态，走每次启动随机的临时密钥兜底
 * （代价是重启后登录态失效，日志里有明确 WARN）。
 */
function assertJwtSecretUsable(secret: string): void {
  if (!secret) return;
  const normalized = secret.trim().toLowerCase();
  const placeholder = PLACEHOLDER_SECRET_PATTERNS.some(re => re.test(normalized));
  const tooShort = secret.trim().length < MIN_SECRET_LENGTH;
  if (!placeholder && !tooShort) return;

  throw new Error(
    [
      '',
      '✖ SUENMUSIC_JWT_SECRET 不可用，服务端拒绝启动。',
      '',
      placeholder
        ? '  当前值看起来是配置文件模板里的占位串（占位密钥公开在仓库里，等于没有密钥）。'
        : `  当前值只有 ${secret.trim().length} 个字符，低于最低要求 ${MIN_SECRET_LENGTH}。`,
      '',
      '  JWT 密钥是离线可验证的：泄露即等于任何人都能伪造管理员令牌。',
      '  生成一个强密钥并写入 server/.env：',
      '',
      '      openssl rand -hex 32',
      '',
      '  （或直接留空 SUENMUSIC_JWT_SECRET= 让服务端每次启动生成临时密钥，',
      '    代价是重启后所有登录态失效 —— 仅适合本机临时试跑。）',
      ''
    ].join('\n')
  );
}

const explicitSecret = envStr('SUENMUSIC_JWT_SECRET', '');
assertJwtSecretUsable(explicitSecret);

/** 数据库文件路径（模块求值一次，backupDir 的缺省值要跟着它算） */
const dbPath = resolve(SERVER_ROOT, envStr('SUENMUSIC_DB', './data/suenmusic.db'));

/**
 * 解析并**在启动时创建**备份目录。
 *
 * 为什么不等第一次备份再建：备份是"出事时才用"的功能，等到用户点备份才发现
 * 目录不可写（权限、共享目录没挂上、只读卷）就太晚了 —— 那时现场已经在收拾了。
 * 创建失败只记一行 WARN，不阻塞启动（服务本身还能跑，备份接口会如实报错）。
 */
function resolveBackupDir(dbFile: string): string {
  const raw = envStr('SUENMUSIC_BACKUP_DIR', '').trim();
  const dir = raw === '' ? join(dirname(dbFile), 'backups') : resolve(SERVER_ROOT, raw);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    createLogger('config').warn(
      `备份目录创建失败（${dir}）：${(err as Error)?.message ?? String(err)}`
    );
  }
  return dir;
}

export const config: Config = {
  host: envStr('SUENMUSIC_HOST', '127.0.0.1'),
  port: envNum('SUENMUSIC_PORT', 3210),
  dbPath,
  backupDir: resolveBackupDir(dbPath),
  webRoot: resolve(SERVER_ROOT, envStr('SUENMUSIC_WEB_ROOT', '../web/dist')),
  bilibiliCookie: envStr('SUENMUSIC_BILIBILI_COOKIE', ''),
  neteaseCookie: envStr('SUENMUSIC_NETEASE_COOKIE', ''),
  /**
   * 未显式配置时先给一把进程内随机值：启动早期（openDatabase 之前）可能已经有
   * 签名发生，必须先有个可用密钥。DB 打开后 applyPersistedJwtSecret()
   * 会把它换成 app_settings 里持久化的那把（没有就落库），见 services/jwt-secret.ts。
   */
  jwtSecret: explicitSecret || randomBytes(32).toString('hex'),
  jwtSecretIsEphemeral: explicitSecret === '',
  matchThreshold: envNum('SUENMUSIC_MATCH_THRESHOLD', 60),
  upstreamTimeoutMs: envNum('SUENMUSIC_UPSTREAM_TIMEOUT_MS', 10000),
  logLevel: envLogLevel('SUENMUSIC_LOG_LEVEL', 'info'),
  accessTokenTtlMs: envNum('SUENMUSIC_ACCESS_TTL_MS', 2 * 60 * 60 * 1000),
  refreshTokenTtlMs: envNum('SUENMUSIC_REFRESH_TTL_MS', 30 * 24 * 60 * 60 * 1000),
  allowRegistration: envBool('SUENMUSIC_ALLOW_REGISTRATION', true),
  corsOrigins: envList('SUENMUSIC_CORS_ORIGINS', ['*']),
  loginMaxAttempts: envNum('SUENMUSIC_LOGIN_MAX_ATTEMPTS', 10),
  loginWindowMs: envNum('SUENMUSIC_LOGIN_WINDOW_MS', 5 * 60 * 1000),
  updateSource: envUpdateSource('SUENMUSIC_UPDATE_SOURCE'),
  /**
   * GitHub 仓库（`owner/repo`）。缺省为公开的安装包发布仓库 `sunriseqis/suenapp`。
   * 公开仓库的 Releases API 匿名即可访问（60次/小时）；配 token 可提额到 5000/小时。
   */
  updateGithubRepo: envStr('SUENMUSIC_UPDATE_GITHUB_REPO', 'sunriseqis/suenapp').trim(),
  updateGithubToken: envStr('SUENMUSIC_UPDATE_GITHUB_TOKEN', '').trim(),
  updateGithubApiBase: envStr('SUENMUSIC_UPDATE_GITHUB_API_BASE', 'https://api.github.com').trim().replace(/\/+$/, ''),

  updateCacheDir: envStr('SUENMUSIC_UPDATE_CACHE_DIR', './data/updates'),
  updatePollMinutes: envNum('SUENMUSIC_UPDATE_POLL_MINUTES', 30),
  // 分享 ID 本身不是凭据；默认指向官方更新目录，仍可用环境变量替换。
  tzOffsetHours: envNumOrNull('SUENMUSIC_TZ_OFFSET'),
  trustProxy: envTrustProxy('SUENMUSIC_TRUST_PROXY'),
};
