"""把生成的「SuenMusic」字标写入前端组件与独立 SVG 文件。

用法：python3 web/scripts/write-wordmark-assets.py
"""
import importlib.util
import subprocess
import sys
from pathlib import Path

# 路径全部由脚本自身位置推算，不写死绝对路径。
# 2026-09-26 之前这里写的是 `/home/suenmusic/...`（NAS 上的路径），换机器即失效；
# 同一轮还把品牌素材从 `android-icon/` 迁到了本仓库的 `docs/icon/`。
HERE = Path(__file__).resolve().parent      # web/scripts
WEB = HERE.parent                           # web/
REPO = WEB.parent                           # 仓库根（suenmusic-server）

SPEC = importlib.util.spec_from_file_location('gw', str(HERE / 'gen-wordmark.py'))
gw = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gw)

WD = str(WEB)
ASSETS = str(REPO / 'docs' / 'icon')
VIEW = None  # 由 to_svg 计算


def build_markup() -> tuple[str, str, str]:
    """返回 (viewBox, 描边路径组, 实心圆点组)。

    必须分两组：i 的点是实心圆，落在 fill="none" 的描边组里会直接消失。
    """
    paths, dots, width = gw.emit('SuenMusic')
    pad = gw.STROKE / 2 + 4
    vb = f"{-pad:.1f} {-pad:.1f} {width + pad * 2:.1f} {44 + pad * 2:.1f}"
    stroke_parts, dot_parts = [], []
    for (ox, d) in paths:
        segs = ' '.join(line.strip() for line in d.strip().split('\n'))
        stroke_parts.append(f'      <path transform="translate({ox:.2f} 0)" d="{segs}" />')
    for (cx, cy, r) in dots:
        dot_parts.append(f'      <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r}" />')
    return vb, '\n'.join(stroke_parts), '\n'.join(dot_parts)


def main():
    vb, stroke_body, dot_body = build_markup()
    w, h = vb.split()[2], vb.split()[3]
    ratio = float(w) / float(h)

    vue = f'''<script setup lang="ts">
/**
 * 字标（2026-09-12 定稿）：统一笔宽的圆头笔画「SuenMusic」。
 *
 * 为什么不用字体：整套品牌里 LOGO 是粗圆头线条，用普通字体的文字配不上它；
 * 而自绘**细**单线字标试过一版、字形不达标。最终走中间路线 ——
 * 保留与图标音浪完全一致的线条语言（统一笔宽 + round cap），字形用几何构造
 * （圆弧/折线），笔画够粗，细节瑕疵在这种风格里不显眼。
 *
 * 拟物处理：不描边不渐变，靠 CSS 的双向 drop-shadow 做「凸起」——
 * 亮侧用 --sl（左上来光）、暗侧用 --sd，与全站拟物语言同一套 token，
 * 因此浅/深色主题自动成立，不需要第二份素材。
 *
 * 源文件与参数在 web/scripts/gen-wordmark.py（改字形后重跑生成）。
 */
withDefaults(defineProps<{{ height?: number }}>(), {{ height: 22 }});
</script>

<template>
  <svg
    class="wordmark"
    :height="height"
    :width="Math.round(height * {ratio:.3f})"
    viewBox="{vb}"
    role="img"
    aria-label="SuenMusic"
  >
    <g fill="none" stroke="currentColor" stroke-width="{gw.STROKE}"
       stroke-linecap="round" stroke-linejoin="round">
{stroke_body}
    </g>
    <g fill="currentColor">
{dot_body}
    </g>
  </svg>
</template>

<style scoped>
.wordmark {{
  display: block;
  flex: none;
  color: var(--t1);
  /* 凸起：亮侧左上来光（--sl）、暗侧右下投影（--sd） */
  filter: drop-shadow(1.1px 1.1px 1.1px var(--sd)) drop-shadow(-1.1px -1.1px 1.1px var(--sl));
}}
</style>
'''
    open(f'{WD}/src/components/brand/WordMark.vue', 'w', encoding='utf8').write(vue)
    print('已写入 src/components/brand/WordMark.vue')

    # 独立 SVG（未来启动页/安卓素材用，固定色）
    for name, color in (('wordmark-light.svg', '#3a4557'), ('wordmark-dark.svg', '#e9edf4')):
        open(f'{ASSETS}/{name}', 'w', encoding='utf8').write(
            gw.to_svg('SuenMusic', color=color)
        )
        print(f'已写入 docs/icon/{name}')


if __name__ == '__main__':
    main()
