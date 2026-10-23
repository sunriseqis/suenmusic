#!/usr/bin/env node
/**
 * ArkTS 静态自检（**替代不了编译器，但能抓掉我们来回 90% 的错误类型**）。
 *
 * 背景：本机没有 HarmonyOS SDK（官方 DevEco 只有 Windows/macOS，hvigor 随 IDE 分发，
 * npm/ohpm 上都没有），所以无法在这里编译。但过去十几轮的编译失败几乎全是**静态错误**
 * —— 类型禁则、命名冲突、API 误用 —— 这些不需要 SDK 就能查。
 *
 * 用法：
 *   node scripts/check-arkts.mjs            # 查 hw/entry/src/main/ets
 *   node scripts/check-arkts.mjs --json     # 机器可读
 *
 * 退出码：0 干净 / 1 有 ERROR
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'hw/entry/src/main/ets');
const JSON_OUT = process.argv.includes('--json');

/** ArkUI 内置属性名：struct 成员与它们同名会报「not assignable to base type」 */
const RESERVED_MEMBERS = [
  'position', 'tabIndex', 'width', 'height', 'margin', 'padding', 'border', 'id',
  'key', 'clip', 'scale', 'rotate', 'translate', 'opacity', 'visibility', 'zIndex',
  'align', 'direction', 'flexGrow', 'layoutWeight', 'aspectRatio', 'displayPriority',
];
/** 返回值是 void（不能 .catch）的 AVPlayer 方法 —— 实测 seek/pause/stop 在部分版本如此 */
const VOID_CALLS = ['seek', 'pause', 'stop', 'reset'];
/** 不存在的 API（踩过的） */
const FAKE_APIS = [
  { re: /\.deleteSync\s*\(\s*\)/g, msg: 'request.agent.Task 没有 deleteSync()' },
];
const COLOR_ALLOW = new Set(['#E5484D']); // 项目里唯一允许的颜色字面量（错误色，tokens.css 无此项）

const problems = [];
function report(level, file, line, rule, msg) {
  problems.push({ level, file: relative(ROOT, file), line, rule, msg });
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ets')) out.push(p);
  }
  return out;
}

/**
 * 只剥注释，**保留字符串内容**（路径、颜色、API 名字面量都在字符串里，
 * 全剥掉会让相关规则变成永远不触发的死规则 —— 首版就踩过，险些假绿）。
 */
/**
 * 判断 src[i]（==='/'，且不是 // 与 /*）是否为正则字面量的起点。
 * 经典启发式：看前一个有效字符 —— 出现在「(,=:[!&|?{}; 运算符」或
 * return/typeof 等关键字之后的是正则；出现在标识符/`)` 之后的是除法。
 * 不识别正则的后果（实测，批次C 起误报）：/["“”'‘’]/g 字符类里的引号被
 * 当成字符串起点，扫描器吞掉后面的代码，括号平衡规则成片误报。
 */
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j];
  if ('(,=:[!&|?{};+-*%~^<>'.includes(prev)) return true;
  const tail = src.slice(Math.max(0, j - 6), j + 1);
  if (/(return|typeof|case|delete|void|instanceof|in|of|do|else|new)$/.test(tail)) return true;
  return false;
}

/** 整段跳过一个正则字面量（保留原文：量词里的 {2,3} 本就成对，不影响平衡计数） */
function skipRegex(src, i, out) {
  out += src[i]; i++; // 起始 '/'
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { out += ch; if (i + 1 < src.length) out += src[i + 1]; i += 2; continue; }
    if (ch === '\n') { out += '\n'; i++; break; } // 正则不跨行：防御性退出，避免吞整文件
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) { out += ch; i++; break; }
    out += ch; i++;
  }
  while (i < src.length && /[a-z]/i.test(src[i])) { out += src[i]; i++; } // flags
  return i;
}

function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '/' && isRegexStart(src, i)) { i = skipRegex(src, i, out); continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += q; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += src[i]; i++; }
        out += src[i]; i++;
      }
      out += q; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

