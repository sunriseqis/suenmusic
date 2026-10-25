/**
 * 固定字节速率节流 Transform —— 音频流代理的上行控制。
 *
 * 为什么需要：家里上行被运营商限在 ~5Mbps，而 CDN 给音频的速度远超实时播放。
 * 不限速时客户端会在几秒内把整首 FLAC 预缓冲拉完（瞬时 20+ Mbps），把上行
 * 瞬间打满，挤掉同链路上其他用户的正在播放的流。
 *
 * 原理：令牌桶。预算按 elapsed 时间累积（上限 = 1.5s 突发，掩盖 TCP 慢启动
 * 和首包延迟）；chunk 到来时从预算扣，不够就 setTimeout 等待——等待期间
 * 不调用 cb，Node 自动暂停上游读取，天然背压。
 *
 * 速率必须 ≥ 流的真实码率，否则会缓冲欠载导致卡顿。速率由调用方按
 * 「响应字节数 ÷ 曲目时长」计算（见 routes/stream.ts 的 streamRate）。
 */
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

export function createThrottle(
  bytesPerSec: number,
  /** 每收到一块数据回调一次（用于"空闲守护"重置计时） */
  onActivity?: () => void,
  /**
   * 起始**字节级突发额度**（默认 2MB，不限速直接放行）。
   *
   * 为什么需要：原实现只有 1.5 秒时间窗突发，按音频码率（~33KB/s）算只放行约 50KB。
   * iOS 的 AVPlayer 在 EvaluatingBufferingRate 阶段拿到这种涓流会**一直不开始播放**
   * （实测 8 秒 status 仍 unknown、无错误），而同一文件本地却能瞬间起播。
   * 放行首 2MB 后 AVPlayer 能立刻起播，之后仍按码率节流 —— 上行保护目标不变。
   */
  /**
   * 起始突发额度 **12MB**（覆盖我们绝大多数音频文件，约 5-7MB）。
   *
   * 2026-10-25 实测（mac 上裸 AVPlayer 打真实 URL，量到 readyToPlay）：
   *   突发 2MB → ready 8.6-9.2s；4MB → 1.9s / 8.6s（不稳）；不节流 → 0.76s
   * 结论：**AVFoundation 要攒很大一段前缀才肯就绪**（鸿蒙播放器不需要，所以 hw 2s 内能播）。
   * 因此把突发额度开到覆盖整首，节流只对「超大文件/并发多流」这类真正会打爆上行的情况生效。
   */
  burstBytes: number = 12 * 1024 * 1024
): Transform {
  const BURST_SEC = 1.5;
  // 初始许可时刻回拨一个突发窗口：让开头的 1.5s 数据量可以瞬间发出
  // （否则第一块就要等满自己的发送时长，起播延迟 +1s）
  let next = Date.now() - BURST_SEC * 1000;
  let timer: NodeJS.Timeout | null = null;
  /// 已发出的字节数（用于起始突发额度）
  let sentBytes = 0;

  return new Transform({
    transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
      if (this.destroyed) return;
      onActivity?.();
      const now = Date.now();
      // 突发许可：许可时刻最多落后当前时间 1.5s —— 前段数据可瞬间发出，
      // 之后严格按速率排队。ⓘ 上一版令牌桶实现在等待期间重复计入预算，
      // 实际速率是目标值的两倍（单元测试抓到的），已废弃。
      next = Math.max(next, now - BURST_SEC * 1000);
      const end = next + (chunk.length / bytesPerSec) * 1000;
      next = end;
      sentBytes += chunk.length;

      // 起始突发额度内直接放行（见参数注释）
      if (sentBytes <= burstBytes || end <= now) {
        cb(null, chunk);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        if (!this.destroyed) cb(null, chunk);
      }, end - now);
    },
    destroy(err, cb) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      cb(err);
    },
  });
}
