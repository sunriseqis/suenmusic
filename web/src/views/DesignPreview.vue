<script setup lang="ts">
/**
 * 哑光硬件设计稿（静态）。
 *
 * 这个页面**不依赖任何现有样式**（不用 neu-*、不引 tokens.css），
 * 所有变量都在 `.mh` 作用域内自带一套 —— 目的是先把"设计语言"独立验证，
 * 确认后再决定怎么迁移，避免一边改一边被旧样式污染。
 *
 * 内容：Logo / 播放页 / 迷你播放条 / 首页。
 * 右上角可切换 DARK（哑光黑）与 PAPER（纸白），两套用同一组语义变量。
 */
import { ref } from 'vue';

const theme = ref<'dark' | 'paper'>('dark');
</script>

<template>
  <div class="mh" :class="theme">
    <header class="toolbar">
      <div class="brand">
        <svg class="mark-sm" viewBox="0 0 64 64" aria-hidden="true">
          <rect x="1" y="1" width="62" height="62" rx="15" class="plate" />
          <path
            d="M13 33c6.5 8.5 12.5 8.5 19 0s12.5-8.5 19 0"
            class="groove-deep"
            transform="translate(0 1.2)"
          />
          <path d="M13 33c6.5 8.5 12.5 8.5 19 0s12.5-8.5 19 0" class="groove-edge" />
          <circle cx="13" cy="33" r="2.6" class="dot" />
        </svg>
        <span class="wordmark">SUENMUSIC</span>
      </div>

      <div class="theme-switch" role="group" aria-label="预览主题">
        <button type="button" :class="{ on: theme === 'dark' }" @click="theme = 'dark'">
          DARK
        </button>
        <button type="button" :class="{ on: theme === 'paper' }" @click="theme = 'paper'">
          PAPER
        </button>
      </div>
    </header>

    <main class="stack">
      <!-- ================= 01 Logo ================= -->
      <section class="spec">
        <p class="label">01 — MARK / 三版 S 变体</p>

        <div class="logo-stage">
          <!-- V1 方波：直角 + 平口，像电路走线 / 铣出来的槽 -->
          <div class="logo-cell">
            <svg class="mark-lg" viewBox="0 0 64 64" aria-hidden="true">
              <rect x="1" y="1" width="62" height="62" rx="15" class="plate" />
              <path
                d="M46 17 H26 V32 H46 V47 H20"
                class="groove-deep"
                style="stroke-width: 9"
                stroke-linejoin="miter"
                stroke-linecap="square"
                fill="none"
                transform="translate(0 1.2)"
              />
              <path
                d="M46 17 H26 V32 H46 V47 H20"
                class="groove-edge"
                style="stroke-width: 2"
                stroke-linejoin="miter"
                stroke-linecap="square"
                fill="none"
              />
              <circle cx="20" cy="47" r="2.6" class="dot" />
            </svg>
            <div class="mini-row">
              <svg class="mark-xs" viewBox="0 0 64 64" aria-hidden="true">
                <rect x="1" y="1" width="62" height="62" rx="15" class="plate" />
                <path
                  d="M46 17 H26 V32 H46 V47 H20"
                  class="groove-edge"
                  style="stroke-width: 6"
                  stroke-linejoin="miter"
                  stroke-linecap="square"
                  fill="none"
                />
                <circle cx="20" cy="47" r="4" class="dot" />
              </svg>
            </div>
            <span class="cap">V1 方波 · 64 / 24</span>
          </div>

          <!-- V2 折角：45° 斜接，像折出来的金属件 -->
          <div class="logo-cell">
            <svg class="mark-lg" viewBox="0 0 64 64" aria-hidden="true">
              <rect x="1" y="1" width="62" height="62" rx="15" class="plate" />
              <path
                d="M46 17 H24 L40 30 H20 L36 44 H18"
                class="groove-deep"
                style="stroke-width: 8"
                stroke-linejoin="miter"
                stroke-linecap="square"
                fill="none"
                transform="translate(0 1.2)"
              />
              <path
                d="M46 17 H24 L40 30 H20 L36 44 H18"
                class="groove-edge"
                style="stroke-width: 2"
                stroke-linejoin="miter"
                stroke-linecap="square"
                fill="none"
              />
              <circle cx="18" cy="44" r="2.6" class="dot" />
            </svg>
            <div class="mini-row">
              <svg class="mark-xs" viewBox="0 0 64 64" aria-hidden="true">
                <rect x="1" y="1" width="62" height="62" rx="15" class="plate" />
                <path
                  d="M46 17 H24 L40 30 H20 L36 44 H18"
                  class="groove-edge"
                  style="stroke-width: 5.5"
                  stroke-linejoin="miter"
                  stroke-linecap="square"
                  fill="none"
                />
                <circle cx="18" cy="44" r="4" class="dot" />
              </svg>
            </div>
            <span class="cap">V2 折角 · 64 / 24</span>
          </div>

          <!-- V3 原版：正弦槽，作对照 -->
          <div class="logo-cell">
            <svg class="mark-lg" viewBox="0 0 64 64" aria-hidden="true">
              <rect x="1" y="1" width="62" height="62" rx="15" class="plate" />
              <path
                d="M13 33c6.5 8.5 12.5 8.5 19 0s12.5-8.5 19 0"
                class="groove-deep"
                transform="translate(0 1.2)"
              />
              <path d="M13 33c6.5 8.5 12.5 8.5 19 0s12.5-8.5 19 0" class="groove-edge" />
              <circle cx="13" cy="33" r="2.6" class="dot" />
            </svg>
            <div class="mini-row">
              <svg class="mark-xs" viewBox="0 0 64 64" aria-hidden="true">
                <rect x="1" y="1" width="62" height="62" rx="15" class="plate" />
                <path d="M13 33c6.5 8.5 12.5 8.5 19 0s12.5-8.5 19 0" class="groove-edge thin" />
                <circle cx="13" cy="33" r="3" class="dot" />
              </svg>
            </div>
            <span class="cap">V3 原版 · 64 / 24</span>
          </div>
        </div>

        <div class="lockup-row">
          <div class="lockup">
            <svg class="mark-md" viewBox="0 0 64 64" aria-hidden="true">
              <rect x="1" y="1" width="62" height="62" rx="15" class="plate" />
              <path
                d="M46 17 H26 V32 H46 V47 H20"
                class="groove-edge"
                style="stroke-width: 3.2"
                stroke-linejoin="miter"
                stroke-linecap="square"
                fill="none"
              />
              <circle cx="20" cy="47" r="2.6" class="dot" />
            </svg>
            <div class="lockup-text">
              <span class="wordmark lg">SUENMUSIC</span>
              <span class="tagline">LOCAL FIRST · PLAYER</span>
            </div>
          </div>
          <p class="note tight">
            V1 的直角和平口是"铣"出来的：没有一处圆角，转折用 90°，末端切平。
            V2 把转折换成 45° 斜接，像一个折弯的金属件。
            两者都比正弦槽硬，区别是 V1 更像电路、V2 更像钣金。
          </p>
        </div>
      </section>

      <!-- ================= 02 播放页 ================= -->
      <section class="spec">
        <p class="label">02 — NOW PLAYING</p>

        <div class="phone">
          <div class="player">
            <div class="player-top">
              <button class="ghost" aria-label="收起">
                <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
              </button>
              <span class="eyebrow">PLAYING FROM · 收藏</span>
              <button class="ghost" aria-label="更多">
                <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
              </button>
            </div>

            <div class="art">
              <div class="art-stamp">SUEN</div>
            </div>

            <div class="meta">
              <div class="meta-text">
                <h1 class="title">晴天</h1>
                <p class="artist">周杰伦 · 叶惠美</p>
              </div>
              <button class="heart" aria-label="收藏">
                <svg viewBox="0 0 24 24" class="filled"><path d="M12 20s-7-4.35-7-9.3A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7 3.1C19 15.65 12 20 12 20z" /></svg>
              </button>
            </div>

            <div class="seek">
              <div class="seek-track"><div class="seek-fill"></div><div class="seek-knob"></div></div>
              <div class="seek-time"><span>1:42</span><span>−2:47</span></div>
            </div>

            <div class="transport">
              <button class="ghost" aria-label="播放模式">
                <svg viewBox="0 0 24 24"><path d="M4 8h11l-2.5-2.5M20 16H9l2.5 2.5" /></svg>
              </button>
              <button class="ghost" aria-label="上一首">
                <svg viewBox="0 0 24 24" class="fill"><path d="M7 6h2v12H7zM19 6v12l-9-6z" /></svg>
              </button>
              <button class="key" aria-label="暂停">
                <svg viewBox="0 0 24 24" class="fill amber"><path d="M8 5h3v14H8zM13 5h3v14h-3z" /></svg>
              </button>
              <button class="ghost" aria-label="下一首">
                <svg viewBox="0 0 24 24" class="fill"><path d="M15 6h2v12h-2zM5 6v12l9-6z" /></svg>
              </button>
              <button class="ghost" aria-label="播放队列">
                <svg viewBox="0 0 24 24"><path d="M4 7h11M4 12h11M4 17h7M18 9v8" /></svg>
              </button>
            </div>

            <div class="lyric">
              <p class="lyric-line dim">故事的小黄花</p>
              <p class="lyric-line current">从出生那年就飘着</p>
              <p class="lyric-line dim">童年的荡秋千</p>
            </div>
          </div>
        </div>

        <p class="note">
          播放键是唯一有厚度的元素：面板色 + 1px 内高光，按下位移 1px 并转为内阴影。
          其余控件一律无背景，只靠图标与间距 —— 厚度是稀缺资源，用多了就是旧版的软塑料。
        </p>
      </section>

      <!-- ================= 03 播放条 ================= -->
      <section class="spec">
        <p class="label">03 — MINI BAR</p>

        <div class="bar-wrap">
          <div class="bar">
            <div class="bar-art"></div>
            <div class="bar-text">
              <span class="bar-title">晴天</span>
              <span class="bar-artist">周杰伦</span>
            </div>
            <button class="bar-heart" aria-label="收藏">
              <svg viewBox="0 0 24 24" class="filled"><path d="M12 20s-7-4.35-7-9.3A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7 3.1C19 15.65 12 20 12 20z" /></svg>
            </button>
            <button class="key sm" aria-label="暂停">
              <svg viewBox="0 0 24 24" class="fill amber"><path d="M8 5h3v14H8zM13 5h3v14h-3z" /></svg>
            </button>
          </div>
          <div class="bar-progress"><div class="bar-progress-fill"></div></div>
        </div>

        <p class="note">
          进度条贴在容器下沿而不是浮在中间：它属于"这一屏"，不是条内的控件。
          2px 凹槽 + 琥珀填充，没有圆角光晕。
        </p>
      </section>

      <!-- ================= 04 首页 ================= -->
      <section class="spec">
        <p class="label">04 — HOME</p>

        <div class="phone">
          <div class="home">
            <header class="home-head">
              <div>
                <p class="eyebrow">THURSDAY · 22:41</p>
                <h1 class="home-title">晚上好</h1>
              </div>
              <div class="home-mark">
                <svg viewBox="0 0 64 64" aria-hidden="true">
                  <rect x="1" y="1" width="62" height="62" rx="15" class="plate" />
                  <path d="M13 33c6.5 8.5 12.5 8.5 19 0s12.5-8.5 19 0" class="groove-edge thin" />
                  <circle cx="13" cy="33" r="3" class="dot" />
                </svg>
              </div>
            </header>

            <section class="block">
              <p class="block-head">继续听 <span class="rule"></span></p>
              <div class="resume">
                <div class="resume-art"></div>
                <div class="resume-text">
                  <span class="resume-title">晴天</span>
                  <span class="resume-sub">周杰伦 · 播到 1:42</span>
                  <div class="resume-track"><div class="resume-fill"></div></div>
                </div>
                <button class="key sm" aria-label="继续播放">
                  <svg viewBox="0 0 24 24" class="fill amber"><path d="M8 5l11 7-11 7z" /></svg>
                </button>
              </div>
            </section>

            <section class="block">
              <p class="block-head">最近添加 <span class="rule"></span></p>
              <ul class="rows">
                <li class="row">
                  <span class="idx">01</span>
                  <div class="row-text">
                    <span class="row-title">夜曲</span>
                    <span class="row-sub">周杰伦 · 十一月的萧邦</span>
                  </div>
                  <span class="row-time">3:46</span>
                </li>
                <li class="row">
                  <span class="idx">02</span>
                  <div class="row-text">
                    <span class="row-title">稻香</span>
                    <span class="row-sub">周杰伦 · 魔杰座</span>
                  </div>
                  <span class="row-time">3:43</span>
                </li>
                <li class="row active">
                  <span class="idx">03</span>
                  <div class="row-text">
                    <span class="row-title">晴天</span>
                    <span class="row-sub">周杰伦 · 叶惠美</span>
                  </div>
                  <span class="row-time amber">1:42</span>
                </li>
                <li class="row">
                  <span class="idx">04</span>
                  <div class="row-text">
                    <span class="row-title">七里香</span>
                    <span class="row-sub">周杰伦 · 七里香</span>
                  </div>
                  <span class="row-time">4:59</span>
                </li>
              </ul>
            </section>

            <nav class="nav">
              <button class="nav-item on"><span class="nav-dot"></span>首页</button>
              <button class="nav-item">搜索</button>
              <button class="nav-item">收藏</button>
              <button class="nav-item">设置</button>
            </nav>
          </div>
        </div>

        <p class="note">
          列表用等宽序号代替封面缩略图：这是"曲库"的语言，不是"卡片流"。
          分隔靠 1px 发丝线与 16px 行距，不用阴影分层。
        </p>
      </section>
      <!-- ================= 05 导航 ================= -->
      <section class="spec">
        <p class="label">05 — NAV / 三套导航</p>

        <div class="nav-demos">
          <div class="nav-demo">
            <span class="cap">N1 导轨选择器 · 活动项是滑到位的滑块</span>
            <div class="nav-rail">
              <button class="rail-item on">首页</button>
              <button class="rail-item">搜索</button>
              <button class="rail-item">收藏</button>
              <button class="rail-item">设置</button>
            </div>
          </div>

          <div class="nav-demo">
            <span class="cap">N2 物理键排 · 活动项按下去</span>
            <div class="nav-keys">
              <button class="key-item on">首页</button>
              <button class="key-item">搜索</button>
              <button class="key-item">收藏</button>
              <button class="key-item">设置</button>
            </div>
          </div>

          <div class="nav-demo">
            <span class="cap">N3 指示灯 · 面板上的铭牌 + LED</span>
            <div class="nav-led">
              <button class="led-item on">首页</button>
              <button class="led-item">搜索</button>
              <button class="led-item">收藏</button>
              <button class="led-item">设置</button>
            </div>
          </div>
        </div>

        <p class="note">
          N1 把导航做成一条凹槽导轨，活动项是一个凸起的滑块（带底部琥珀指示条）——
          这是硬件感最强的一套，也最占高度；
          N2 每个都是一枚独立按键，活动项直接"按下去"（位移 1px + 内阴影），
          代价是四枚按键在窄屏上会显得碎；
          N3 最克制：整条只有铭牌和 LED，活动项亮一颗琥珀点，靠字重和亮度区分。
        </p>
      </section>

    </main>
  </div>
