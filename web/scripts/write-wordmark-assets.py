"""把生成的「SuenMusic」折角字标写入前端组件与独立 SVG 文件。

用法：python3 web/scripts/write-wordmark-assets.py
"""
import importlib.util
from pathlib import Path

# 路径全部由脚本自身位置推算，不写死绝对路径。
HERE = Path(__file__).resolve().parent      # web/scripts
WEB = HERE.parent                           # web/
REPO = WEB.parent                           # 仓库根

SPEC = importlib.util.spec_from_file_location('gw', str(HERE / 'gen-wordmark-angular.py'))
gw = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gw)

WD = str(WEB)
ASSETS = str(REPO / 'docs' / 'icon')


def main():
    vb, body, dots = gw.build_markup('SuenMusic')
    w, h = vb.split()[2], vb.split()[3]
    ratio = float(w) / float(h)

    vue = f'''<script setup lang="ts">
/**
 * 字标（2026-10-20 重画）：折角钣金「SuenMusic」，与 MarkBold 同一语言。
 *
 * 与旧版（2026-09-12 圆头描边）的区别：
 *   · 实心笔画 —— 每条骨架线由 stroker 生成多边形，不再是 stroke
 *   · 端头 45° 切角、转角尖接，全部直线段，没有圆弧
 * 这样它和侧边栏那枚实心折角 S 是同一套钣金语言。
 *
 * 拟物处理：不描边不渐变，靠 CSS 的双向 drop-shadow 做「凸起」——
 * 亮侧用 --sl（左上来光）、暗侧用 --sd，与全站拟物语言同一套 token，
 * 因此浅/深色主题自动成立，不需要第二份素材。
 *
 * 源文件与参数在 web/scripts/gen-wordmark-angular.py（改字形后重跑
 * write-wordmark-assets.py 生成本文件与 docs/icon 资产）。
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
    <g fill="currentColor">
{body}
{dots}
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


if __name__ == "__main__":
    main()
