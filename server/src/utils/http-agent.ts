/**
 * 放开 Node 内置 fetch（undici）的**默认出站超时**。
 *
 * ## 为什么必须有这个文件
 *
 * undici 的 `headersTimeout` / `bodyTimeout` 默认都是 **300 秒**，而且：
 *   - 它抛的是 `TypeError: fetch failed`，cause 为 `HeadersTimeoutError` ——
 *     在日志里与真实的网络故障**长得一模一样**，极难排查；
 *   - 它**先于**调用处传的 `AbortSignal.timeout(timeoutMs)` 生效，
 *     所以在 AI 调用处把超时设成 600 秒也完全没用，300 秒就死了。
 *
 * 实测（2026-09-22，本机对着真实端点压过）：
 *   - 画像摘要 / 选曲走 SiliconFlow，单次实测 150~296 秒；
 *   - 本地 9router 的审核单次实测 **530.9 秒**（14k tokens，其中 8k 是思考 token）。
 *   也就是说：**300 秒的隐藏上限正好卡在业务需求的中间**，
 *   表现为「画像生成每次都超时、点了全量生成也没反应」。
 *
 * 抬到 15 分钟后，**调用处的 `timeoutMs` 才是真正的预算上限** ——
 * 那里的值带业务语义（可以按任务区分），这里的值只是防止连接永久挂住。
 *
 * ⚠️ 注意别把这里设得比调用处更小，否则又会出现"设了 600 秒却 300 秒死"的同类问题。
 */
import { Agent, setGlobalDispatcher } from 'undici';

/** 出站连接的兜底上限：只防"永远挂着"，不是业务预算（业务预算在各调用处的 timeoutMs） */
const OUTBOUND_SAFETY_TIMEOUT_MS = 15 * 60 * 1000;

/** 建连超时保持短一点：建连本来就该是快的，慢说明网络有问题 */
const CONNECT_TIMEOUT_MS = 30_000;

let applied = false;

/** 进程内调用一次即可；重复调用无副作用 */
export function relaxOutboundTimeout(): void {
  if (applied) return;
  applied = true;
  setGlobalDispatcher(
    new Agent({
      headersTimeout: OUTBOUND_SAFETY_TIMEOUT_MS,
      bodyTimeout: OUTBOUND_SAFETY_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
    })
  );
}