</template>

<style scoped>
/* ==========================================================================
   设计变量
   ========================================================================== */
.mh {
  --bg: #0e0f11;
  --panel: #17181b;
  --panel-2: #1d1f23;
  --line: #2a2c30;
  --text: #e9e7e2;
  --dim: #8a8d93;
  --amber: #e8a33d;
  --hi: rgba(255, 255, 255, 0.06);
  --lo: rgba(0, 0, 0, 0.55);
  --shadow-text: 0 1px 0 rgba(0, 0, 0, 0.45);

  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB',
    'Microsoft YaHei', sans-serif;
  font-variant-numeric: tabular-nums;
  padding: 20px 16px 56px;
  box-sizing: border-box;
}

.mh.paper {
  --bg: #f2f0ea;
  --panel: #fffdf8;
  --panel-2: #f7f3ea;
  --line: #dcd6c9;
  --text: #141414;
  --dim: #6d6a63;
  --amber: #b0650f;
  --hi: rgba(255, 255, 255, 0.95);
  --lo: rgba(0, 0, 0, 0.14);
  --shadow-text: none;
}

/* ==========================================================================
   顶部工具条
   ========================================================================== */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mark-sm {
  width: 26px;
  height: 26px;
}
.wordmark {
  font-size: 10px;
  letter-spacing: 0.28em;
  color: var(--dim);
  font-weight: 600;
}
.wordmark.lg {
  font-size: 11px;
}
.theme-switch {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.theme-switch button {
  background: transparent;
  border: 0;
  color: var(--dim);
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 7px 10px;
  font-family: inherit;
  cursor: pointer;
}
.theme-switch button.on {
  color: var(--text);
  background: var(--panel);
  box-shadow: inset 0 1px 0 var(--hi);
}

/* Logo 通用 */
.plate {
  fill: var(--panel);
  stroke: var(--line);
  stroke-width: 1;
}
.groove-deep {
  fill: none;
  stroke: var(--lo);
  stroke-width: 7;
  stroke-linecap: round;
}
.groove-edge {
  fill: none;
  stroke: var(--hi);
  stroke-width: 2.2;
  stroke-linecap: round;
}
.groove-edge.thin {
  stroke-width: 3;
}
.dot {
  fill: var(--amber);
}

/* ==========================================================================
   版面
   ========================================================================== */
.stack {
  display: flex;
  flex-direction: column;
  gap: 44px;
  max-width: 980px;
  margin: 0 auto;
}
.spec {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.label {
  margin: 0;
  font-size: 10px;
  letter-spacing: 0.22em;
  color: var(--dim);
  text-transform: uppercase;
}
.note {
  margin: 0;
  font-size: 12px;
  line-height: 1.75;
  color: var(--dim);
  max-width: 60ch;
}

/* ==========================================================================
   Logo 展示
   ========================================================================== */
.logo-stage {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 28px;
  padding: 26px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: inset 0 1px 0 var(--hi);
}
.logo-cell {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}
.logo-cell.wide {
  align-items: flex-start;
}
.mark-lg {
  width: 76px;
  height: 76px;
}
.mark-md {
  width: 46px;
  height: 46px;
}
.mark-xs {
  width: 26px;
  height: 26px;
}
.cap {
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--dim);
}
.lockup {
  display: flex;
  align-items: center;
  gap: 14px;
}
.lockup-text {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.tagline {
  font-size: 8px;
  letter-spacing: 0.24em;
  color: var(--dim);
}

/* ==========================================================================
   手机画布
   ========================================================================== */
.phone {
  width: 100%;
  max-width: 390px;
  margin: 0 auto;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: var(--bg);
  overflow: hidden;
  box-shadow: inset 0 1px 0 var(--hi);
}

/* ==========================================================================
   播放页
   ========================================================================== */
.player {
  display: flex;
  flex-direction: column;
  padding: 14px 22px 22px;
  gap: 22px;
}
.player-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.eyebrow {
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--dim);
}
.ghost {
  background: transparent;
  border: 0;
  padding: 6px;
  cursor: pointer;
  color: var(--dim);
  display: grid;
  place-items: center;
}
.ghost svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ghost svg.fill,
svg.fill {
  fill: currentColor;
  stroke: none;
}
svg.fill.amber {
  fill: var(--amber);
}

.art {
  aspect-ratio: 1;
  border-radius: 10px;
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--hi);
  position: relative;
  background:
    radial-gradient(
      circle at 50% 50%,
      transparent 0 17%,
      rgba(255, 255, 255, 0.035) 17.4% 18%,
      transparent 18.4% 30%,
      rgba(255, 255, 255, 0.035) 30.4% 31%,
      transparent 31.4% 44%,
      rgba(255, 255, 255, 0.035) 44.4% 45%,
      transparent 45.4%
    ),
    linear-gradient(155deg, #24262b 0%, #141518 62%, #101113 100%);
}
.art-stamp {
  position: absolute;
  left: 14px;
  bottom: 12px;
  font-size: 9px;
  letter-spacing: 0.3em;
  color: var(--dim);
  opacity: 0.7;
}

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: -4px;
}
.title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.artist {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--dim);
}
.heart {
  background: transparent;
  border: 0;
  padding: 6px;
  cursor: pointer;
  color: var(--dim);
}
.heart svg {
  width: 22px;
  height: 22px;
}
.heart .filled {
  fill: var(--amber);
  stroke: none;
}

