/**
 * 业务日期工具。
 *
 * ## 为什么需要它
 *
 * 容器镜像装了 tzdata 但**没有设 TZ**，所以服务在云上/容器里基本都跑在 UTC。
 * 而「今天」「每天 00:30」这类概念必须落在**用户本地时区**（UTC+8）：
 * 按容器本地时间算的话，日切会发生在北京时间早上 8 点，定时任务也会跑在 08:30。
 *
 * ## 策略
 *
 * 在系统时区之上叠加一个「额外偏移」：
 *   - 系统是 UTC（容器常态）→ 自动补 +8，于是日切回到北京 00:00、任务跑在北京 00:30；
 *   - 系统已经是本地时区（例如 compose 里设了 TZ=Asia/Shanghai）→ 不再补，避免叠加成 +16；
 *   - 需要时用 `SUENMUSIC_TZ_OFFSET` 显式指定（小时，可为负），覆盖上面的自动判定。
 *
 * 读「业务本地时间」的方式：`businessNow()` 后**一律用 UTC 取值器**
 * （`getUTCHours()` / `toISOString()`），因为它已经把偏移加进去了。
 */

import { config } from '../config.ts';

let cached: number | null = null;

/** 额外偏移（分钟），叠加在系统时区之上 */
export function extraOffsetMinutes(): number {
  if (cached !== null) return cached;
  if (config.tzOffsetHours !== null) {
    cached = Math.round(config.tzOffsetHours * 60);
  } else {
    // getTimezoneOffset 是「UTC 减本地」的分钟数，取负得到「本地的 UTC 偏移」
    const systemOffsetMinutes = -new Date().getTimezoneOffset();
    cached = systemOffsetMinutes === 0 ? 8 * 60 : 0;
  }
  return cached;
}

/** 业务时区下的「现在」——用 UTC 取值器读它即为业务本地时间 */
export function businessNow(): Date {
  return new Date(Date.now() + extraOffsetMinutes() * 60_000);
}

/** 业务本地日期，形如 `2026-09-21` */
export function todayStr(): string {
  return businessNow().toISOString().slice(0, 10);
}

/**
 * 距离下一个业务本地 `hour:minute` 还有多少毫秒。
 *
 * 用于「每天 00:30 执行一次」这类自排程定时器：算完就 `setTimeout`，
 * 触发后再算下一次 —— 不用 `setInterval` 累加漂移。
 */
export function msUntilNextLocal(hour: number, minute: number): number {
  const now = businessNow();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0)
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}
