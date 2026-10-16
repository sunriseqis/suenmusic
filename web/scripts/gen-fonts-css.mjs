/**
 * 生成 src/styles/fonts.css（包 E）。
 *
 * @fontsource/noto-sans-sc 的官方 css 同时引 woff2 + woff 回退，woff 全量
 * 打进部署包要 9.4MB，而现代浏览器一律走 woff2 —— 这个回退纯属部署包赘肉。
 * 本脚本读包内 400/500/700 的 css，砍掉 woff 引用，url 改写成指向
 * node_modules 的相对路径，产物提交入库。
 *
 * 重装依赖或升级字体包后重跑：npm run gen:fonts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(WEB_ROOT, 'node_modules/@fontsource/noto-sans-sc');
const OUT = join(WEB_ROOT, 'src/styles/fonts.css');

const WEIGHTS = [400, 500, 700];
const BANNER = `/*
 * 思源黑体（Noto Sans SC，SIL OFL）@font-face —— 由 scripts/gen-fonts-css.mjs
 * 生成，**不要手改**：重装依赖或升级字体包后 npm run gen:fonts 重新生成。
 *
 * 与 fontsource 官方 css 的差异：只保留 woff2（woff 回退全量打进部署包
 * 要 9.4MB，现代浏览器一律走 woff2，砍掉）。unicode-range 分片保持原样，
 * 浏览器按页面实际用字按需下载，font-display: swap 加载期不白屏。
 */

`;

let out = BANNER;
for (const w of WEIGHTS) {
  const css = readFileSync(join(PKG, `${w}.css`), 'utf-8');
  const stripped = css
    // 砍掉 woff 回退：woff2 在前，现代浏览器命中第一个 src 就停
    .replace(/,\s*url\(\.\/files\/[^)]*\.woff\)\s*format\('woff'\)/g, '')
    // 相对路径改指向 node_modules（生成的 css 在 src/styles/ 下）
    .replaceAll('url(./files/', 'url(../../node_modules/@fontsource/noto-sans-sc/files/');
  out += `/* ==== weight ${w} ==== */\n${stripped.trim()}\n\n`;
}

writeFileSync(OUT, out, 'utf-8');
const shards = (out.match(/@font-face/g) ?? []).length;
console.log(`fonts.css 已生成：${WEIGHTS.join('/')} 三个字重，${shards} 个 @font-face 分片`);
