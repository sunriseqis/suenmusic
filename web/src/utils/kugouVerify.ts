/**
 * 「酷狗需要验证」这条提示的共享状态。
 *
 * 两个触发点（任务要求）：App 启动后一次、每次打开设置页一次。
 * 只有「当前状态 + 是否在探测」两个值，所以不建 store；也不塞进 api 层，
 * 那边保持纯请求函数。
 *
 * 探测走 api 层的 fetchVerifyStateIfAvailable：首选**登录态**接口
 * GET /api/kugou/verify/pending（不要 t）—— 只要服务端手上还有活跃验证事件就能提示，
 * 不要求本机先撞过 20028；pending 不可用（旧服务端 / 网络）时退回上一轮的老路子：
 * 「resolve 撞到 20028 时缓存的票据 + state」。两条都拿不到 → null，提示不出现
 * （这条提示是辅助信息，失败绝不能打扰用户）。
 */

import { ref } from 'vue';
import { fetchVerifyStateIfAvailable, type KugouVerifyState } from '@/api/kugou-verify.ts';

export const kugouVerifyState = ref<KugouVerifyState | null>(null);
export const kugouVerifyLoading = ref(false);

let inflight: Promise<void> | null = null;

/** force=false 时复用进行中的那次请求（启动与进设置页常常只差几十毫秒） */
export function refreshKugouVerifyState(force = false): Promise<void> {
  if (inflight && !force) return inflight;

  const job = (async () => {
    kugouVerifyLoading.value = true;
    try {
      kugouVerifyState.value = await fetchVerifyStateIfAvailable();
    } catch {
      kugouVerifyState.value = null;
    } finally {
      kugouVerifyLoading.value = false;
      inflight = null;
    }
  })();

  inflight = job;
  return job;
}