.seek {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.seek-track {
  height: 2px;
  background: var(--line);
  position: relative;
  border-radius: 1px;
}
.seek-fill {
  width: 42%;
  height: 100%;
  background: var(--amber);
  border-radius: 1px;
}
.seek-knob {
  position: absolute;
  left: 42%;
  top: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--amber);
  transform: translate(-50%, -50%);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 18%, transparent);
}
.seek-time {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--dim);
  letter-spacing: 0.04em;
}

.transport {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}
.key {
  width: 62px;
  height: 62px;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  box-shadow: inset 0 1px 0 var(--hi);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    transform 0.12s ease,
    box-shadow 0.12s ease;
}
.key:active {
  transform: translateY(1px);
  box-shadow: inset 0 2px 7px var(--lo);
}
.key svg {
  width: 22px;
  height: 22px;
}
.key.sm {
  width: 40px;
  height: 40px;
  border-radius: 11px;
}
.key.sm svg {
  width: 16px;
  height: 16px;
}

.lyric {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 6px;
  text-align: center;
}
.lyric-line {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.01em;
  transition: color 0.2s ease;
}
.lyric-line.dim {
  color: var(--dim);
  opacity: 0.55;
}
.lyric-line.current {
  color: var(--amber);
  font-size: 13px;
  font-weight: 600;
}

