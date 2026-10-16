/**
 * 端到端验收（第一轮「最小可听闭环」）。
 *
 * 一个脚本跑完全流程，自包含、无残留：自己起服务端、起 Vite、起 headless
 * Chrome，跑完断言，`finally` 里全部 kill 掉并删除临时目录。
 *
 * 为什么必须真的驱动浏览器：后端那套断言只能证明"接口返回了正确的 JSON"，
 * 证明不了「点了播放真的出声」「拖到中段真的从那里播」——
 * 前者要 `<audio>` 的 currentTime 真的在走，后者要 Range/206 真的通了。
 * 这两件事只有真跑一遍才知道。
 *
 * 用法：`npm run e2e`（在 web/ 下）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const REPO_ROOT = resolve(WEB_ROOT, '..');

const SERVER_PORT = 3311;
const WEB_PORT = 5373;
const CDP_PORT = 9333;

/**
 * 浏览器可执行文件的发现顺序：
 *   1. 环境变量 `SUENMUSIC_CHROME` 显式指定（CI / 特殊安装布局用）
 *   2. Windows：playwright 装的 chrome-headless-shell（原开发机路径）
 *   3. Linux/macOS：常见命名依次探测，最后回落到 ms-playwright 缓存目录
 * 仓库在 Windows 与 Linux 之间搬过家，路径不能写死成一种。
 */
function findChrome() {
  if (process.env.SUENMUSIC_CHROME) return process.env.SUENMUSIC_CHROME;

  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe')
    );
  } else {
    candidates.push(
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable'
    );
    // playwright 的版本化目录：版本号会变，按前缀扫
    const pwRoot = join(process.env.HOME || '', '.cache/ms-playwright');
    try {
      for (const entry of readdirSync(pwRoot)) {
        if (!entry.startsWith('chromium')) continue;
        candidates.push(
          join(pwRoot, entry, 'chrome-headless-shell-linux64/chrome-headless-shell'),
          join(pwRoot, entry, 'chrome-linux64/chrome'),
          join(pwRoot, entry, 'chrome-linux/chrome')
        );
      }
    } catch {
      /* 没装 playwright 就跳过 */
    }
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return candidates[0] ?? '';
}

const CHROME = findChrome();

