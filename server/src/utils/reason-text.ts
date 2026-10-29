/**
 * reason_for_display 长度硬约束（用户口径 12-25 字）：规则写在代码层，不只靠提示词。
 * **含省略号在内总长 ≤ 25**（「…」也占字数，实测 25+…=26 超限）。
 *
 * - 空串 / 纯标点：返回 ''（= 无展示短句，上游按 rejected 处理）；
 * - 不足 12 字：丢弃返回 ''（太短的展示语信息量不够，视为 rejected）；
 * - 超 25 字：**按标点断句优先**截断（宁可少半句也不切在词中），没有可用断点时
 *   硬切到 25 字，收尾补「…」提示有下文 —— 避免「副歌爆」这种语义残缺。
 */
const SENTENCE_END = '，。、；：！？,.;:!?、）」』】…';
const TRAILING_PUNCT = new RegExp('[' + '，。、；：！？,.;:!?' + ']+$');

export function clampDisplay(s: string): string {
  const MAX = 25;
  const MIN = 12;
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const chars = [...t];
  if (chars.length < MIN) return '';
  if (chars.length === MIN) return t; // 12 字整：不要剥尾标点，剥掉就掉到下限以下
  if (chars.length <= MAX) return t.replace(TRAILING_PUNCT, '');
  // 优先找 25 字以内最后一个句读标点作为断点（至少留 MIN 字，太短宁可继续找前面的完整分句）
  let cutAt = -1;
  for (let i = Math.min(MAX, chars.length) - 1; i >= MIN - 1; i -= 1) {
    if (SENTENCE_END.includes(chars[i])) {
      cutAt = i + 1;
      break;
    }
  }
  const cut = cutAt > 0 ? chars.slice(0, cutAt).join('') : chars.slice(0, MAX - 1).join('');
  const cleaned = cut.replace(TRAILING_PUNCT, '');
  if (!cleaned) return '';
  return cleaned + '…'; // 含省略号总长 ≤ MAX
}
