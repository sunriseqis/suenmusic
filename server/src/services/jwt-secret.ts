/**
 * JWT 密钥的**持久化**（S-20）。
 *
 * 一把密钥被四处共用：登录/刷新令牌（services/auth.ts）、音频流令牌
 * （utils/stream-token.ts）、更新包令牌（utils/update-token.ts）、
 * 酷狗验证票据（services/kugou-verify.ts）。
 *
 * 旧行为：未显式配置 `SUENMUSIC_JWT_SECRET` 时每次启动 `randomBytes` 一把新的 ——
 * 重启后所有已下发的令牌同时失效。最扎眼的症状是手机通知里的酷狗验证链接：
 * 用户隔一天点开系统浏览器打开它，拿到的是 401「验证票据无效或已过期」，
 * 而他不可能知道那是「服务端重启过」。
 *
 * 现行：未显式配置时把密钥写进 app_settings（存在就复用）。这样
 *   · 只有**升级到本版本后的第一次重启**会让旧票据全失效（上一次启动用的是随机密钥，
 *     没进库）—— 属预期，写在这行注释里就是给后续排查的人看的；
 *   · 之后每次重启复用同一把，登录态/流地址/验证链接都跨重启有效；
 *   · 显式配置 `SUENMUSIC_JWT_SECRET` 仍然**优先级最高**（env 覆盖数据库）。
 *
 * 为什么不在 config.ts 里直接读数据库：`db/index.ts` 反向依赖 `config.dbPath`，
 * 那条 import 环在模块加载期就成立；而本模块只在 openDatabase() + migrate() 之后
 * 被 index.ts 调一次，环不存在。
 */

import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import { getSetting, setSetting } from '../db/repo/settings.ts';

const log = createLogger('jwt-secret');

/** app_settings 里的键名。集中在此，避免字面量散落在各处拼错 */
const SETTING_KEY = 'security.jwtSecret';

/** 与 config.ts 的 MIN_SECRET_LENGTH 同口径（32 字符十六进制 = 128 bit 熵） */
const MIN_SECRET_LENGTH = 32;

export type JwtSecretOrigin = 'env' | 'reused' | 'created' | 'unavailable';

/**
 * 把内存里的（临时）密钥换成持久化的那把。**必须在签名类接口之前调用一次**
 * （index.ts main：openDatabase() + migrate() 之后、listen 之前）。
 *
 * 返回密钥来源，供启动日志说明清楚：
 *   env         显式配置了 SUENMUSIC_JWT_SECRET（数据库不参与）
 *   reused      复用库里已有的那把
 *   created     新生成并写库（升级后第一次重启会走这条，旧票据失效属预期）
 *   unavailable 库不可用/写失败 → 本次仍是进程内临时密钥，重启后登录态失效
 *
 * 失败**不抛**：密钥读不出来不该让整个家庭音乐服务起不来，退化成旧行为并大声警告。
 */
export function applyPersistedJwtSecret(): JwtSecretOrigin {
  // 显式配置优先：部署者指定的密钥就是唯一真相，不读也不写数据库
  if (!config.jwtSecretIsEphemeral) return 'env';

  try {
    const existing = (getSetting(SETTING_KEY) ?? '').trim();
    if (existing.length >= MIN_SECRET_LENGTH) {
      config.jwtSecret = existing;
      config.jwtSecretIsEphemeral = false;
      log.info('JWT 密钥：复用数据库里持久化的那把（重启不再让登录态/流令牌/验证链接失效）');
      return 'reused';
    }

    // 没配 env、库里也没有：把本次进程已经用上的那把落库（不必再随机一次，
    // 否则启动早期（openDatabase 之前）已经签发的令牌会在换密钥后立刻失效）
    const secret =
      config.jwtSecret.trim().length >= MIN_SECRET_LENGTH
        ? config.jwtSecret.trim()
        : randomBytes(32).toString('hex');
    setSetting(SETTING_KEY, secret);
    config.jwtSecret = secret;
    config.jwtSecretIsEphemeral = false;
    log.info(
      'JWT 密钥：未配置 SUENMUSIC_JWT_SECRET，已生成并写入 app_settings（security.jwtSecret）。' +
        '升级后的这次重启会让旧令牌全部失效（此前用的是进程内随机密钥），此后重启不再失效',
    );
    return 'created';
  } catch (err) {
    log.warn(
      `JWT 密钥持久化失败，本次继续使用进程内临时密钥（重启后所有登录态失效，请尽快配置 SUENMUSIC_JWT_SECRET）：` +
        `${(err as Error)?.message ?? String(err)}`,
    );
    return 'unavailable';
  }
}

/**
 * 库里**持久化**的那把密钥（没有则 null）。
 *
 * 供 `services/backup.ts` 派生"加密备份口令 / WebDAV 口令"的主密钥用。
 * 为什么要用这一把而不是 `config.jwtSecret`：显式配置了 SUENMUSIC_JWT_SECRET 时，
 * 恢复流程会在内存里轮换密钥并落库，但**重启后 env 值重新优先** —— 若拿
 * `config.jwtSecret` 派生，轮换期间写入的密文在下次重启后就再也解不开了
 * （实测过：重启后"已存的备份口令无法解密"）。库里有值就以库为准。
 */
export function persistedJwtSecret(): string | null {
  const v = (getSetting(SETTING_KEY) ?? '').trim();
  return v.length >= MIN_SECRET_LENGTH ? v : null;
}

/**
 * **轮换**持久化的 JWT 密钥 —— 整库恢复后强制"所有人重新登录"用。
 *
 * 为什么恢复要换密钥：备份里带着**备份那一刻**的账号与刷新令牌，恢复后那些
 * 令牌行又"活"了过来；而访问令牌是无状态 JWT，换库不会让它失效。不换密钥 =
 * 恢复前签发的访问令牌继续有效，恢复这件事在鉴权层面等于没发生。
 *
 * 与 `applyPersistedJwtSecret()` 共用同一个 app_settings 键，语义保持一致：
 *   · 未配 env（常态）→ 新密钥落库，之后每次重启都复用它；
 *   · 配了 env → 内存里立刻生效，但**重启后 env 值重新优先**，届时恢复后签发的
 *     令牌也会失效（代价是再登录一次，方向仍然是"更严格"，可接受）。
 *
 * 调用方（services/backup.ts 的恢复流程）还会同时吊销刷新令牌、抬高 token_epoch，
 * 因为 Web 面板的会话走 cookie 里的刷新令牌，光换密钥堵不住。
 */
export function rotatePersistedJwtSecret(): string {
  const secret = randomBytes(32).toString('hex');
  config.jwtSecret = secret;
  config.jwtSecretIsEphemeral = false;
  setSetting(SETTING_KEY, secret);
  log.warn('JWT 密钥已轮换：此前签发的所有访问令牌立即失效，需要重新登录');
  return secret;
}