/* ==========================================================================
   迷你播放条
   ========================================================================== */
.bar-wrap {
  max-width: 390px;
  margin: 0 auto;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
  box-shadow: inset 0 1px 0 var(--hi);
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
}
.bar-art {
  width: 38px;
  height: 38px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: linear-gradient(155deg, #24262b, #131417);
  flex: none;
}
.bar-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.bar-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar-artist {
  font-size: 10px;
  color: var(--dim);
}
.bar-heart {
  background: transparent;
  border: 0;
  padding: 4px;
  color: var(--amber);
  cursor: pointer;
}
.bar-heart svg {
  width: 16px;
  height: 16px;
}
.bar-progress {
  height: 2px;
  background: var(--line);
}
.bar-progress-fill {
  width: 42%;
  height: 100%;
  background: var(--amber);
}

/* ==========================================================================
   首页
   ========================================================================== */
.home {
  display: flex;
  flex-direction: column;
  padding: 20px 20px 0;
  gap: 24px;
  background: var(--bg);
}
.home-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.home-title {
  margin: 8px 0 0;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.home-mark svg {
  width: 30px;
  height: 30px;
  opacity: 0.9;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.block-head {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--dim);
}
.rule {
  flex: 1;
  height: 1px;
  background: var(--line);
}
.resume {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: inset 0 1px 0 var(--hi);
}
.resume-art {
  width: 52px;
  height: 52px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: linear-gradient(155deg, #24262b, #131417);
  flex: none;
}
.resume-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.resume-title {
  font-size: 14px;
  font-weight: 600;
}
.resume-sub {
  font-size: 10px;
  color: var(--dim);
}
.resume-track {
  height: 2px;
  background: var(--line);
  margin-top: 4px;
  border-radius: 1px;
}
.resume-fill {
  width: 42%;
  height: 100%;
  background: var(--amber);
  border-radius: 1px;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 0;
  border-bottom: 1px solid var(--line);
}
.row:last-child {
  border-bottom: 0;
}
.idx {
  width: 20px;
  font-size: 10px;
  color: var(--dim);
  letter-spacing: 0.06em;
}
.row-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.row-title {
  font-size: 14px;
  font-weight: 500;
}
.row-sub {
  font-size: 10px;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-time {
  font-size: 10px;
  color: var(--dim);
}
.row-time.amber {
  color: var(--amber);
}
.row.active .row-title {
  color: var(--amber);
}

.nav {
  display: flex;
  justify-content: space-around;
  border-top: 1px solid var(--line);
  padding: 12px 0 calc(12px + env(safe-area-inset-bottom));
  margin: 8px -20px 0;
  background: var(--panel);
}
.nav-item {
  background: transparent;
  border: 0;
  font-family: inherit;
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--dim);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}
.nav-item.on {
  color: var(--amber);
}
.nav-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--amber);
}

/* ==========================================================================
   Logo 变体补充
   ========================================================================== */
.mini-row {
  display: flex;
  justify-content: center;
}
.lockup-row {
  display: flex;
  align-items: center;
  gap: 26px;
  flex-wrap: wrap;
  padding: 0 18px;
}
.note.tight {
  flex: 1;
  min-width: 240px;
}

/* ==========================================================================
   导航三套
   ========================================================================== */
.nav-demos {
  display: flex;
  flex-direction: column;
  gap: 22px;
  max-width: 390px;
  margin: 0 auto;
  width: 100%;
}
.nav-demo {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

/* N1 导轨 */
.nav-rail {
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--bg);
  box-shadow: inset 0 2px 7px var(--lo);
}
.rail-item {
  flex: 1;
  padding: 12px 0 14px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  color: var(--dim);
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.1em;
  position: relative;
  cursor: pointer;
}
.rail-item.on {
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  box-shadow: inset 0 1px 0 var(--hi);
  color: var(--text);
}
.rail-item.on::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 14px;
  height: 2px;
  background: var(--amber);
  transform: translateX(-50%);
}

/* N2 物理键 */
.nav-keys {
  display: flex;
  gap: 8px;
}
.key-item {
  flex: 1;
  padding: 13px 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  box-shadow: inset 0 1px 0 var(--hi);
  color: var(--dim);
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.1em;
  cursor: pointer;
  transition:
    transform 0.12s ease,
    box-shadow 0.12s ease;
}
.key-item.on {
  transform: translateY(1px);
  box-shadow: inset 0 2px 8px var(--lo);
  color: var(--amber);
  /* 不要琥珀描边：那会变成"聚焦框"，不是"按下去"。厚度差异由内阴影表达 */
  border-color: var(--line);
}

/* N3 指示灯 */
.nav-led {
  display: flex;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}
.led-item {
  flex: 1;
  background: transparent;
  border: 0;
  color: var(--dim);
  font-family: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  position: relative;
  padding-top: 12px;
  cursor: pointer;
}
.led-item::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--line);
  transform: translateX(-50%);
}
.led-item.on {
  color: var(--text);
}
.led-item.on::before {
  background: var(--amber);
  box-shadow: 0 0 7px color-mix(in srgb, var(--amber) 70%, transparent);
}
</style>