/** 剥注释 + 剥字符串内容（结构类规则用，避免字符串里的 {} 干扰） */
function strip(src) {
  const noComments = stripComments(src);
  let out = '';
  let i = 0;
  while (i < noComments.length) {
    const c = noComments[i];
    if (c === '/' && isRegexStart(noComments, i)) { i = skipRegex(noComments, i, out); continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += q; i++;
      while (i < noComments.length && noComments[i] !== q) {
        if (noComments[i] === '\\') i++;
        if (noComments[i] === '\n') out += '\n';
        i++;
      }
      out += q; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

function lineAt(src, index) {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

const files = walk(SRC);

// ---------- 规则 1：import 路径存在 ----------
for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    const tgt = resolve(dirname(f), m[1]);
    if (!existsSync(tgt) && !existsSync(tgt + '.ets')) {
      report('ERROR', f, lineAt(src, m.index), 'import-missing', `import 路径不存在: ${m[1]}`);
    }
  }
}

// ---------- 规则 2：any / unknown ----------
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const src = strip(raw);
  for (const m of src.matchAll(/:\s*(any|unknown)\b/g)) {
    report('ERROR', f, lineAt(src, m.index), 'arkts-no-any-unknown',
      `禁止 ${m[1]}：用显式类型或 Object + as 接口`);
  }
}

// ---------- 规则 3：同一花括号作用域内 const 重复声明 ----------
for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  const lines = src.split('\n');
  /** 作用域栈：每层一个 Set<name> */
  const stack = [new Set()];
  lines.forEach((line, idx) => {
    const m = line.match(/\bconst\s+([A-Za-z_]\w*)\s*[:=]/);
    if (m) {
      const scope = stack[stack.length - 1];
      if (scope.has(m[1])) {
        report('ERROR', f, idx + 1, 'arkts-redeclare',
          `同一作用域内 const ${m[1]} 重复声明（ArkTS: Cannot redeclare block-scoped variable）`);
      } else {
        scope.add(m[1]);
      }
    }
    for (const ch of line) {
      if (ch === '{') stack.push(new Set());
      else if (ch === '}') { if (stack.length > 1) stack.pop(); }
    }
  });
}

// ---------- 规则 4：struct 成员撞 ArkUI 内置属性 ----------
for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  const lines = src.split('\n');
  lines.forEach((line, idx) => {
    const m = line.match(/^\s*@(?:State|StorageLink|StorageProp|Link|Prop|Provide|Consume)\s*(?:\([^)]*\))?\s*(?:@Watch\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[:?]/);
    if (m && RESERVED_MEMBERS.includes(m[1])) {
      report('ERROR', f, idx + 1, 'arkui-reserved-member',
        `成员名 ${m[1]} 与 ArkUI 内置属性同名 → 会报 not assignable to base type，需改名`);
    }
  });
}

// ---------- 规则 5：@Watch 必须紧跟 @StorageLink/@State 之前写法检查 ----------
for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  const lines = src.split('\n');
  lines.forEach((line, idx) => {
    if (/@Watch\s*\(/.test(line) && !/@(?:State|StorageLink|StorageProp|Link|Prop)\s*(?:\([^)]*\))?\s*@Watch/.test(line)) {
      report('WARN', f, idx + 1, 'watch-order',
        '@Watch 应写在 @StorageLink/@State 之后同一行（写成 `@StorageLink(K) @Watch(\'cb\') x`）');
    }
  });
}

// ---------- 规则 6：void 返回值上 .catch ----------
for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/\.(\w+)\s*\([^)]*\)\s*\.catch\s*\(/g)) {
    if (VOID_CALLS.includes(m[1])) {
      report('ERROR', f, lineAt(src, m.index), 'void-catch',
        `.${m[1]}() 在本 SDK 返回 void，不能 .catch() → 改 try/catch`);
    }
  }
}

