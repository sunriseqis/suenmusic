/**
 * 轻量且安全的 Markdown 转 HTML 格式化器（无外部依赖）。
 * 用于 Web 端渲染音乐画像 summary、AI 导语等文本。
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatInline(str: string): string {
  // 1. 代码 `code`
  let out = str.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  // 2. 加粗 **text** 或 __text__
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // 3. 斜体 *text* 或 _text_
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
  // 4. 删除线 ~~text~~
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

export function renderMarkdown(md: string | null | undefined): string {
  if (!md || !md.trim()) return '';

  const rawLines = md.split(/\r?\n/);
  const htmlParts: string[] = [];

  let inUl = false;
  let inOl = false;
  let inBlockquote = false;

  const closeLists = () => {
    if (inUl) {
      htmlParts.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      htmlParts.push('</ol>');
      inOl = false;
    }
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      htmlParts.push('</blockquote>');
      inBlockquote = false;
    }
  };

  for (const raw of rawLines) {
    const trimmed = (raw || '').trim();

    if (!trimmed) {
      closeLists();
      closeBlockquote();
      continue;
    }

    // 分隔线 --- / ***
    if (/^(---|---|\*\*\*|___)$/.test(trimmed)) {
      closeLists();
      closeBlockquote();
      htmlParts.push('<hr class="md-hr" />');
      continue;
    }

    // 引用 >
    if (trimmed.startsWith('>')) {
      closeLists();
      if (!inBlockquote) {
        htmlParts.push('<blockquote class="md-quote">');
        inBlockquote = true;
      }
      const text = escapeHtml(trimmed.replace(/^>\s*/, ''));
      htmlParts.push(`<p>${formatInline(text)}</p>`);
      continue;
    } else {
      closeBlockquote();
    }

    // 标题 # ~ ####
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch && headerMatch[1] && headerMatch[2]) {
      closeLists();
      const level = Math.min(headerMatch[1].length, 4);
      const text = escapeHtml(headerMatch[2]);
      htmlParts.push(`<h${level} class="md-h${level}">${formatInline(text)}</h${level}>`);
      continue;
    }

    // 无序列表 - / * / •
    const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ulMatch && ulMatch[1]) {
      if (inOl) {
        htmlParts.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        htmlParts.push('<ul class="md-ul">');
        inUl = true;
      }
      const text = escapeHtml(ulMatch[1]);
      htmlParts.push(`<li>${formatInline(text)}</li>`);
      continue;
    }

    // 有序列表 1. / 2.
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch && olMatch[2]) {
      if (inUl) {
        htmlParts.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        htmlParts.push('<ol class="md-ol">');
        inOl = true;
      }
      const text = escapeHtml(olMatch[2]);
      htmlParts.push(`<li>${formatInline(text)}</li>`);
      continue;
    }

    // 普通段落
    closeLists();
    const text = escapeHtml(trimmed);
    htmlParts.push(`<p class="md-p">${formatInline(text)}</p>`);
  }

  closeLists();
  closeBlockquote();

  return htmlParts.join('\n');
}