const NODE = process.execPath;

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let passed = 0;
let skipped = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}${detail ? `  （${detail}）` : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `  （${detail}）` : ''}`);
  }
}

/**
 * 上游没返回可测数据时用它。
 *
 * 比"假装通过"诚实，也比"直接失败"准确 —— 上游缺数据不是代码缺陷，
 * 但它必须**显式**出现在结果里，不能悄悄溜过去。
 */
function skip(name, reason = '') {
  skipped++;
  console.log(`  skip ${name}${reason ? `  （${reason}）` : ''}`);
}

function section(title) {
  console.log(`\n[${title}]`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 120_000);
    });
  }

  /** 在页面里求值并取回结果。异常会被抛出而不是静默成 undefined */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `页面求值异常：${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`
      );
    }
    return res.result.value;
  }

  /** 轮询直到表达式为真 */
  async waitFor(expression, { timeout = 30_000, interval = 250, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (e) {
        last = `异常：${e.message}`;
      }
      await sleep(interval);
    }
    throw new Error(`等待超时（${timeout}ms）：${label}；最后一次结果 = ${JSON.stringify(last)}`);
  }

  /** 取元素中心坐标并真实点击（合成事件对原生控件不可靠） */
  async click(selector, { nth = 0, offsetRatio = 0.5 } = {}) {
    // 先把元素滚进视口中央再点。
    // 不滚的话，首屏之外的元素算出来的坐标落在视口外，dispatchMouseEvent
    // 会**静默点空**（不报错、不跳转），排查起来像是"功能坏了"。
    await this.evaluate(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
      if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`);
    await sleep(320); // 滚动是异步的，要等它停稳，否则 rect 还是旧的

    const rect = await this.evaluate(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      const el = els[${nth}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);

    if (!rect) {
      // 区分"没这个元素"与"元素在但尺寸为 0" —— 后者是布局 bug 的典型症状
      const exists = await this.evaluate(
        `document.querySelectorAll(${JSON.stringify(selector)}).length`
      );
      const size = await this.evaluate(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      })()`);
      throw new Error(
        `不可点击：${selector}[${nth}] —— 匹配到 ${exists} 个，第 ${nth} 个尺寸 = ${JSON.stringify(size)}`
      );
    }

    const x = rect.x + rect.w * offsetRatio;
    const y = rect.y + rect.h / 2;

    // 坐标越界必须**当场报错**。否则浏览器会安静地忽略这次点击，
    // 而断言在下一句才失败 —— 表现得像"功能坏了"，实际是测试点空了。
    const vp = await this.evaluate(`({ w: innerWidth, h: innerHeight })`);
    if (x < 0 || y < 0 || x > vp.w || y > vp.h) {
      throw new Error(
        `点击坐标落在视口外：${selector}[${nth}] → (${Math.round(x)}, ${Math.round(y)})，视口 ${vp.w}×${vp.h}`
      );
    }

    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      clickCount: 0,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await sleep(40);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    return { x, y, rect };
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
  }
}

// ---------------------------------------------------------------------------
// 进程管理
// ---------------------------------------------------------------------------

const children = [];
let logDir = '';

function start(name, cmd, args, opts = {}) {
  const out = openSync(join(logDir, `${name}.log`), 'a');
  const child = spawn(cmd, args, {
    ...opts,
    // 长驻服务必须把 stdout/stderr 重定向到文件。
    // 用 PIPE 而不读取会把子进程卡死在写日志上（缓冲区写满），
    // 现象是"服务起来了但几个请求后全部超时"，极易误判成后端 bug。
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('error', e => console.log(`  [${name}] 启动失败：${e.message}`));
  children.push(child);
  return child;
}

async function waitForHttp(url, { timeout = 40_000, label = url } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`服务未就绪：${label}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(CHROME)) {
    throw new Error(`找不到 headless Chrome：${CHROME}`);
  }

  logDir = mkdtempSync(join(tmpdir(), 'suenmusic-e2e-logs-'));
  const profileDir = mkdtempSync(join(tmpdir(), 'suenmusic-e2e-profile-'));
  const dbDir = mkdtempSync(join(tmpdir(), 'suenmusic-e2e-db-'));
  const dbPath = join(dbDir, 'e2e.db');

  console.log('临时目录：', { logDir, profileDir, dbPath });

  // ---- 起服务端 ----
  start(
    'server',
    NODE,
    ['--disable-warning=ExperimentalWarning', 'src/index.ts'],
    {
      cwd: join(REPO_ROOT, 'server'),
      env: {
        ...process.env,
        SUENMUSIC_DB: dbPath,
        SUENMUSIC_PORT: String(SERVER_PORT),
        SUENMUSIC_HOST: '127.0.0.1',
        SUENMUSIC_ALLOW_REGISTRATION: '1',
        SUENMUSIC_JWT_SECRET: 'e2e-secret-do-not-use-in-production',
        SUENMUSIC_LOG_LEVEL: 'info',
      },
    }
  );
  await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/api/health`, { label: '服务端' });

  // ---- 起 Vite ----
  start('vite', NODE, ['node_modules/vite/bin/vite.js', '--port', String(WEB_PORT)], {
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      // Vite 的 /api 代理指向这个地址
      SUENMUSIC_BACKEND: `http://127.0.0.1:${SERVER_PORT}`,
    },
  });
  await waitForHttp(`http://127.0.0.1:${WEB_PORT}/`, { label: 'Vite' });

  // ---- 起浏览器 ----
  start(
    'chrome',
    CHROME,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      // 完整版 Chromium（apt 装的）默认带 UI，必须显式无头；
      // chrome-headless-shell 本身就是无头构建，加了反而可能不认识这个开关
      ...(process.platform === 'win32' ? [] : ['--headless=new']),
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--window-size=1440,1000',
      // 无头环境下没有真实用户手势，播放会被自动播放策略拦下。
      // 生产环境不依赖这个标志（用户会真的点一下），这里只是为了让验收能跑。
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    {}
  );

  // 等 CDP 端口
  let target = null;
  {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {
        /* 还没起来 */
      }
      if (!target) await sleep(300);
    }
  }
  if (!target) throw new Error('浏览器 CDP 未就绪');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const APP = `http://127.0.0.1:${WEB_PORT}`;

  // 收集页面控制台错误，最后统一断言"没有未捕获错误"
  const consoleErrors = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown');
    }
  });

  // =========================================================================
  section('1. 启动与登录守卫');
  // =========================================================================

  await cdp.navigate(APP);
  await cdp.waitFor(`!!document.querySelector('.card')`, { label: '登录卡片出现' });

  const landedOnLogin = await cdp.evaluate(`location.pathname`);
  check('未登录访问 / 会被送到 /login', landedOnLogin === '/login', `实际 ${landedOnLogin}`);

  const hasRegisterEntry = await cdp.evaluate(
    `document.body.textContent.includes('注册')`
  );
  check('空库时显示注册入口（首个账号永远可注册）', hasRegisterEntry === true);

  // =========================================================================
  section('2. 注册第一个账号（走界面）');
  // =========================================================================

  // 靠 label 文本定位输入框 —— 走的是可访问性结构，和屏幕阅读器同一套
  const byLabel = label => `(() => {
    const l = [...document.querySelectorAll('label')].find(x => x.textContent.trim().startsWith(${JSON.stringify(label)}));
    return l ? document.getElementById(l.htmlFor) : null;
  })()`;

  const setByLabel = async (label, value) => {
    await cdp.evaluate(`(() => {
      const el = ${byLabel(label)};
      if (!el) throw new Error('找不到字段：' + ${JSON.stringify(label)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  };

  // 切到注册模式
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('注册'));
    if (b) b.click();
    return true;
  })()`);
  await cdp.waitFor(`!!${byLabel('确认口令')}`, { label: '注册表单展开' });

  await setByLabel('用户名', 'e2e');
  await setByLabel('口令', 'e2e-pass-1234');
  await setByLabel('确认口令', 'e2e-pass-1234');

  await cdp.click('button[type="submit"]');

  // 注册成功会跳到首页
  await cdp.waitFor(`location.pathname === '/'`, { label: '注册后进入首页', timeout: 30_000 });
  check('注册后跳转到首页', true);

  const shellIsDesktop = await cdp.evaluate(`!!document.querySelector('.side')`);
  check('桌面视口渲染 DesktopShell（左侧边栏）', shellIsDesktop === true);

  // =========================================================================
  section('3. 首页数据');
  // =========================================================================

  // 首页要么出内容，要么出错误块 —— 两者都要能明确区分
  await cdp.waitFor(
    `!!document.querySelector('.home') &&
     (document.querySelectorAll('.block-title').length > 0 || !!document.querySelector('.state'))`,
    { label: '首页加载完成', timeout: 45_000 }
  );

  const homeState = await cdp.evaluate(`(() => {
    const t = [...document.querySelectorAll('.block-title')].map(e => e.textContent.trim());
    const st = document.querySelector('.state .state-title');
    return { titles: t, stateTitle: st ? st.textContent.trim() : null, text: document.body.innerText.slice(0, 200) };
  })()`);

  check(
    '首页拿到内容或给出明确状态（不是白屏）',
    homeState.titles.length > 0 || !!homeState.stateTitle,
    homeState.titles.length > 0
      ? `区块：${homeState.titles.join(' / ')}`
      : `状态：${homeState.stateTitle}`
  );

  // ---- 首页区块构成 ----
  // 「推荐歌单」「精彩推荐大图」都是**减掉的区块**，也最容易被日后顺手加回来，
  // 所以显式钉住它们不能出现。
  const blocks = await cdp.evaluate(`(() => {
    const q = s => document.querySelector(s);
    const titles = [...document.querySelectorAll('.block-title')].map(e => e.textContent.trim());
    const topText = (q('[data-block="toplists"]') || {}).innerText || '';
    const posters = [...document.querySelectorAll('[data-block="new-albums"] .poster')];
    const strip = posters.length > 0 ? posters[0].parentElement : null;
    const cs = strip ? getComputedStyle(strip) : null;
    return {
      titles,
      hasBanners: !!q('[data-block="banners"]'),
      hasNewSongs: !!q('[data-block="new-songs"]'),
      hasNewAlbums: !!q('[data-block="new-albums"]'),
      hasToplists: !!q('[data-block="toplists"]'),
      newAlbumCards: posters.length,
      // 海报位应当是"横向可滑的一排"，而不是换行的网格
      postersScrollable: !!strip && strip.scrollWidth > strip.clientWidth + 4,
      posterText: posters.length > 0 ? posters[0].innerText.replace(/\\s+/g, ' ').trim() : '',
      // ---- 翻页控件（滚动条已按用户要求隐藏）----
      // 注意：这段代码整体在模板字符串里，注释中不能出现反引号
      stripOverflowX: cs ? cs.overflowX : '',
      // Chrome 121+ 支持 scrollbar-width，隐藏滚动条后应报 none
      stripScrollbarWidth: cs ? cs.scrollbarWidth : '',
      hasNavPrev: !!q('[data-nav="prev"]'),
      hasNavNext: !!q('[data-nav="next"]'),
      navPrevDisabled: !!q('[data-nav="prev"]') && q('[data-nav="prev"]').disabled,
      dotCount: document.querySelectorAll('[data-role="page-dots"] .rail-dot').length,
      pageHint: (q('[data-role="page-hint"]') || {}).textContent
        ? q('[data-role="page-hint"]').textContent.replace(/\\s+/g, ' ').trim()
        : '',
      scrollLeft: strip ? Math.round(strip.scrollLeft) : -1,
      scrollWidth: strip ? strip.scrollWidth : 0,
      clientWidth: strip ? strip.clientWidth : 0,
      toplistCards: document.querySelectorAll('[data-block="toplists"] .grid-btn').length,
      topText,
    };
  })()`);

  check(
    '首页不再出现「推荐歌单」区块',
    !blocks.titles.includes('推荐歌单'),
    `区块：${blocks.titles.join(' / ') || '(无)'}`
  );

  // 「精彩推荐」整块移除：上游 GetFocus 那组运营大图与 Q 音首页真正那栏**对不上**，
  // 真正那栏的数据走加密接口拿不到 —— 拿不到就不摆。顶部改由「新碟首发」担纲。
  check(
    '首页不再有「精彩推荐」大图区块',
    !blocks.hasBanners && !blocks.titles.includes('精彩推荐'),
    `区块：${blocks.titles.join(' / ') || '(无)'}`
  );

  check(
    '首页包含新碟首发 / 新歌首发 / 巅峰榜',
    blocks.hasNewAlbums && blocks.hasNewSongs && blocks.hasToplists,
    `新碟=${blocks.hasNewAlbums} 新歌=${blocks.hasNewSongs} 巅峰榜=${blocks.hasToplists}`
  );

  // 「新碟首发拿到最上面做海报」—— 顺序本身就是这次需求的一部分
  check(
    '新碟首发是首页第一个区块（顶到海报位）',
    blocks.titles[0] === '新碟首发',
    `第一个：${blocks.titles[0] || '(无)'}｜全部：${blocks.titles.join(' / ')}`
  );

  if (blocks.newAlbumCards >= 5) {
    check(
      '新碟海报位是横向可滑的一排（不是换行网格）',
      blocks.postersScrollable && blocks.posterText.length > 0,
      `${blocks.newAlbumCards} 张 · 可横滑=${blocks.postersScrollable} · 首张文案「${blocks.posterText}」`
    );
  } else {
    skip(
      '新碟海报位是横向可滑的一排（不是换行网格）',
      `本次只有 ${blocks.newAlbumCards} 张新碟，凑不满一排（不是缺陷）`
    );
  }

  // ---- 海报位：滚动条按用户要求隐藏，改由显式翻页控件控制 ----
  // 滚动条"看不见"不是靠肉眼判断的：`scrollbar-width: none` 会如实反映在计算样式里，
  // 而且**必须同时**保住 `overflow-x: auto` —— 否则就是靠"压根不能滚"骗过断言。
  if (blocks.newAlbumCards === 0) {
    skip('新碟海报位隐藏了原生滚动条', '上游本次没有返回新碟（不是缺陷）');
    skip('新碟海报位有可用的翻页按钮', '上游本次没有返回新碟（不是缺陷）');
  } else {
    check(
      '新碟海报位隐藏了原生滚动条，但仍可横向滚动',
      blocks.stripOverflowX === 'auto' && blocks.stripScrollbarWidth === 'none',
      `overflow-x=${blocks.stripOverflowX}｜scrollbar-width=${blocks.stripScrollbarWidth}`
    );

    if (!blocks.hasNavPrev || blocks.hasNavNext === false || blocks.dotCount === 0) {
      skip(
        '新碟海报位有可用的翻页按钮',
        `本次 ${blocks.newAlbumCards} 张、内容 ${blocks.scrollWidth}px / 视口 ${blocks.clientWidth}px，`
          + '一屏放得下（不是缺陷）'
      );
    } else {
      check(
        '首屏时「上一批」禁用、指示点与页码都到位',
        blocks.navPrevDisabled && blocks.dotCount >= 2 && blocks.pageHint.includes('/'),
        `上一批禁用=${blocks.navPrevDisabled}｜指示点=${blocks.dotCount}｜页码「${blocks.pageHint}」`
      );

      // 翻页按钮与海报区**零重叠**。
      // 上一版按钮是压在封面上的浮层，用户实测"容易误触点到专辑" ——
      // 这种问题肉眼看是"手感不好"，量化成"重叠像素数"才能钉住。
      const navGeom = await cdp.evaluate(`(() => {
        const s = document.querySelector('[data-block="new-albums"] .posters');
        const prev = document.querySelector('[data-nav="prev"]');
        const next = document.querySelector('[data-nav="next"]');
        if (!s) return null;
        // 量的是**内容区**而不是 .posters 的边框盒：
        // 这个容器带了 -16px 外边距 + 16px 内边距（给卡片抬起的阴影留缓冲），
        // 边框盒比真正显示封面的地方宽 16px，量它会凭空多出 16px "重叠"。
        const rect = e => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right }; };
        const pad = parseFloat(getComputedStyle(s).paddingLeft) || 0;
        const content = { left: rect(s).left + pad, right: rect(s).right - pad };
        const overlap = (a, b) => Math.max(0, a.right - b.left);
        return {
          left: prev ? overlap(rect(prev), content) : 0,
          right: next ? overlap(content, rect(next)) : 0,
        };
      })()`);
      check(
        '翻页按钮与海报区零重叠（不会误触点到专辑）',
        !!navGeom && navGeom.left <= 0.5 && navGeom.right <= 0.5,
        navGeom ? `左侧重叠 ${navGeom.left.toFixed(1)}px｜右侧重叠 ${navGeom.right.toFixed(1)}px` : '量不到'
      );

      // 一屏**正好 4 张，连第 5 张的边都不露**（用户指定）。
      //
      // 必须**按"有任何重叠就算可见"**来数，不能只数"完整可见"：
      // 第一版只数完整可见，结果第 5 张探进来 16px 也照样判 4 张通过 ——
      // 这正是用户肉眼看到、断言却放过去的那次。
      const perPage = await cdp.evaluate(`(() => {
        const s = document.querySelector('[data-block="new-albums"] .posters');
        if (!s) return null;
        const sr = s.getBoundingClientRect();
        const cards = [...s.querySelectorAll('.poster')];
        const inView = c => {
          const r = c.getBoundingClientRect();
          return r.right > sr.left + 0.5 && r.left < sr.right - 0.5;
        };
        const complete = c => {
          const r = c.getBoundingClientRect();
          return r.left >= sr.left - 0.5 && r.right <= sr.right + 0.5;
        };
        return {
          visible: cards.filter(inView).length,
          complete: cards.filter(complete).length,
          total: cards.length,
        };
      })()`);
      check(
        '海报位一屏正好 4 张，且第 5 张一点边都不露',
        !!perPage && perPage.visible === 4 && perPage.complete === 4,
        perPage
          ? `露出过 ${perPage.visible} 张｜完整 ${perPage.complete} 张 / 共 ${perPage.total} 张`
          : '量不到'
      );

      // 真点一次「下一批」：位置必须真的动，页码与高亮指示点要跟着走。
      // 只断言"按钮存在"是不够的 —— 位置算错时按钮照样在，点了却纹丝不动。
      const scrollBefore = blocks.scrollLeft;
      await cdp.click('[data-nav="next"]');
      let paged = null;
      for (let k = 0; k < 20; k++) {
        paged = await cdp.evaluate(`(() => {
          const s = document.querySelector('[data-block="new-albums"] .posters');
          const hint = document.querySelector('[data-role="page-hint"]');
          const prev = document.querySelector('[data-nav="prev"]');
          return {
            left: s ? Math.round(s.scrollLeft) : -1,
            hint: hint ? hint.textContent.replace(/\\s+/g, ' ').trim() : '',
            prevDisabled: prev ? prev.disabled : null,
            onDots: document.querySelectorAll('[data-role="page-dots"] .rail-dot.is-on').length,
          };
        })()`);
        // 必须**同时**等滚动位置与按钮状态都更新完再断言：
        // 滚动是平滑的，而 `posterPage` 更新后还要等 Vue 刷一次 DOM。
        // 只看 scrollLeft 会在 DOM 还没刷新时提前跳出，读到上一页的页码。
        if (paged.left > scrollBefore + 20 && paged.prevDisabled === false) break;
        await sleep(200);
      }

      check(
        '点「下一批」后海报位真的滚动，且页码与高亮指示点同步',
        paged.left > scrollBefore + 20 && paged.prevDisabled === false && paged.onDots === 1,
        `scrollLeft ${scrollBefore} → ${paged.left}｜页码「${paged.hint}」｜高亮指示点 ${paged.onDots} 个`
      );

      // ---- 翻到最后一页，再一路翻回第一页 ----
      // 这是真实踩过的 bug：从末尾往前推一屏落在 488px，而除法算页码会把
      // 488 判成"第 1 页"，于是「上一批」因"已在第一页"被禁用 ——
      // 页码显示 1/3、实际停在中间、按钮按不动，只能刷新。
      // 所以这条必须**真的来回翻一遍**，不能只看按钮在不在。
      const readPager = async () =>
        cdp.evaluate(`(() => {
          const s = document.querySelector('[data-block="new-albums"] .posters');
          const prev = document.querySelector('[data-nav="prev"]');
          const next = document.querySelector('[data-nav="next"]');
          const hint = document.querySelector('[data-role="page-hint"]');
          return {
            left: s ? Math.round(s.scrollLeft) : -1,
            maxScroll: s ? Math.round(s.scrollWidth - s.clientWidth) : -1,
            prevDisabled: prev ? prev.disabled : null,
            nextDisabled: next ? next.disabled : null,
            hint: hint ? hint.textContent.replace(/\\s+/g, ' ').trim() : '',
          };
        })()`);

      await cdp.evaluate(`(() => {
        const s = document.querySelector('[data-block="new-albums"] .posters');
        if (s) s.scrollTo({ left: 0, behavior: 'instant' });
        return 1;
      })()`);
      await sleep(500);
      const startPager = await readPager();

      // 一路往后翻，直到「下一批」自己禁用
      for (let i = 0; i < 8; i++) {
        const s = await readPager();
        if (s.nextDisabled) break;
        await cdp.click('[data-nav="next"]');
        await sleep(800);
      }
      const endPager = await readPager();
      check(
        '能一路翻到最后一页（「下一批」最终自我禁用）',
        endPager.nextDisabled === true && endPager.left >= endPager.maxScroll - 2,
        `scrollLeft ${startPager.left} → ${endPager.left}（可滚到 ${endPager.maxScroll}）｜页码「${endPager.hint}」`
      );

      // 一路往前翻，必须真的回到起点
      for (let i = 0; i < 8; i++) {
        const s = await readPager();
        if (s.prevDisabled && s.left <= startPager.left + 4) break;
        await cdp.click('[data-nav="prev"]');
        await sleep(800);
      }
      const homePager = await readPager();
      check(
        '翻到最后一页后还能一路翻回第一页（位置真的回到起点）',
        homePager.left <= startPager.left + 4 && homePager.prevDisabled === true,
        `起点 ${startPager.left} → 末尾 ${endPager.left} → 回来 ${homePager.left}｜页码「${homePager.hint}」`
      );

      // 回到第一页：后面的断言（点首张打开专辑）要在第 1 页上做。
      // 必须用 instant —— 容器 CSS 是 scroll-behavior: smooth，
      // 用 auto 会平滑滚回去，断言会读到中间态。
      await cdp.evaluate(`(() => {
        const s = document.querySelector('[data-block="new-albums"] .posters');
        if (s) s.scrollTo({ left: 0, behavior: 'instant' });
        return 1;
      })()`);
      await sleep(400);
    }
  }

  check(
    '巅峰榜正好四张且是飙升/热歌/新歌/流行指数',
    blocks.toplistCards === 4 &&
      ['飙升', '热歌', '新歌', '流行指数'].every(n => blocks.topText.includes(n)),
    `${blocks.toplistCards} 张`
  );

  // ---- 新碟首发（顶部海报位）真的能点开专辑页 ----
  if (blocks.newAlbumCards === 0) {
    skip('新碟首发可点开专辑页', '上游本次没有返回新碟（不是缺陷）');
  } else {
    // 封面要**等它真的解码完**再断言：`loading="lazy"` 的图在 DOM 就绪时
    // `naturalWidth` 还是 0，立即读等于把"还没加载完"判成失败。
    // （已单独验过：这 12 张图上游全是 200，不是坏链。）
    let firstAlbum = null;
    for (let k = 0; k < 25; k++) {
      firstAlbum = await cdp.evaluate(`(() => {
        const b = document.querySelector('[data-block="new-albums"] .poster');
        const img = b ? b.querySelector('img') : null;
        const name = b ? b.querySelector('.poster-name') : null;
        const all = [...document.querySelectorAll('[data-block="new-albums"] .poster img')];
        const pr = b ? b.getBoundingClientRect() : null;
        const nr = name ? name.getBoundingClientRect() : null;
        return {
          tagName: b ? b.tagName.toLowerCase() : null,
          label: b ? (b.getAttribute('aria-label') || '') : '',
          // 海报是把标题压在封面上的，所以必须确认那层文字真的渲染出来了
          nameText: name ? name.textContent.trim() : '',
          // 封面是方图，海报块也该是方的 —— 尺寸塌掉不会报错，只会变得没法看
          square: !!pr && pr.width > 80 && Math.abs(pr.width - pr.height) <= 2,
          // 标题必须落在海报**内部**的下缘。父链上哪个 overflow / 尺寸写错，
          // 文字会被挤到容器外面或压成 0 高，这两种失败同样不会报错。
          nameOverlaid:
            !!pr && !!nr && nr.width > 0 && nr.height > 0 &&
            nr.top > pr.top && nr.bottom <= pr.bottom + 1,
          coverLoaded: !!img && img.complete && img.naturalWidth > 0,
          // 顺手记一下取图数量。实测无头视口下 12/12 都会被取到
          // （lazy 的阈值比"严格可视"宽松），
          // 所以这个数字不该用来断言"只加载了前几张"。
          // ⚠️ 这段代码整体在一个模板字符串里，注释里**不能出现反引号**
          // —— 出现即提前截断模板，报的还是"缺右括号"，很难一眼看出原因。
          fetched: all.filter(i => i.complete && i.naturalWidth > 0).length,
          total: all.length,
        };
      })()`);
      if (firstAlbum.tagName === 'button' && firstAlbum.coverLoaded) break;
      await sleep(200);
    }

    check(
      '新碟海报是有 aria-label 的按钮、封面已加载、且标题压在封面上',
      firstAlbum.tagName === 'button' &&
        firstAlbum.label.length > 0 &&
        firstAlbum.coverLoaded &&
        firstAlbum.nameText.length > 0 &&
        firstAlbum.square &&
        firstAlbum.nameOverlaid,
      `${firstAlbum.label}（封面${firstAlbum.coverLoaded ? '已加载' : '未加载'}｜`
        + `压字「${firstAlbum.nameText}」｜方形=${firstAlbum.square}｜`
        + `压字在位=${firstAlbum.nameOverlaid}｜懒加载已取图 ${firstAlbum.fetched}/${firstAlbum.total}）`
    );

    await cdp.click('[data-block="new-albums"] .poster', { nth: 0 });
    await cdp.waitFor(`location.pathname.startsWith('/c/album/')`, {
      label: '新碟跳转',
      timeout: 20_000,
    });
    // ⚠️ 等待条件必须是"加载结束"，不能是"页头出现"：
    // `.kind`（排行榜/专辑/歌单那个角标）在 loading 期间就已经渲染了，
    // 而 `.title` 要等 `v-else` 分支才出现。等 `.kind` 等于没等，
    // 于是偶尔会读到空标题 —— 上游一慢就暴露（本项目反复踩过的"读得太早"）。
    await cdp.waitFor(`!!document.querySelector('.collection .head .title')`, {
      label: '专辑页加载结束（标题节点出现）',
      timeout: 45_000,
    });

    const albumLanding = await cdp.evaluate(`(() => {
      const t = document.querySelector('.collection .head .title');
      const img = document.querySelector('.collection .head img');
      return {
        path: location.pathname,
        title: t ? t.textContent.trim() : '',
        coverLoaded: !!img && img.naturalWidth > 0,
      };
    })()`);

    check(
      '新碟首发点开的是专辑页且标题/封面都不为空',
      albumLanding.path.startsWith('/c/album/') &&
        albumLanding.title.length > 0 &&
        albumLanding.coverLoaded,
      `${albumLanding.path} ·「${albumLanding.title}」`,
    );

    await cdp.evaluate(`history.back()`);
    await cdp.waitFor(`location.pathname === '/'`, { label: '返回首页' });
  }

  // =========================================================================
  section('4. 搜索');
  // =========================================================================

  await cdp.evaluate(`(() => {
    const a = document.querySelector('a[href="/search"]');
    if (a) a.click();
    return true;
  })()`);
  await cdp.waitFor(`location.pathname === '/search'`, { label: '进入搜索页' });

  await cdp.evaluate(`(() => {
    const el = document.querySelector('.bar .inp');
    if (!el) throw new Error('找不到搜索框');
    el.value = '周杰伦';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  // 按回车提交
  await cdp.evaluate(`(() => {
    const el = document.querySelector('.bar .inp');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);

  await cdp.waitFor(
    `document.querySelectorAll('.row').length > 0 ||
     !!document.querySelector('.state .state-title')`,
    { label: '搜索结果出现', timeout: 45_000 }
  );

  const searchState = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.row .name')].map(e => e.textContent.trim());
    const st = document.querySelector('.state .state-title');
    return { count: rows.length, first: rows.slice(0, 3), stateTitle: st ? st.textContent.trim() : null };
  })()`);

  check(
    '搜到曲目',
    searchState.count > 0,
    searchState.count > 0
      ? `${searchState.count} 首，前几首：${searchState.first.join(' / ')}`
      : `状态：${searchState.stateTitle}`
  );

  if (searchState.count === 0) {
    throw new Error(
      `搜索没结果（${searchState.stateTitle}）——无法继续验证播放。若是上游限流，稍后重跑。`
    );
  }

  // 搜索结果的**计数不能把每页条数当总数**：QQ 搜索响应里根本没有总数字段
  // （每个分片只有 list），所以"本次拿到几条"必须标成 `N+`，不能让人误以为就这么多。
  const searchCounts = await cdp.evaluate(`(() => {
    const out = [];
    for (const sec of document.querySelectorAll('.block')) {
      const h = sec.querySelector('.block-title');
      if (!h) continue;
      const badge = h.querySelector('.count');
      if (!badge) continue;
      out.push({
        title: (h.textContent || '').replace(/\\s+/g, ' ').trim(),
        count: (badge.textContent || '').trim(),
      });
    }
    return out;
  })()`);
  // 计数只验**格式**：不能出现"共 N 条"式的断言，因为上游没有总数。
  // "hasMore 与 N+ 是否一致"由 business-test 在服务端证明，这里只管渲染。
  check(
    '搜索结果计数是可信格式（有更多时标 N+，不把每页条数当总数）',
    searchCounts.length > 0 && searchCounts.every(c => /^\d+\+?$/.test(c.count)),
    JSON.stringify(searchCounts)
  );

  // 搜索分页：默认只取第 1 页，点「下一页」才去上游取下一页
  const searchPager = await cdp.evaluate(`(() => {
    const box = document.querySelector('[data-pager="search"]');
    if (!box) return null;
    const next = box.querySelector('button[aria-label="下一页"]');
    return {
      present: true,
      nextDisabled: next ? next.disabled : null,
      hint: (box.querySelector('.pager-hint') || {}).textContent?.trim() || '',
    };
  })()`);
  if (!searchPager || searchPager.nextDisabled) {
    skip('搜索页翻页', searchPager ? '上游本次没有更多结果（不是缺陷）' : '本次结果不足一页');
  } else {
    // 比**行内容**而不是区块文本前缀 —— 区块开头是「单曲 30+」这种标题，
    // 两页都一样，比前缀会得出"数据没换"的错误结论（这一版就踩过）。
    const rowsText = `(() => [...document.querySelectorAll('.row')].slice(0, 3)
      .map(r => (r.textContent || '').replace(/\\s+/g, ' ').trim())
      .join(' | '))()`;
    const before = await cdp.evaluate(rowsText);
    await cdp.click('[data-pager="search"] button[aria-label="下一页"]');
    await sleep(2500);
    const after = await cdp.evaluate(`(() => ({
      rows: [...document.querySelectorAll('.row')].slice(0, 3)
        .map(r => (r.textContent || '').replace(/\\s+/g, ' ').trim())
        .join(' | '),
      hint: (document.querySelector('[data-pager="search"] .pager-hint') || {}).textContent?.trim() || '',
    }))()`);
    check(
      '搜索页点「下一页」后结果真的换了且页码前进',
      after.rows.length > 0 && after.rows !== before && /第\s*2\s*页/.test(after.hint),
      `页码「${searchPager.hint}」→「${after.hint}」｜「${before.slice(0, 30)}」→「${after.rows.slice(0, 30)}」`
    );
  }

  // =========================================================================
  section('5. 播放：真的出声');
  // =========================================================================

  // 点第一行
  await cdp.click('.row', { nth: 0 });

  // 等 <audio> 出现并开始播。解析要走 B 站搜索 + 取流，给足时间
  await cdp.waitFor(`!!document.querySelector('audio[data-suenmusic-audio]')`, {
    label: 'audio 元素创建',
    timeout: 15_000,
  });

  await cdp.waitFor(
    `(() => {
      const a = document.querySelector('audio[data-suenmusic-audio]');
      return a && !a.paused && a.readyState >= 2 && a.currentTime > 0.3;
    })()`,
    { label: '音频开始播放（currentTime 前进）', timeout: 90_000 }
  );

  const t1 = await cdp.evaluate(
    `document.querySelector('audio[data-suenmusic-audio]').currentTime`
  );
  await sleep(1500);
  const t2 = await cdp.evaluate(
    `document.querySelector('audio[data-suenmusic-audio]').currentTime`
  );

  check(
    '音频正在播放（位置随时间前进）',
    t2 > t1 + 0.4,
    `currentTime ${t1.toFixed(2)}s → ${t2.toFixed(2)}s`
  );

  const audioInfo = await cdp.evaluate(`(() => {
    const a = document.querySelector('audio[data-suenmusic-audio]');
    return {
      paused: a.paused,
      readyState: a.readyState,
      duration: a.duration,
      bufferedEnd: a.buffered.length ? a.buffered.end(0) : 0,
      error: a.error ? a.error.code : null,
      src: a.src.replace(/t=[^&]+/, 't=<token>'),
    };
  })()`);

  check('音频无媒体错误', audioInfo.error === null, `error=${audioInfo.error}`);
  check('已缓冲到实际字节（说明流真的在传）', audioInfo.bufferedEnd > 0, `${audioInfo.bufferedEnd.toFixed(2)}s`);
  check(
    'src 指向服务端流代理（不是 B 站裸地址）',
    audioInfo.src.includes('/api/stream/'),
    audioInfo.src
  );

  const uiDuration = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('.progress .t')];
    return els.length ? els[els.length - 1].textContent.trim() : null;
  })()`);
  check('播放条显示了非零总时长（来自 Content-Range）', uiDuration !== '0:00', `显示 ${uiDuration}`);

  // 音源状态灯（包 D）：resolve 响应带 source，播放条封面左下角圆点。
  // 颜色↔来源的映射是纯 CSS 变量，这里断言"存在 + 类名正确 + 静态无动效"。
  // 具体标红还是标粉取决于这首歌实际命中哪个源（网易云匿名也偶尔能命中），
  // 所以不把颜色写死。
  const srcDot = await cdp.evaluate(`(() => {
    const d = document.querySelector('.bar .src-dot');
    return d ? { cls: String(d.className), title: d.title } : null;
  })()`);
  check(
    '播放条封面有音源状态灯（静态，无呼吸动效）',
    !!srcDot && /src-(bilibili|netease)/.test(srcDot.cls) && !srcDot.cls.includes('breathing'),
    JSON.stringify(srcDot)
  );

  // =========================================================================
  section('6. Range / 206');
  // =========================================================================

  const rangeProbe = await cdp.evaluate(`(async () => {
    const a = document.querySelector('audio[data-suenmusic-audio]');
    const res = await fetch(a.src, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
    const cr = res.headers.get('Content-Range');
    const ar = res.headers.get('Accept-Ranges');
    await res.body?.cancel();
    return { status: res.status, contentRange: cr, acceptRanges: ar };
  })()`);

  check('带 Range 请求返回 206', rangeProbe.status === 206, `HTTP ${rangeProbe.status}`);
  check(
    'Content-Range 格式为 bytes 0-0/<总长>',
    typeof rangeProbe.contentRange === 'string' && /^bytes 0-0\/\d+$/.test(rangeProbe.contentRange),
    String(rangeProbe.contentRange)
  );
  check('声明 Accept-Ranges: bytes', rangeProbe.acceptRanges === 'bytes', String(rangeProbe.acceptRanges));

  // =========================================================================
  section('7. 拖动进度条到中段，立刻从该处播');
  // =========================================================================

  const beforeSeek = await cdp.evaluate(`(() => {
    const a = document.querySelector('audio[data-suenmusic-audio]');
    return { cur: a.currentTime, dur: Number.isFinite(a.duration) ? a.duration : 0 };
  })()`);

  // UI 侧总时长（播放条右端，来自服务端 Content-Range）。
  // 上游个别流 <audio>.duration 恒为 NaN/Infinity，但播放照常、seek 照常 ——
  // 判定 seek 是否成功必须用 UI 总时长兜底，否则"明明跳到位了"会被误判成失败
  const totalLabelSec = await cdp.evaluate(`(() => {
    const ts = document.querySelectorAll('.progress .t');
    const raw = ts.length ? ts[ts.length - 1].textContent.trim() : '';
    const m = raw.match(/^(\\d+):(\\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  })()`);

  // 先确认滑动条结构对（原生 range 命中层真的铺满了滑块）
  const sliderInfo = await cdp.evaluate(`(() => {
    const bar = document.querySelector('.progress .slider');
    const nat = bar ? bar.querySelector('.native') : null;
    const rb = bar ? bar.getBoundingClientRect() : null;
    const rn = nat ? nat.getBoundingClientRect() : null;
    return {
      barTag: bar ? bar.tagName : null,
      barSize: rb ? [Math.round(rb.width), Math.round(rb.height)] : null,
      nativeExists: !!nat,
      nativeSize: rn ? [Math.round(rn.width), Math.round(rn.height)] : null,
    };
  })()`);
  check(
    '进度条结构正确且宽度非零（原生 range 命中层铺满滑块）',
    // 宽度也要卡：滑块在 flex 容器里会塌成 0 宽，肉眼看不见也点不到，
    // 而这是纯代码审查看不出来的（实测踩过）
    sliderInfo.nativeExists &&
      sliderInfo.nativeSize &&
      sliderInfo.nativeSize[0] > 20 &&
      sliderInfo.nativeSize[1] > 0,
    JSON.stringify(sliderInfo)
  );

  // 在进度条 70% 处真实点击 —— 原生 range 会跳到对应刻度并触发 change。
  // 点的是滑块容器而不是内部的透明 input：真实鼠标事件由命中测试决定落在
  // 哪个元素上，而 input 本来就铺满整块，所以两者等价但前者更稳。
  await cdp.click('.progress .slider', { offsetRatio: 0.7 });
  await sleep(2500);

  const readPos = `(() => {
    const a = document.querySelector('audio[data-suenmusic-audio]');
    const bar = document.querySelector('.progress .slider');
    const native = bar ? bar.querySelector('.native') : null;
    return {
      cur: a.currentTime,
      // 重解析期间 duration 会短暂变成 NaN；CDP returnByValue 走 JSON 序列化，
      // NaN 会被写成 null，下游 .toFixed 就会崩 —— 在页面里就归成 0
      dur: Number.isFinite(a.duration) ? a.duration : 0,
      paused: a.paused,
      sliderValue: native ? Number(native.value) : null,
    };
  })()`;

  let afterSeek = await cdp.evaluate(readPos);
  const effDur = () => (afterSeek.dur > 0 ? afterSeek.dur : totalLabelSec);
  let ratio = effDur() > 0 ? afterSeek.cur / effDur() : 0;

  /*
   * seek 不生效时先自救一次再判失败。
   *
   * 背景（stash 对照实验定性）：B 站搜索排序随时段变化，匹配到的候选视频
   * 也随之变化；个别视频的音频流对 Range seek 不友好（206 正常但拖动后
   * 位置被拉回开头）。这不是代码回归，是上游候选质量的随机波动。
   * 处置与用户手动行为一致：seek 失败 → 换一条流（令牌置假触发 401 自愈
   * 强制重解析）→ 再 seek。两次都失败才判失败，不掩盖真回归。
   */
  let selfHealed = false;
  if (ratio <= 0.5) {
    await cdp.evaluate(`(() => {
      const a = document.querySelector('audio[data-suenmusic-audio]');
      a.src = a.src.replace(/t=[^&]+/, 't=bogus-seek-retry');
      return 1;
    })()`);
    // 自愈 = error → 重解析 → 重新装载 → 恢复播放，上游慢时不是几秒能等齐的
    try {
      await cdp.waitFor(
        `(() => {
          const a = document.querySelector('audio[data-suenmusic-audio]');
          return a && !a.src.includes('bogus-seek-retry') && !a.paused && a.currentTime > 0.3;
        })()`,
        { label: '自愈换流后恢复播放', timeout: 90_000 }
      );
    } catch {
      /* 没恢复就让下面的断言如实失败 */
    }
    await cdp.click('.progress .slider', { offsetRatio: 0.7 });
    await sleep(2500);
    afterSeek = await cdp.evaluate(readPos);
    ratio = effDur() > 0 ? afterSeek.cur / effDur() : 0;
    selfHealed = true;
  }

  check(
    '拖动后播放位置跳到中后段' + (selfHealed ? '（首轮 seek 不友好，自愈换流后重试通过）' : ''),
    ratio > 0.5,
    `${beforeSeek.cur.toFixed(1)}s → ${afterSeek.cur.toFixed(1)}s / 共 ${(effDur() || 0).toFixed(1)}s（${(ratio * 100).toFixed(0)}%）`
  );

  // 重解析路径里 play() 可能晚于读数：先等出声，再断言"没被暂停"
  try {
    await cdp.waitFor(
      `(() => {
        const a = document.querySelector('audio[data-suenmusic-audio]');
        return a && !a.paused;
      })()`,
      { label: 'seek 后恢复播放', timeout: 15_000 }
    );
  } catch {
    /* 让下面的断言如实失败 */
  }
  afterSeek.paused = await cdp.evaluate(
    `document.querySelector('audio[data-suenmusic-audio]').paused`
  );
  check('拖动后未被暂停', afterSeek.paused === false);

  const t3 = await cdp.evaluate(
    `document.querySelector('audio[data-suenmusic-audio]').currentTime`
  );
  await sleep(1500);
  const t4 = await cdp.evaluate(
    `document.querySelector('audio[data-suenmusic-audio]').currentTime`
  );
  check(
    '拖动后继续播放（位置继续前进）',
    t4 > t3 + 0.4,
    `${t3.toFixed(2)}s → ${t4.toFixed(2)}s`
  );

  // =========================================================================
  section('8. 播放失败自愈（令牌失效 → 重解析）');
  // =========================================================================

  // 把令牌换成假的，等价于"链接过期"：服务端会回 401，
  // audio 触发 error，store 应当 force 重解析并恢复播放
  await cdp.evaluate(`(() => {
    const a = document.querySelector('audio[data-suenmusic-audio]');
    a.src = a.src.replace(/t=[^&]*/, 't=bogus-token-for-e2e');
    a.load();
    a.play().catch(() => {});
    return true;
  })()`);

  await cdp.waitFor(
    `(() => {
      const a = document.querySelector('audio[data-suenmusic-audio]');
      return a && !a.src.includes('bogus-token') && !a.paused && a.currentTime > 0.3;
    })()`,
    { label: '令牌失效后自动重解析并恢复播放', timeout: 90_000 }
  );

  const healed = await cdp.evaluate(`(() => {
    const a = document.querySelector('audio[data-suenmusic-audio]');
    return { src: a.src.replace(/t=[^&]+/, 't=<token>'), paused: a.paused, cur: a.currentTime };
  })()`);
  check('失效令牌被自动换成新地址并恢复播放', true, `${healed.src} @ ${healed.cur.toFixed(2)}s`);

  // =========================================================================
  section('9. 切歌不续播（回归）');
  // =========================================================================

  /**
   * 把播放位置挪到 `targetSec` 并**确认它真的到位**。
   *
   * 流式音频的 seek 是异步的：设完 `currentTime` 要等一次 Range 往返才生效，
   * 在此之前属性值可能原地不动。不确认就往下走，读到的还是原位置 ——
   * 本轮第一版测试正是栽在这里：拿 0.7s 和 0.0s 比较，断言看着通过，
   * 其实什么都没验证。所以这里宁可多花两秒，也要拿到确凿的位置。
   */
  async function seekAhead(targetSec) {
    for (let round = 0; round < 2; round++) {
      // 暂停状态下 seek 最可靠 —— 浏览器不必同时维持播放与重定位
      await cdp.evaluate(`document.querySelector('audio[data-suenmusic-audio]').pause()`);
      await sleep(200);
      for (let attempt = 0; attempt < 5; attempt++) {
        await cdp.evaluate(`(() => {
          const a = document.querySelector('audio[data-suenmusic-audio]');
          a.currentTime = ${targetSec};
          return true;
        })()`);
        for (let k = 0; k < 8; k++) {
          await sleep(250);
          const cur = await cdp.evaluate(
            `document.querySelector('audio[data-suenmusic-audio]').currentTime`
          );
          if (cur > targetSec - 5) return cur;
        }
      }
      if (round === 0) {
        // 这条流对 seek 不友好（已知上游候选波动）：换一条流再试一轮。
        // 令牌置假触发 401 自愈 → force 重解析 → 换到新候选
        await cdp.evaluate(`(() => {
          const a = document.querySelector('audio[data-suenmusic-audio]');
          a.src = a.src.replace(/t=[^&]+/, 't=bogus-seekahead-retry');
          return 1;
        })()`);
        try {
          await cdp.waitFor(
            `(() => {
              const a = document.querySelector('audio[data-suenmusic-audio]');
              return a && !a.src.includes('bogus-seekahead-retry') && !a.paused && a.currentTime > 0.3;
            })()`,
            { label: 'seekAhead 自愈换流', timeout: 90_000 }
          );
        } catch {
          break; // 换流也救不回来，让它走到底部的"如实报错"
        }
      }
    }
    throw new Error(
      `无法把播放位置推到 ${targetSec}s（流式 seek 始终没生效，换流重试也没用），后续基于位置的断言不可信`
    );
  }

  // 用户主动选曲一律从头 —— 播到一半切走、再切回来，期望的是重听。
  // 续播只属于"刷新/重开页面"这一种场景（见 player store 的 restoreSession）。
  //
  // 断言要有区分度，得先让服务端真的记下 A 的一个较大进度。
  await cdp.evaluate(`document.querySelector('audio[data-suenmusic-audio]').play()`);
  await seekAhead(60);
  // 再播一小段并暂停：pause 处理里有一次强制上报（见 player store），
  // 这样服务端记录的才是 60s 附近而不是原点
  await cdp.evaluate(`document.querySelector('audio[data-suenmusic-audio]').play()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('audio[data-suenmusic-audio]').pause()`);
  await sleep(1800); // 给上报请求一点时间

  const beforeSwitch = await cdp.evaluate(`(() => {
    const a = document.querySelector('audio[data-suenmusic-audio]');
    return { cur: a.currentTime, paused: a.paused };
  })()`);
  check(
    '先把 A 的进度推到 60s 并落库（否则"是否续播"没有区分度）',
    beforeSwitch.cur > 50 && beforeSwitch.paused === true,
    `${beforeSwitch.cur.toFixed(1)}s`
  );

  // 暂停时呼吸灯必须停下（animation 只在 playing 时挂）
  {
    const dotCls = await cdp.evaluate(
      `(() => { const d = document.querySelector('.bar .src-dot'); return d ? String(d.className) : null; })()`
    );
    check(
      '暂停时呼吸灯停止呼吸（静态显示）',
      typeof dotCls === 'string' && dotCls !== null && !dotCls.includes('breathing'),
      String(dotCls)
    );
  }

  // 切到第二首
  await cdp.click('.row', { nth: 1 });
  let bStarted = true;
  try {
    await cdp.waitFor(
      `(() => {
        const a = document.querySelector('audio[data-suenmusic-audio]');
        return a && !a.paused && a.currentTime > 0.3;
      })()`,
      { label: '切到第二首后开始播放', timeout: 90_000 }
    );
  } catch {
    bStarted = false;
  }

  if (!bStarted) {
    skip('切回 A 时从头播放', '第二首音源未匹配上，切歌路径这次无法验证');
    // 回到 A，后面小节继续在 A 上做
    await cdp.click('.row', { nth: 0 });
    await cdp.waitFor(
      `(() => {
        const a = document.querySelector('audio[data-suenmusic-audio]');
        return a && !a.paused && a.currentTime > 0.3;
      })()`,
      { label: '回到第一首', timeout: 90_000 }
    );
  } else {
    const trackB = await cdp.evaluate(
      `document.querySelector('audio[data-suenmusic-audio]').currentTime`
    );
    check('切歌成功（第二首开始播）', trackB >= 0, `currentTime ${trackB.toFixed(2)}s`);

    // 再切回 A —— 这里必须从 0 开始，而不是接上刚才的 60s
    await cdp.click('.row', { nth: 0 });
    await cdp.waitFor(
      `(() => {
        const a = document.querySelector('audio[data-suenmusic-audio]');
        return a && !a.paused && a.currentTime > 0.3;
      })()`,
      { label: '切回第一首后开始播放', timeout: 90_000 }
    );

    const backToA = await cdp.evaluate(`(() => {
      const a = document.querySelector('audio[data-suenmusic-audio]');
      return { cur: a.currentTime, paused: a.paused };
    })()`);

    check(
      '切回 A 时从头播放（不接上次的进度）',
      backToA.cur < 10,
      `A 已停留过 ${beforeSwitch.cur.toFixed(1)}s，切回后 currentTime=${backToA.cur.toFixed(2)}s`
    );
  }

  // =========================================================================
  section('9b. 播放控件（包 B）：五态模式 / 队列弹层 / 快速收藏');
  // =========================================================================

  // ---- 五态模式：按钮循环 + localStorage 持久化 ----

  {
    const readModeState = `(() => {
      const btn = document.querySelector('.controls button[aria-label^="播放模式"]');
      return { label: btn ? btn.getAttribute('aria-label') : null, ls: localStorage.getItem('suenmusic.playMode') };
    })()`;

    let modeState = await cdp.evaluate(readModeState);
    check(
      '播放条上有播放模式按钮，初始是顺序播放',
      modeState.label === '播放模式：顺序播放' && (modeState.ls === null || modeState.ls === 'order'),
      `${modeState.label}｜localStorage=${modeState.ls}`
    );

    let modeOk = true;
    const seenModes = [];
    // 初始是顺序播放，点 k 次后的状态就是循环序列的第 k 项；
    // 第 5 次点击绕回顺序播放，不需要额外"归位"
    const expectLabels = ['随机播放', '单曲循环', '列表循环', '随机不重复', '顺序播放'];
    const expectLs = ['shuffle', 'repeat-one', 'list-loop', 'shuffle-once', 'order'];
    for (let k = 0; k < expectLabels.length; k++) {
      await cdp.click('.controls button[aria-label^="播放模式"]');
      await sleep(150); // 等 Vue 刷 DOM 与 localStorage 写入
      modeState = await cdp.evaluate(readModeState);
      const wantLabel = `播放模式：${expectLabels[k]}`;
      if (modeState.label !== wantLabel || modeState.ls !== expectLs[k]) {
        modeOk = false;
        console.log(`  FAIL 第 ${k + 1} 次点击应到「${expectLabels[k]}」，实际 ${modeState.label}｜localStorage=${modeState.ls}`);
      }
      seenModes.push(modeState.label);
    }
    check('点五次按钮，五态循环且每态都写进 localStorage', modeOk, seenModes.join(' → '));
  }

  // ---- 队列弹层：打开 → 当前项高亮 → 跳播 → 关闭 ----
  {
    await cdp.click('button[aria-label="播放队列"]');
    await cdp.waitFor(`!!document.querySelector('.qp-root .panel')`, {
      label: '队列弹层打开', timeout: 5000,
    });

    const queueInfo = await cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('.qp-root .item')];
      const cur = items.findIndex(el => el.classList.contains('current'));
      return { count: items.length, current: cur };
    })()`);
    check(
      '队列弹层显示整个队列且当前项高亮',
      queueInfo.count >= 2 && queueInfo.current >= 0,
      `${queueInfo.count} 首，当前第 ${queueInfo.current + 1} 首`
    );

    // 点队列里另一首（与当前不同的）→ 跳播成功且高亮移动
    const targetIdx = queueInfo.current === 0 ? 1 : 0;
    const targetName = await cdp.evaluate(
      `document.querySelectorAll('.qp-root .item')[${targetIdx}].querySelector('.name').textContent.trim()`
    );
    await cdp.click('.qp-root .item .item-main', { nth: targetIdx });
    await cdp.waitFor(
      `(() => {
        const a = document.querySelector('audio[data-suenmusic-audio]');
        const t = document.querySelector('.bar .title');
        return a && !a.paused && a.currentTime > 0.3 && t && t.textContent.trim() === ${JSON.stringify(targetName)};
      })()`,
      { label: '点击队列项后跳播成功', timeout: 90_000 }
    );
    const afterJump = await cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('.qp-root .item')];
      return { current: items.findIndex(el => el.classList.contains('current')) };
    })()`);
    check(
      '跳播后播放条歌名与队列高亮都换成目标曲',
      afterJump.current === targetIdx,
      `高亮第 ${afterJump.current + 1} 首（目标第 ${targetIdx + 1} 首）`
    );

    await cdp.click('button[aria-label="收起队列"]');
    await cdp.waitFor(`!document.querySelector('.qp-root .panel')`, {
      label: '队列弹层关闭', timeout: 5000,
    });
    check('队列弹层能正常关闭', true);
  }

  // ---- 快速收藏红心：点行尾红心切换，aria-pressed 如实反映 ----
  {
    const heartState = `(() => {
      const btn = document.querySelector('.row .fav');
      return btn ? { pressed: btn.getAttribute('aria-pressed'), label: btn.getAttribute('aria-label') } : null;
    })()`;

    const before = await cdp.evaluate(heartState);
    check('曲目行有快速收藏红心', before !== null, before ? `初始 aria-pressed=${before.pressed}` : '');

    // 收藏
    await cdp.click('.row .fav', { nth: 0 });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('.row .fav'); return b && b.getAttribute('aria-pressed') === 'true'; })()`,
      { label: '红心点亮（已收藏）', timeout: 10_000 }
    );
    // 取消收藏（回滚现场，不污染后续小节与每日推荐种子）
    await cdp.click('.row .fav', { nth: 0 });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('.row .fav'); return b && b.getAttribute('aria-pressed') === 'false'; })()`,
      { label: '再点一次取消收藏', timeout: 10_000 }
    );
    check('红心能收藏也能取消，状态全局一致', true, before ? `初始 ${before.label}` : '');

    // 归位：队列跳播把当前曲目切到了别的歌，而第 10 节的"刷新恢复 A"基线
    // 假设当前曲目就是列表第一行。点回第一行，让快照与基线重新一致
    await cdp.click('.row', { nth: 0 });
    await cdp.waitFor(
      `(() => {
        const a = document.querySelector('audio[data-suenmusic-audio]');
        const t = document.querySelector('.bar .title');
        const rowName = document.querySelector('.row .name');
        return a && !a.paused && a.currentTime > 0.3 && t && rowName && t.textContent.trim() === rowName.textContent.trim();
      })()`,
      { label: '回到第一行曲目（为第 10 节归位）', timeout: 90_000 }
    );
    check('9b 结束时当前曲目已归位到列表第一行', true);
  }

  // =========================================================================
  section('10. 刷新页面后恢复上次曲目（回归）');
  // =========================================================================

  // 续播**只**该发生在这里：刷新 / 重开页面时把上次那首摆回播放条。
  // 与上一节合起来才完整 —— 一边证明"主动选曲不续播"，一边证明"重开还会续"，
  // 缺任何一边都可能把功能改成另一个极端。
  //
  // 上游 seek 波动兜底：个别流 seek 后位置乱跳甚至触发自动切歌（ended →
  // advance），基准就废了。探测后不满足就整轮重试一次，两次都不行再如实失败。
  let beforeReload = { cur: 0, name: '' };
  for (let round = 0; round < 2; round++) {
    await seekAhead(60);
    await cdp.evaluate(`document.querySelector('audio[data-suenmusic-audio]').play()`);
    await sleep(700);
    await cdp.evaluate(`document.querySelector('audio[data-suenmusic-audio]').pause()`);
    await sleep(1800); // 给上报请求留出时间

    beforeReload = await cdp.evaluate(`(() => {
      const a = document.querySelector('audio[data-suenmusic-audio]');
      const t = document.querySelector('.bar .title');
      return { cur: a.currentTime, name: t ? t.textContent.trim() : '' };
    })()`);
    if (beforeReload.cur > 50) break;
    console.log(`  （第 ${round + 1} 轮基准未到位：${beforeReload.cur.toFixed(1)}s，重试）`);
  }

  // 这条是"基准"，本身不测功能，但少了它下面那条比对就可能变成 0 比 0
  check(
    '刷新前 A 停在 60s 附近（恢复断言的基准）',
    beforeReload.cur > 50,
    `${beforeReload.cur.toFixed(1)}s`
  );

  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(1000);
  await cdp.waitFor(
    `(() => {
      const a = document.querySelector('audio[data-suenmusic-audio]');
      return !!a && !!a.src && a.src.includes('/api/stream/');
    })()`,
    { label: '刷新后重新装载并恢复曲目', timeout: 120_000 }
  );

  // 恢复位置的 seek 同样是异步的。这里等它落定，超时也**不**中断 ——
  // 让下面的断言去失败，能给出比"等待超时"更有用的信息（差了多少秒）。
  for (let k = 0; k < 30; k++) {
    const cur = await cdp.evaluate(
      `document.querySelector('audio[data-suenmusic-audio]').currentTime`
    );
    if (cur > beforeReload.cur - 8) break;
    await sleep(500);
  }

  const afterReload = await cdp.evaluate(`(() => {
    const a = document.querySelector('audio[data-suenmusic-audio]');
    const t = document.querySelector('.bar .title');
    return { cur: a.currentTime, paused: a.paused, name: t ? t.textContent.trim() : '' };
  })()`);

  check(
    '刷新后播放条恢复上次的曲目',
    !!afterReload.name && afterReload.name === beforeReload.name,
    `「${afterReload.name}」`
  );
  check(
    '刷新后不会自动出声（等用户点播放）',
    afterReload.paused === true,
    `paused=${afterReload.paused}`
  );
  check(
    '刷新后续播到上次的位置',
    Math.abs(afterReload.cur - beforeReload.cur) < 8,
    `刷新前 ${beforeReload.cur.toFixed(1)}s → 刷新后 ${afterReload.cur.toFixed(1)}s`
  );

  // =========================================================================
  section('10b. 集合页封面与播放器歌手跳转（回归）');
  // =========================================================================

  const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;

  /**
   * 等集合页头部封面**真的**出图。
   *
   * 必须等到 `complete && naturalWidth > 0`：只断言 `<img>` 存在的话，
   * 图片 404 照样通过 —— 元素在，就是不出图，正是这次要防的症状。
   */
  async function waitCover(label) {
    let last = null;
    for (let k = 0; k < 60; k++) {
      last = await cdp.evaluate(`(() => {
        const img = document.querySelector('.collection .head .art img');
        const ph = document.querySelector('.collection .head .art .art-ph');
        return {
          hasImg: !!img,
          complete: img ? img.complete : null,
          width: img ? img.naturalWidth : null,
          src: img ? img.src : null,
          fallbackPlaceholder: !!ph,
        };
      })()`);
      if (last.complete && last.width > 0) return { ok: true, detail: `${last.width}px` };
      await sleep(400);
    }
    return { ok: false, detail: `${label} 未出图：${JSON.stringify(last)}` };
  }

  /**
   * 断言集合页标题不是兜底文案。
   *
   * 「字段名对不上」这类 bug 会**静默**退化成兜底值 ——
   * 页面不报错、骨架也消失，就是内容不对。所以标题必须单独钉住。
   *
   * ⚠️ **必须先等骨架结束**：loading 期间模板走的是 `v-if="loading"` 的骨架分支，
   * `<h1 class="title">` 根本不在 DOM 里，立即读只会拿到 null。
   * （第一次写这条断言就栽在这里：封面断言自带轮询所以通过了，标题却全部报 null。）
   */
  async function readTitle() {
    await cdp.waitFor(`!!document.querySelector('.collection .head .title')`, {
      label: '集合页头部渲染完成（骨架结束）',
      timeout: 30_000,
    });
    return cdp.evaluate(
      `document.querySelector('.collection .head .title').textContent.trim()`
    );
  }

  // ---- 播放器的歌手名必须是真链接 ----
  // 专治「看着能点、实际点不动」：首页焦点图曾经渲染出没有 href 的 <a>，
  // 有 hover、有手型，点了毫无反应。所以要断言 href 本身，而不是"元素存在"。
  const artistLink = await cdp.evaluate(`(() => {
    const a = document.querySelector('.bar .artist a[href]');
    return a ? { href: a.getAttribute('href'), text: a.textContent.trim() } : null;
  })()`);

  check(
    '播放器的歌手名是可跳转的链接',
    !!artistLink && !!artistLink.text && /^\/c\/artist\//.test(artistLink.href || ''),
    artistLink ? `${artistLink.text} → ${artistLink.href}` : '没找到 .bar .artist a[href]'
  );

  if (artistLink) {
    // 真的点一次：证明导航确实发生，而不只是渲染了一个好看的 href
    await cdp.click('.bar .artist a[href]');
    await cdp.waitFor(`location.pathname.startsWith('/c/artist/')`, {
      label: '点歌手名进入歌手页',
      timeout: 30_000,
    });
    const artistPath = await cdp.evaluate(`location.pathname`);
    check('点击歌手名跳转成功', artistPath.startsWith('/c/artist/'), artistPath);

    const artistTitle = await readTitle();
    check('歌手页标题非空', !!artistTitle && artistTitle !== '未找到', `「${artistTitle}」`);

    // 歌手页原本压根没有封面数据源（只有曲目、没有头像）。
    // 现在从召回曲目里就地取 —— 不多打一次上游，也不碰最容易被风控的搜索接口。
    const artistCover = await waitCover('歌手页');
    check('歌手页顶部封面有图', artistCover.ok, artistCover.detail);

    // ---- 歌手页要有专辑列表（用户反馈：详情页只有歌、看不到专辑）----
    // 专辑是**异步补取**的，所以这里要等；等不到要区分"真的没有"和"还没回来"。
    let artistAlbums = null;
    for (let k = 0; k < 30; k++) {
      artistAlbums = await cdp.evaluate(`(() => {
        const box = document.querySelector('[data-block="artist-albums"]');
        if (!box) return { present: false, count: 0, loading: false, first: '' };
        const cards = [...box.querySelectorAll('.grid-btn')];
        return {
          present: true,
          count: cards.length,
          loading: !!box.querySelector('.sk-card'),
          first: cards[0] ? (cards[0].getAttribute('aria-label') || '') : '',
          href: cards[0] ? cards[0].tagName.toLowerCase() : '',
        };
      })()`);
      if (artistAlbums.present && (artistAlbums.count > 0)) break;
      await sleep(400);
    }

    if (!artistAlbums?.present) {
      skip('歌手页有专辑列表', '本次上游没有召回专辑（不是缺陷）');
    } else {
      check(
        '歌手页有专辑列表，且卡片是可点的 button（不是点不动的假链接）',
        artistAlbums.count > 0 &&
          artistAlbums.href === 'button' &&
          artistAlbums.first.includes('打开专辑'),
        `${artistAlbums.count} 张｜首张「${artistAlbums.first}」`
      );
    }

    // ---- 歌手页歌曲分页 ----
    // 召回上限 50 首摊成一页要滚很久（用户反馈）。分页后每页 20 首。
    // 只有"真的超过一页"时才断言，否则跳过并说明。
    const songPager = await cdp.evaluate(`(() => {
      const box = document.querySelector('[data-pager="songs"]');
      if (!box) return { present: false, pages: 0, more: false };
      return {
        present: true,
        pages: box.querySelectorAll('.page-num').length,
        more: !!box.querySelector('[data-role="songs-more"]'),
        rows: document.querySelectorAll('.list .track-row, .list [class*=\"row\"]').length,
      };
    })()`);

    if (!songPager.present) {
      skip('歌手页歌曲分页', '本次召回不足一页（不是缺陷）');
    } else {
      // 真点一次"下一页"：列表内容必须真的换掉，而不是原地不动
      const before = await cdp.evaluate(
        `(() => (document.querySelector('.list')?.textContent || '').trim().slice(0, 12))()`
      );
      await cdp.click('[data-nav="songs-next"]');
      await sleep(600);
      const after = await cdp.evaluate(
        `(() => (document.querySelector('.list')?.textContent || '').trim().slice(0, 12))()`
      );
      check(
        '歌手页歌曲点「下一页」后内容真的换了',
        after !== before && after.length > 0,
        `「${before}」→「${after}」｜共 ${songPager.pages} 页`
      );

      // 「加载更多」是真去上游取下一批：页数必须变多，否则就是白点
      if (songPager.more) {
        const pagesBefore = await cdp.evaluate(
          `(() => document.querySelectorAll('[data-pager=\"songs\"] .page-num').length)()`
        );
        await cdp.click('[data-role="songs-more"]');
        let pagesAfter = pagesBefore;
        for (let k = 0; k < 30; k++) {
          pagesAfter = await cdp.evaluate(
            `(() => document.querySelectorAll('[data-pager=\"songs\"] .page-num').length)()`
          );
          if (pagesAfter > pagesBefore) break;
          await sleep(400);
        }
        check(
          '点「加载更多」后真的抓来了下一批（页码随之增长）',
          pagesAfter > pagesBefore,
          `${pagesBefore} 页 → ${pagesAfter} 页`
        );
      } else {
        skip('歌手页「加载更多」', '上游本次没有更多数据（不是缺陷）');
      }
    }
  } else {
    skip('歌手页封面', '播放器上没有可点的歌手链接，无法取到歌手路由键');
  }

  // ---- 榜单页 ----
  // 榜单详情的 topInfo 曾经把上游字段直接摊开返回，客户端按 `name` / `picUrl`
  // 取值全是 undefined —— 封面空白，标题静默退化成"排行榜"兜底文案。
  await cdp.navigate(`${WEB_BASE}/c/toplist/qq_top_62`);
  await cdp.waitFor(`location.pathname.startsWith('/c/toplist/')`, { label: '进入榜单页' });

  const topTitle = await readTitle();
  check(
    '榜单页标题是真实榜单名（不是兜底文案）',
    !!topTitle && topTitle !== '排行榜' && topTitle !== '未找到',
    `「${topTitle}」`
  );
  const topCover = await waitCover('榜单页');
  check('榜单页顶部封面有图', topCover.ok, topCover.detail);

  // ---- 专辑页 ----
  // 专辑 id 写死一个已知存在的（张国荣《LESLIE CHEUNG 70》）。
  // 从界面点进去要先切到搜索页的"专辑"分片，链路长、还容易被上游限流打乱，
  // 而这条断言要防的是「封面取不到值」，不是「入口点不开」，走直连更干净。
  // 万一这个 id 失效，下面会明确报「专辑页 未出图」，不会静默通过。
  await cdp.navigate(`${WEB_BASE}/c/album/qq_al_003OKWk718UPBD`);
  await cdp.waitFor(`location.pathname.startsWith('/c/album/')`, { label: '进入专辑页' });

  const albumTitle = await readTitle();
  check('专辑页标题非空', !!albumTitle && albumTitle !== '未找到', `「${albumTitle}」`);

  // ---- 专辑介绍：折叠就必须能展开 ----
  // 上一版只有 `max-height + overflow:hidden`，长介绍的后半截**永远看不到**
  // （用户实测反馈）。所以这里要验的是"展开真的能展开"，不是"简介在不在"。
  const descBox = await cdp.evaluate(`(() => {
    const box = document.querySelector('[data-block="description"]');
    if (!box) return null;
    const p = box.querySelector('.desc');
    const btn = box.querySelector('[data-role="desc-toggle"]');
    return {
      present: true,
      height: p ? Math.round(p.getBoundingClientRect().height) : 0,
      clamped: p ? p.classList.contains('is-clamped') : null,
      hasToggle: !!btn,
      label: btn ? (btn.textContent || '').trim() : '',
    };
  })()`);

  if (!descBox?.present) {
    skip('专辑介绍折叠可展开', '这张专辑上游没给简介（不是缺陷）');
  } else if (!descBox.hasToggle) {
    // 短简介本来就不该挂"展开"按钮，挂了才是噪音
    skip('专辑介绍折叠可展开', '简介没有超出折叠高度，无需展开');
  } else {
    check(
      '默认折叠，且展开按钮文案正确',
      descBox.clamped === true && descBox.label.includes('展开'),
      `折叠中=${descBox.clamped}｜按钮「${descBox.label}」`
    );

    await cdp.click('[data-role="desc-toggle"]');
    await sleep(400);
    const expanded = await cdp.evaluate(`(() => {
      const box = document.querySelector('[data-block="description"]');
      const p = box?.querySelector('.desc');
      const btn = box?.querySelector('[data-role="desc-toggle"]');
      return {
        height: p ? Math.round(p.getBoundingClientRect().height) : 0,
        clamped: p ? p.classList.contains('is-clamped') : null,
        label: btn ? (btn.textContent || '').trim() : '',
      };
    })()`);

    check(
      '点「展开」后简介完整显示，按钮变成收起（不是钉死的高度）',
      expanded.height > descBox.height &&
        expanded.clamped === false &&
        expanded.label.includes('收起'),
      `高度 ${descBox.height}px → ${expanded.height}px｜按钮「${expanded.label}」`
    );
  }
  const albumCover = await waitCover('专辑页');
  check('专辑页顶部封面有图', albumCover.ok, albumCover.detail);

  // ---- 版权受限专辑：空曲目要给出**上游原因**，且歌手不能空白 ----
  // 周深《Crush》= 实测的"元信息在、曲目拿不到"专辑（版权限制，totalNum=0）。
  // 上游随时可能改状态，所以先看页面落在哪个分支，只在空态时断言文案。
  // 但空态一旦出现就必须给得出原因 —— 退回"这首歌单已下架"那种瞎猜算退化。
  await cdp.navigate(`${WEB_BASE}/c/album/qq_al_002cGk8c06OfJt`);
  // 注意 `.head .title` 只在 **loading 结束后**才渲染（loading 时是骨架屏），
  // 只等 `.collection .kind` 会在请求还在飞的时候就往下断言 —— 那时页面既没有
  // 空态也没有列表，会被误判成"上游状态变了"，白白跳过一条本该执行的断言。
  await cdp.waitFor(
    `!!document.querySelector('.collection .head .title') || !!document.querySelector('.collection .state')`,
    { label: '进入专辑页（版权受限样本）', timeout: 45_000 }
  );

  const emptyAlbum = await cdp.evaluate(`(() => {
    const box = document.querySelector('[data-block="empty-tracks"]');
    const hint = document.querySelector('[data-block="empty-hint"]');
    const sub = document.querySelector('.collection .head .sub');
    const title = document.querySelector('.collection .head .title');
    const stateTitle = document.querySelector('.collection .state .state-title');
    return {
      isEmpty: !!box,
      hasList: !!document.querySelector('.collection .list'),
      hint: hint ? hint.textContent.trim() : '',
      subtitle: sub ? sub.textContent.trim() : '',
      title: title ? title.textContent.trim() : '',
      stateTitle: stateTitle ? stateTitle.textContent.trim() : '',
    };
  })()`);

  if (emptyAlbum.isEmpty) {
    check(
      '空曲目专辑给的是上游原因（不是"歌单已下架"这类瞎猜）',
      emptyAlbum.hint.length > 0 && !emptyAlbum.hint.includes('这首歌单'),
      `「${emptyAlbum.hint}」`
    );
    check(
      '空曲目专辑页仍能显示歌手（不是空白的 "by "）',
      emptyAlbum.subtitle.length > 0,
      `副标题「${emptyAlbum.subtitle}」`
    );
  } else if (emptyAlbum.hasList) {
    skip(
      '版权受限专辑显示上游原因',
      `该专辑本次取到曲目（上游状态已变更，不是缺陷）：「${emptyAlbum.title}」`
    );
  } else {
    // 既没有空态也没有列表 = 页面根本没渲染出来，这是真失败，不许静默跳过
    check(
      '版权受限专辑页渲染出空态或曲目列表',
      false,
      `标题「${emptyAlbum.title}」状态「${emptyAlbum.stateTitle || '(无)'}」`
    );
  }

  // navigate 是**整页重载**，播放器得从快照恢复。等它回来再往下走，
  // 否则下一节「移动端显示迷你条」会因为"恢复还没完成"而假失败。
  await cdp.waitFor(`!!document.querySelector('.bar .artist a[href]')`, {
    label: '整页重载后播放器恢复当前曲目',
    timeout: 90_000,
  });

  // =========================================================================
  section('10c. 收藏闭环（包 C）：播放条红心 → 收藏页可见 → 取消 → 行消失');
  // =========================================================================

  {
    // 用播放条红心收藏当前曲目（不依赖所在页面有没有曲目行）
    const curName = await cdp.evaluate(
      `document.querySelector('.bar .title')?.textContent.trim() || ''`
    );
    check('收藏闭环有起点（播放条上有一首当前曲目）', !!curName, `「${curName}」`);

    // 防御：若当前曲目已在收藏里（label 是「取消收藏」），跳过收藏动作
    const needFav = await cdp.evaluate(
      `!!document.querySelector('.bar .right button[aria-label="收藏"]')`
    );
    if (needFav) {
      await cdp.click('.bar .right button[aria-label="收藏"]');
      await cdp.waitFor(
        `(() => {
          const b = document.querySelector('.bar .right button[aria-label="取消收藏"]');
          return !!b;
        })()`,
        { label: '播放条红心点亮（label 切到「取消收藏」）', timeout: 10_000 }
      );
    }

    // 进收藏页：导航是 RouterLink，DOM 里有真实 href 可点
    await cdp.click('a[href="/favorites"]');
    await cdp.waitFor(`!!document.querySelector('[data-view="favorites"]')`, {
      label: '进入收藏页', timeout: 10_000,
    });
    await cdp.waitFor(
      `(() => {
        const rows = [...document.querySelectorAll('[data-view="favorites"] .row .name')];
        return rows.some(el => el.textContent.trim() === ${JSON.stringify(curName)});
      })()`,
      { label: '收藏页出现刚收藏的曲目', timeout: 15_000 }
    );

    const favPage = await cdp.evaluate(`(() => {
      const total = document.querySelector('[data-role="fav-total"]')?.textContent.trim() || '';
      const rows = [...document.querySelectorAll('[data-view="favorites"] .row')];
      const hit = rows.find(r => r.querySelector('.fav')?.getAttribute('aria-pressed') === 'true');
      const name = hit ? hit.querySelector('.name')?.textContent.trim() : null;
      return { total, name, rowCount: rows.length };
    })()`);
    check(
      '收藏页显示总数且刚收藏的曲目红心点亮',
      favPage.total === '1' && favPage.name === curName,
      `总数 ${favPage.total}｜命中「${favPage.name ?? '无'}」`
    );

    // 在收藏页点同一行的红心 = 取消收藏 → 行随 store 联动消失
    await cdp.click('[data-view="favorites"] .row .fav', { nth: 0 });
    await cdp.waitFor(
      `!!document.querySelector('[data-role="fav-empty"]')`,
      { label: '取消后行消失并出现空态', timeout: 10_000 }
    );
    check('收藏闭环完整：收藏 → 可见 → 取消 → 消失', true, `「${curName}」已不在收藏页`);

    // 回到首页，不给后面的小节留下意料之外的路由状态
    await cdp.click('a[href="/"]');
    await cdp.waitFor(`!!document.querySelector('[data-block], [data-view]')`, {
      label: '回到首页', timeout: 10_000,
    });
  }

  // =========================================================================
  section('10d. 桌面详情页（包 A）：展开 → 歌词/兜底 → 行点击 seek → ESC 收起');
  // =========================================================================

  {
    // 点封面展开（.now 中心可能落在歌手链接上，所以点封面图 ——
    // 链接点击不能顺带展开详情页，这也是 onNowClick 守卫要防的）
    await cdp.click('.bar .cover img');
    await cdp.waitFor(`!!document.querySelector('[data-view="desktop-full-player"]')`, {
      label: '详情页展开', timeout: 5000,
    });
    check('点播放条封面展开桌面详情页', true);

    // 歌词区：等它从 loading 落到"有行"或"暂无歌词"
    let lyric = null;
    for (let k = 0; k < 20; k++) {
      lyric = await cdp.evaluate(`(() => {
        const box = document.querySelector('[data-view="desktop-full-player"] [data-role="lyrics"]');
        if (!box) return null;
        const rows = [...box.querySelectorAll('.line')];
        if (rows.length) {
          return {
            mode: 'lines',
            count: rows.length,
            hasTrans: rows.some(r => r.querySelector('.l2')),
          };
        }
        if (box.querySelector('[data-role="no-lyric"]')) return { mode: 'empty' };
        return { mode: 'loading' };
      })()`);
      if (lyric && lyric.mode !== 'loading') break;
      await sleep(500);
    }
    check(
      '详情页歌词区有内容（歌词行或明确的暂无提示）',
      !!lyric && lyric.mode !== 'loading',
      JSON.stringify(lyric)
    );

    // 有歌词时：点中段某行 → 真的 seek 过去 + 高亮行落到该行。
    // 不点第一行：LRC 首行时间常在 0s 附近，seek 目标没有区分度
    if (lyric && lyric.mode === 'lines' && lyric.count > 2) {
      const mid = Math.floor(lyric.count / 2);
      const before = await cdp.evaluate(
        `document.querySelector('audio[data-suenmusic-audio]').currentTime`
      );
      await cdp.click('[data-view="desktop-full-player"] [data-role="lyrics"] .line', { nth: mid });
      await sleep(2000);
      const after = await cdp.evaluate(
        `document.querySelector('audio[data-suenmusic-audio]').currentTime`
      );
      check(
        '点击歌词行真的 seek（位置明显变化）',
        Math.abs(before - after) > 1,
        `${before.toFixed(1)}s → ${after.toFixed(1)}s`
      );
      let activeAfter = -2;
      let diag = null;
      for (let k = 0; k < 10; k++) {
        const r = await cdp.evaluate(`(() => {
          const rows = [...document.querySelectorAll('[data-role="lyrics"] .line')];
          const active = rows.findIndex(x => x.classList.contains('active'));
          const audio = document.querySelector('audio[data-suenmusic-audio]');
          const label = document.querySelector('[data-view="desktop-full-player"] .progress .t');
          return {
            active,
            audioCur: audio ? audio.currentTime : null,
            uiPos: label ? label.textContent.trim() : null,
            paused: audio ? audio.paused : null,
          };
        })()`);
        activeAfter = r.active;
        diag = r;
        if (activeAfter === mid) break;
        await sleep(500);
      }
      check(
        `seek 后高亮行落到被点的行（第 ${mid + 1} 行）`,
        activeAfter === mid,
        `active=${activeAfter} diag=${JSON.stringify(diag)}`
      );
    } else if (lyric && lyric.mode === 'lines') {
      skip('点击歌词行 seek', `歌词只有 ${lyric.count} 行，没有可区分的中段行`);
    } else {
      skip('点击歌词行 seek', '该曲目本次没有可用歌词，仅验证兜底展示');
    }

    // ESC 收起（window keydown 监听）
    await cdp.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`
    );
    await cdp.waitFor(
      `!document.querySelector('[data-view="desktop-full-player"]')`,
      { label: 'ESC 收起详情页', timeout: 5000 }
    );
    check('ESC 收起详情页', true);
  }

  // =========================================================================
  section('11. 移动端布局切换');
  // =========================================================================

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(600);

  const mobile = await cdp.evaluate(`(() => ({
    isDesktop: window.matchMedia('(min-width: 1024px)').matches,
    tabbar: !!document.querySelector('.tabbar'),
    sidebar: !!document.querySelector('.side'),
    mini: !!document.querySelector('.mini'),
  }))()`);

  check('窄视口切换到 MobileShell（底部导航）', mobile.tabbar === true && mobile.sidebar === false);
  check('移动端显示迷你播放条', mobile.mini === true);

  // 尺寸也要卡：0 宽/0 高的元素"存在"但点不到（桌面进度条踩过同一个坑）
  const miniRects = await cdp.evaluate(`(() =>
    [...document.querySelectorAll('.mini-dock, .mini')].map(el => {
      const r = el.getBoundingClientRect();
      return { cls: el.className, w: Math.round(r.width), h: Math.round(r.height) };
    })
  )()`);
  check(
    '迷你播放条有可点击尺寸',
    miniRects.every(r => r.w > 20 && r.h > 20),
    JSON.stringify(miniRects)
  );

  // 移动端两种形态的歌手名都要可点 —— 移动端才是这个项目的长期主形态，
  // 只在桌面条上验过，等于移动端将来回归了也没人知道
  const miniArtist = await cdp.evaluate(`(() => {
    const a = document.querySelector('.mini-artist a[href]');
    return a ? a.getAttribute('href') : null;
  })()`);
  check(
    '迷你播放条的歌手名可跳转',
    !!miniArtist && /^\/c\/artist\//.test(miniArtist),
    String(miniArtist)
  );

  // 展开全屏播放页
  await cdp.click('.mini');
  await cdp.waitFor(`!!document.querySelector('.full')`, { label: '全屏播放页展开' });
  // 等进场动画结束再取坐标：`getBoundingClientRect()` 是包含 transform 的，
  // 动画途中元素还在屏幕外，按当时的坐标点击会落空（实测踩过）
  await sleep(800);
  check('迷你条可展开为全屏播放页', true);

  // 封面是网络图片，必须等它真的解码出来再断言，否则 naturalWidth 恒为 0
  let coverLoaded = false;
  let coverSrc = '';
  try {
    coverSrc = await cdp.evaluate(`(() => {
      const img = document.querySelector('.full .face.front img');
      return img ? img.src : '';
    })()`);
    await cdp.waitFor(
      `(() => {
        const img = document.querySelector('.full .face.front img');
        return !!img && img.complete && img.naturalWidth > 0;
      })()`,
      { label: '全屏页封面加载完成', timeout: 20_000 }
    );
    coverLoaded = true;
  } catch {
    coverLoaded = false;
  }

  const fullName = await cdp.evaluate(`(() => {
    const n = document.querySelector('.full .t-name');
    return n ? n.textContent.trim() : null;
  })()`);

  check(
    '全屏播放页显示封面与曲名',
    coverLoaded && !!fullName,
    `${fullName} / 封面${coverLoaded ? '已加载' : '未加载'} ${coverSrc}`
  );

  // 全屏播放页的音源状态灯（包 D）：纯圆点不带文字，颜色类名跟随实际音源
  const srcDotM = await cdp.evaluate(`(() => {
    const d = document.querySelector('.full .src-dot');
    return d ? { title: d.title, cls: String(d.className) } : null;
  })()`);
  check(
    '全屏播放页封面有音源状态灯（无来源文字、无呼吸动效）',
    !!srcDotM && /src-(bilibili|netease)/.test(srcDotM.cls) && !srcDotM.cls.includes('breathing'),
    JSON.stringify(srcDotM)
  );

  // 移动壳补齐（包 A）：歌词 / 模式 / 收藏 / 队列入口
  const mp = await cdp.evaluate(`(() => ({
    lyricLines: document.querySelectorAll('.full [data-role="lyrics"] .line').length,
    noLyric: !!document.querySelector('.full [data-role="no-lyric"]'),
    modeBtn: !!document.querySelector('.full .controls button[aria-label^="播放模式"]'),
    heart: document.querySelector('.full .controls .wing-r button')?.getAttribute('aria-label') || null,
    queueBtn: !!document.querySelector('.full .head button[aria-label="播放队列"]'),
  }))()`);
  check(
    '移动全屏页有歌词区（有行或有暂无提示）',
    mp.lyricLines > 0 || mp.noLyric,
    JSON.stringify(mp)
  );
  check(
    '移动全屏页有播放模式与收藏入口',
    mp.modeBtn && !!mp.heart,
    `heart=${mp.heart}`
  );
  check(
    '移动全屏页有队列入口',
    mp.queueBtn
  );

  // 队列入口真的能开能关（按钮存在 ≠ 能用）
  await cdp.click('.full .head button[aria-label="播放队列"]');
  await cdp.waitFor(`!!document.querySelector('.qp-root .panel')`, {
    label: '移动端队列弹层打开', timeout: 5000,
  });
  await cdp.evaluate(`(() => {
    const b = document.querySelector('.qp-root .head-close');
    if (b) b.click();
    return 1;
  })()`);
  await cdp.waitFor(`!document.querySelector('.qp-root .panel')`, {
    label: '移动端队列弹层关闭', timeout: 5000,
  });
  check('移动端队列弹层能开能关', true);

  const fullArtist = await cdp.evaluate(`(() => {
    const a = document.querySelector('.full .t-artist a[href]');
    return a ? a.getAttribute('href') : null;
  })()`);
  check(
    '全屏播放页的歌手名可跳转',
    !!fullArtist && /^\/c\/artist\//.test(fullArtist),
    String(fullArtist)
  );

  await cdp.click('.full .head .neu-icon-btn');
  await cdp.waitFor(`!document.querySelector('.full')`, {
    label: '全屏播放页收起',
    timeout: 15_000,
  });
  check('全屏播放页可收起', true);

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);

  // =========================================================================
  section('12. 退出与重新登录');
  // =========================================================================

  await cdp.evaluate(`(() => {
    const a = document.querySelector('a[href="/settings"]');
    if (a) a.click();
    return true;
  })()`);
  await cdp.waitFor(`location.pathname === '/settings'`, { label: '进入设置页' });

  const settingsKv = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('.kv li')].map(li => li.textContent.replace(/\\s+/g, ' ').trim());
    const note = document.querySelector('.settings .note');
    const baseUrlShown = document.body.innerText.includes('当前生效');
    return { items, baseUrlShown };
  })()`);
  check(
    '设置页显示服务状态（只读）',
    settingsKv.items.length === 3,
    settingsKv.items.join(' | ')
  );
  check('设置页显示当前生效的基地址', settingsKv.baseUrlShown === true);

  // ---- 音源授权卡片（B 站 + 网易云 双 tab，一张紧凑卡片） ----
  // e2e 用的是全新的库，两个音源都必然落在"未登录"分支：
  // 该看到两个 tab + 当前音源的扫码入口，而不是账号信息。
  const authCard = await cdp.evaluate(`(() => {
    const box = document.querySelector('[data-section="auth"]');
    if (!box) return { present: false };
    const tabs = [...box.querySelectorAll('[data-auth-tab]')];
    return {
      present: true,
      text: box.innerText.replace(/\\s+/g, ' ').trim(),
      tabs: tabs.map(t => ({ key: t.dataset.authTab, active: t.classList.contains('active') })),
      dots: [...box.querySelectorAll('.auth-dot')].map(d => d.classList.contains('on')),
      hasCta: [...box.querySelectorAll('button')].some(b => b.textContent.includes('扫码登录')),
      hasAccount: !!box.querySelector('[data-role="auth-account"]'),
      hasQr: !!box.querySelector('[data-role="auth-qr"]'),
    };
  })()`);

  check(
    '设置页有「音源授权」卡片，BILIBILI / NETEASE 两个 tab',
    authCard.present && authCard.tabs.length === 2 &&
      authCard.tabs.some(t => t.key === 'bilibili') && authCard.tabs.some(t => t.key === 'netease'),
    authCard.tabs.map(t => `${t.key}${t.active ? '(当前)' : ''}`).join(' | ')
  );
  check(
    '两个音源的授权状态点都在（新库下都未授权）',
    authCard.dots.length === 2 && authCard.dots.every(d => d === false),
    authCard.dots.join(',')
  );
  check(
    '默认 tab 未登录时给的是扫码入口，不假装已登录',
    authCard.hasCta && !authCard.hasAccount && !authCard.hasQr,
    authCard.text.slice(0, 80)
  );

  // 真点一次 NETEASE tab：切换后必须真的换成网易云的扫码流程（按钮文案可辨）
  await cdp.evaluate(`(() => {
    const t = document.querySelector('[data-auth-tab="netease"]');
    if (t) t.click();
    return true;
  })()`);
  await sleep(600);
  const neteaseCta = await cdp.evaluate(`(() => {
    const box = document.querySelector('[data-section="auth"]');
    return [...box.querySelectorAll('button')].some(b => b.textContent.includes('扫码登录 NETEASE'));
  })()`);
  check(
    '切到 NETEASE tab 后是网易云自己的扫码入口',
    neteaseCta
  );

  // 真点一次扫码：必须真的换回一张二维码（在 NETEASE tab 上做）。
  // 只断言"按钮在"是不够的 —— 上游挂了按钮照样在，点了毫无反应。
  await cdp.evaluate(`(() => {
    const box = document.querySelector('[data-section="auth"]');
    const b = [...box.querySelectorAll('button')].find(x => x.textContent.includes('扫码登录'));
    if (b) b.click();
    return true;
  })()`);

  let qrState = null;
  for (let k = 0; k < 30; k++) {
    qrState = await cdp.evaluate(`(() => {
      const img = document.querySelector('[data-role="auth-qr"] .auth-qr-img');
      const st = document.querySelector('[data-role="auth-qr-state"]');
      const rect = img ? img.getBoundingClientRect() : null;
      return {
        hasQrBox: !!document.querySelector('[data-role="auth-qr"]'),
        isDataUrl: !!img && img.src.startsWith('data:image/svg+xml;base64,'),
        // complete + naturalWidth>0 才是"图真的解码了"
        decoded: !!img && img.complete && img.naturalWidth > 0,
        // SVG 的 naturalWidth 是它 width 属性里那个 viewBox 尺寸（这里是 49），
        // **不是渲染尺寸**。够不够大能扫，要看盒子 —— 别拿 naturalWidth 当尺寸。
        rendered: rect ? Math.round(rect.width) : 0,
        state: st ? st.textContent.replace(/\\s+/g, ' ').trim() : '',
      };
    })()`);
    if (qrState.decoded) break;
    await sleep(300);
  }

  check(
    '点「扫码登录」后真的换成了一张二维码（内联 SVG、已解码、渲染尺寸够扫）',
    qrState.hasQrBox && qrState.isDataUrl && qrState.decoded && qrState.rendered >= 180,
    `渲染 ${qrState.rendered}px｜${qrState.state}`
  );

  // 收尾：取消掉，别让轮询在后面几十条用例里继续打上游接口
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-role="auth-qr"] button')].find(x => x.textContent.trim() === '取消');
    if (b) b.click();
    return true;
  })()`);
  let cancelled = { gone: false, back: false };
  for (let k = 0; k < 20; k++) {
    cancelled = await cdp.evaluate(`(() => ({
      gone: !document.querySelector('[data-role="auth-qr"]'),
      back: [...document.querySelectorAll('[data-section="auth"] button')].some(b => b.textContent.includes('扫码登录')),
    }))()`);
    if (cancelled.gone) break;
    await sleep(200);
  }
  check(
    '点「取消」后二维码消失、回到扫码入口',
    cancelled.gone && cancelled.back,
    `二维码已消失=${cancelled.gone} 入口回来了=${cancelled.back}`
  );

  // 退出登录
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '退出登录');
    if (b) b.click();
    return true;
  })()`);
  await cdp.waitFor(`location.pathname === '/login'`, { label: '退出后回到登录页', timeout: 15_000 });
  check('退出登录后回到登录页', true);

  const refreshCleared = await cdp.evaluate(`(() => ({
    refresh: localStorage.getItem('suenmusic.refresh'),
    audioSrc: (() => { const a = document.querySelector('audio[data-suenmusic-audio]'); return a ? a.getAttribute('src') : null; })(),
  }))()`);
  check('退出后刷新令牌已从 localStorage 清除', refreshCleared.refresh === null);
  check('退出后播放被停止、地址已清空', !refreshCleared.audioSrc);

  // 重新登录
  await setByLabel('用户名', 'e2e');
  await setByLabel('口令', 'e2e-pass-1234');
  await cdp.click('button[type="submit"]');
  await cdp.waitFor(`location.pathname === '/'`, { label: '重新登录成功', timeout: 30_000 });
  check('用同一账号重新登录成功', true);

  const refreshPersisted = await cdp.evaluate(`!!localStorage.getItem('suenmusic.refresh')`);
  check('登录后刷新令牌已持久化（关掉页面再打开仍保持登录）', refreshPersisted === true);

  // 刷新页面，验证静默续期
  await cdp.navigate(APP + '/');
  await cdp.waitFor(`location.pathname === '/' && !!document.querySelector('.side')`, {
    label: '刷新后仍保持登录',
    timeout: 30_000,
  });
  check('刷新浏览器后保持登录（静默续期生效）', true);

  // =========================================================================
  section('13. 主题切换');
  // =========================================================================

  /*
   * 断言的是**主题模式**而不是 data-theme 属性。
   *
   * 因为「跟随系统」在无头环境下解析出来就是 light，第一次点击
   * （跟随系统 → 浅色）属性值不变 —— 那是正确行为，不是 bug。
   * 用属性值断言会把正确实现判成失败。
   */
  const storedMode = () =>
    cdp.evaluate(`localStorage.getItem('suenmusic.theme')`);

  const m0 = await storedMode();
  await cdp.click('.foot .neu-icon-btn');
  await sleep(350);
  const m1 = await storedMode();
  await cdp.click('.foot .neu-icon-btn');
  await sleep(350);
  const m2 = await storedMode();
  const attr2 = await cdp.evaluate(`document.documentElement.dataset.theme`);

  check(
    '主题按钮按「跟随系统 → 浅色 → 深色」循环',
    m1 === 'light' && m2 === 'dark',
    `${m0 ?? '（未设置，等价 system）'} → ${m1} → ${m2}`
  );

  check('切到深色后 data-theme 同步为 dark', attr2 === 'dark', String(attr2));

  // =========================================================================
  section('14. 无未捕获异常');
  // =========================================================================

  // 音频资源加载失败（我们故意造的 401）不算代码缺陷，过滤掉
  const realErrors = consoleErrors.filter(
    e => !/Failed to load resource|MediaError|media resource|net::ERR/i.test(e)
  );
  check('页面无未捕获的 JS 异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  ws.close();
}

// ---------------------------------------------------------------------------

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.log(`\n中断：${e.message}`);
  exitCode = 1;
} finally {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
  await sleep(300);

  // 失败时保留子进程日志 —— 那是排查的唯一线索；成功才清理
  if (exitCode === 0) {
    try {
      rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  } else {
    console.log(`\n子进程日志保留在：${logDir}`);
  }
}

console.log('\n' + '='.repeat(60));
const skipNote = skipped > 0 ? `，跳过 ${skipped} 项` : '';
if (failures.length === 0 && exitCode === 0) {
  console.log(`端到端验收通过：${passed} 项成功${skipNote}`);
} else {
  console.log(`端到端验收失败：通过 ${passed} 项，失败 ${failures.length} 项${skipNote}`);
  for (const f of failures) console.log(`  - ${f}`);
  exitCode = 1;
}
process.exit(exitCode);
