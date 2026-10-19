/**
 * 上游冷却（风控退避）。
 *
 * 背景：QQ 搜索会返回 `code 2001`、B 站搜索会返回 `code -412`，两者都是**限流**，
 * 不是错误。原来的实现把它当成"没有结果"静默吞掉，用户看到的是"搜不到、播不了、
 * 没有任何反馈" —— 这是最糟的失败方式。
 *
 * 正确处理：命中限流后进入冷却窗口，窗口内**快速失败并给出明确原因**，
 * 而不是继续打上游把窗口越拉越长。连续命中指数退避，一次成功即清零。
 */

export interface CooldownOptions {
  /** 首次冷却时长 */
  baseMs: number;
  /** 冷却时长上限 */
  maxMs: number;
}

export interface CooldownSnapshot {
  name: string;
  active: boolean;
  remainingMs: number;
  strikes: number;
  reason: string;
  totalTrips: number;
}

export class Cooldown {
  readonly name: string;
  private readonly baseMs: number;
  private readonly maxMs: number;

  private strikes = 0;
  private until = 0;
  private reason = '';
  private totalTrips = 0;

  constructor(name: string, options: CooldownOptions) {
    this.name = name;
    this.baseMs = Math.max(1000, options.baseMs);
    this.maxMs = Math.max(this.baseMs, options.maxMs);
  }

  active(): boolean {
    return Date.now() < this.until;
  }

  remainingMs(): number {
    return Math.max(0, this.until - Date.now());
  }

  /**
   * 记录一次限流命中，进入（或延长）冷却窗口。
   *
   * @returns 本次冷却时长（毫秒）
   */
  trip(reason = ''): number {
    const now = Date.now();
    this.strikes = Math.min(this.strikes + 1, 20);

    // base * 2^(n-1)，首次即 baseMs，连续命中翻倍
    const ms = Math.min(this.maxMs, this.baseMs * 2 ** (this.strikes - 1));

    this.until = now + ms;
    this.reason = reason;
    this.totalTrips++;
    return ms;
  }

  /** 一次成功即清零。偶发限流不该让服务长时间降级。 */
  reset(): void {
    if (this.strikes === 0 && this.until === 0) return;
    this.strikes = 0;
    this.until = 0;
    this.reason = '';
  }

  /** 测试或运维需要强制冷却时使用 */
  forceUntil(ms: number, reason = 'manual'): void {
    this.until = Date.now() + Math.max(0, ms);
    this.reason = reason;
  }

  snapshot(): CooldownSnapshot {
    return {
      name: this.name,
      active: this.active(),
      remainingMs: this.remainingMs(),
      strikes: this.strikes,
      reason: this.reason,
      totalTrips: this.totalTrips,
    };
  }
}
