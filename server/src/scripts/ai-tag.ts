/**
 * 曲目打标（AI 受控标签）批处理。
 *
 * 用法：
 *   npm run ai:tag -- 60      # 打 60 首（先标收藏里的）
 *   npm run ai:tag            # 默认 30 首
 *
 * 输出里会给出"被丢弃的词表外标签" —— 那是模型是否听话的直接证据。
 */
import { tagTracks } from '../services/ai-tags.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('ai-tag');

async function main(): Promise<void> {
  const limit = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) ?? 30);
  const t0 = Date.now();
  const stats = await tagTracks(limit);
  log.info(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (stats.rejectedInstrumental.length > 0) {
    const uniq = [...new Set(stats.rejectedInstrumental)];
    log.warn(`器乐维度越界值 ${stats.rejectedInstrumental.length} 次（去重 ${uniq.length} 个）：${uniq.join('、')}`);
  }
  if (stats.rejectedStyles.length > 0) {
    const uniq = [...new Set(stats.rejectedStyles)];
    log.warn(`模型越界造词 ${stats.rejectedStyles.length} 次（去重 ${uniq.length} 个）：${uniq.join('、')}`);
  }
  process.exit(0);
}

void main();
