/**
 * 服务端配置。
 *
 * 与浏览器端的根本差别：所有可变状态都从环境变量注入，不再读 Vuex store。
 * 这是让同一套匹配逻辑能同时服务网页端和安卓端的前提。
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { LogLevel } from './logger.ts';

/** server/ 根目录（本文件位于 server/src/） */
export const SERVER_ROOT = resolve(import.meta.dirname, '..');

export interface Config {
  host: string;
  port: number;
  dbPath: string;
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
  /** JWT 密钥是否为随机生成（生产环境应显式配置） */
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
  /** UGREENlink 更新分享 API 基地址 */
  updateUgreenBaseUrl: string;
  /** UGREENlink 分享 ID；为空时关闭更新检查 */
  updateShareId: string;
  /** 分享内 APK 所在目录 */
  updateSharePath: string;
  /** 当前发布 APK 的 versionCode（可选，文件名没有该信息） */
  updateVersionCode: number;
  /** 可选的 APK SHA-256 */
  updateSha256: string;
  /**
   * 业务时区相对**系统时区**的额外小时偏移。
   *
   * 留空（默认）= 自动判定：系统跑在 UTC 时补 +8（容器镜像默认不设 TZ，
   * 而「今天」「每天 00:30」必须是用户本地时间）；系统已是本地时区则不补。
   * 显式设成 0 表示完全跟随系统时区。
   */
  tzOffsetHours: number | null;
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

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function envLogLevel(key: string, fallback: LogLevel): LogLevel {
  const raw = process.env[key];
  return LOG_LEVELS.includes(raw as LogLevel) ? (raw as LogLevel) : fallback;
}

const explicitSecret = envStr('SUENMUSIC_JWT_SECRET', '');

export const config: Config = {
  host: envStr('SUENMUSIC_HOST', '127.0.0.1'),
  port: envNum('SUENMUSIC_PORT', 3210),
  dbPath: resolve(SERVER_ROOT, envStr('SUENMUSIC_DB', './data/suenmusic.db')),
  webRoot: resolve(SERVER_ROOT, envStr('SUENMUSIC_WEB_ROOT', '../web/dist')),
  bilibiliCookie: envStr('SUENMUSIC_BILIBILI_COOKIE', ''),
  neteaseCookie: envStr('SUENMUSIC_NETEASE_COOKIE', ''),
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
  updateUgreenBaseUrl: envStr(
    'SUENMUSIC_UPDATE_UGREEN_BASE_URL',
    'https://suenqi.cn35.ug.link/ugreen/v1'
  ),
  // 分享 ID 本身不是凭据；默认指向官方更新目录，仍可用环境变量替换。
  updateShareId: envStr('SUENMUSIC_UPDATE_SHARE_ID', '87870bfaf0cf4e078326b43c063afa1e'),
  updateSharePath: envStr('SUENMUSIC_UPDATE_SHARE_PATH', '/home/suenqi/应用/SuenApp/SuenMusic'),
  updateVersionCode: envNum('SUENMUSIC_UPDATE_VERSION_CODE', 0),
  updateSha256: envStr('SUENMUSIC_UPDATE_SHA256', '').toLowerCase(),
  tzOffsetHours: envNumOrNull('SUENMUSIC_TZ_OFFSET'),
};
