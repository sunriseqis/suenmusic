/**
 * 文本处理工具：清洗 AI 生成内容中的 Markdown 标记与格式符号。
 */

/**
 * 彻底清洗 AI 输出文本中的 Markdown 语法标记（#、##、*、**、`、> 等），返回纯净文本。
 */
export function cleanAiText(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw);

  // 0. 去除模型/网关安全检查与元数据残留（如 "User Safety: safe", "[Safety: safe]" 等）
  s = s.replace(
    /(?:\[|【)?\b(?:user\s+|content\s+|system\s+)?safety(?:\s+(?:assessment|rating|check|status|result))?\s*[:：]\s*(?:safe|pass|ok|clean|neutral|none|true|false)\b[\s,，;；、\-—]*\]?】?/gi,
    ' '
  );

  // 1. 去除代码块与反引号行内代码：```...``` 或 `...`
  s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1');

  // 2. 去除各级 Markdown 标题符号：#、##、### 等（行首或任意位置的哈希符号）
  s = s.replace(/(?:^|\n)\s*#+\s*/g, ' ');
  s = s.replace(/#+/g, '');

  // 3. 去除粗体、斜体、删除线：**text**、*text*、__text__、~~text~~
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/_([^_]+)_/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');

  // 4. 去除引用符号 > 和列表标记 - 或 * 或 1.
  s = s.replace(/(?:^|\n)\s*>\s*/g, ' ');
  s = s.replace(/(?:^|\n)\s*[-*+]\s+/g, ' ');

  // 5. 去除多余括号与引号，规范空白
  s = s.replace(/["“”'‘’]/g, '').replace(/\s+/g, ' ').trim();

  // 6. 去除开头可能残留的孤立无意义标点（如因剔除安全前缀后留下的逗号、冒号、空格等）
  s = s.replace(/^[，,：:;；、\-—\s]+/, '').trim();

  return s;
}