// ---------- 规则 7：不存在的 API ----------
for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  for (const { re, msg } of FAKE_APIS) {
    for (const m of src.matchAll(re)) {
      report('ERROR', f, lineAt(src, m.index), 'fake-api', msg);
    }
  }
}

// ---------- 规则 8：颜色字面量（Tokens 之外只允许错误色）----------
for (const f of files) {
  if (f.includes('Tokens.ets') || f.includes('NowPlaying.ets') || f.includes('forms/') ||
      f.includes('AVSessionManager.ets') || f.includes('EntryAbility.ets') || f.includes('Index.ets')) continue;
  const src = stripComments(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/'(#[0-9A-Fa-f]{3,8})'/g)) {
    if (!COLOR_ALLOW.has(m[1].toUpperCase())) {
      report('WARN', f, lineAt(src, m.index), 'color-literal',
        `颜色字面量 ${m[1]}：应改为 Tokens.*（唯一例外 #E5484D）`);
    }
  }
}

// ---------- 规则 9：入口页两处一致性 ----------
const mainPages = join(ROOT, 'hw/entry/src/main/resources/base/profile/main_pages.json');
const entryAbility = join(ROOT, 'hw/entry/src/main/ets/entryability/EntryAbility.ets');
if (existsSync(mainPages) && existsSync(entryAbility)) {
  const pages = JSON.parse(readFileSync(mainPages, 'utf8')).src ?? [];
  const ea = stripComments(readFileSync(entryAbility, 'utf8'));
  const m = ea.match(/loadContent\('([^']+)'/);
  const loaded = m ? m[1] : null;
  if (loaded && !pages.includes(loaded)) {
    report('ERROR', entryAbility, lineAt(ea, m.index), 'entry-mismatch',
      `loadContent('${loaded}') 不在 main_pages.json 里 → 白屏 + err.code=401`);
  }
}

// ---------- 规则 10：括号平衡 ----------
for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  const pairs = [['{', '}'], ['(', ')']]; // 不查 []：正则字面量里的方括号无法安全剥离
  for (const [open, close] of pairs) {
    const a = (src.match(new RegExp('\\' + open, 'g')) ?? []).length;
    const b = (src.match(new RegExp('\\' + close, 'g')) ?? []).length;
    if (a !== b) report('ERROR', f, 0, 'unbalanced', `${open}${close} 不配对：${a} vs ${b}`);
  }
}

// ---------- 规则 11：无类型对象字面量（仅 --strict，启发式误报率高）----------
const STRICT = process.argv.includes('--strict');
for (const f of (STRICT ? files : [])) {
  if (f.includes('Index.ets')) continue; // 旧壳不修
  const src = strip(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/(?:return|=)\s*\{[^}\n]*\}/g)) {
    const seg = m[0];
    if (/as\s+[A-Z]/.test(seg)) continue;
    if (/^\s*(?:=|return)\s*\{\s*\}\s*$/.test(seg)) continue;
    report('WARN', f, lineAt(src, m.index), 'obj-literal-as-type',
      '裸对象字面量赋值/返回：ArkTS 要求显式类型或 `as Xxx`（需人工确认）');
  }
}

// ---------- 输出 ----------
const errors = problems.filter(p => p.level === 'ERROR');
const warns = problems.filter(p => p.level === 'WARN');
if (JSON_OUT) {
  console.log(JSON.stringify({ errors, warns }, null, 2));
} else {
  const group = (list, title) => {
    if (list.length === 0) return;
    console.log(`\n${title}（${list.length}）`);
    for (const p of list) {
      console.log(`  ${p.file}:${p.line}  [${p.rule}]  ${p.msg}`);
    }
  };
  group(errors, '✖ ERROR');
  group(warns, '△ WARN');
  console.log(`\n检查 ${files.length} 个 .ets：ERROR ${errors.length}，WARN ${warns.length}`);
  if (errors.length === 0) console.log('✔ 静态检查通过（仍以真机编译为准）');
}
process.exit(errors.length === 0 ? 0 : 1);
