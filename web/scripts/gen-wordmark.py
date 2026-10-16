"""生成「SuenMusic」圆头笔画字标（矢量路径）。

设计约束（与 LOGO 对齐）：
  · 统一笔宽 + 圆头圆角 —— 和图标音浪同一种线条语言
  · 几何化字形：o/u/e/c 都是正圆弧，M 是折线，S/s 是双弧
  · 基线 y=36，大写高 32（y 4→36），x 高 20（y 16→36），圆弧上下各溢出 1.5

用法：python3 gen-wordmark.py   → 输出 SVG 到 stdout（便于先看效果）
"""
STROKE = 8.0          # 笔宽
TRACK = 7.0           # 字距
XS, BS = 16.0, 36.0   # x 高顶 / 基线
CT = 4.0              # 大写顶

# 每个字形：宽度 + 路径（本地坐标，起点在字形的左边缘）
GLYPHS = {
    'S': (23, f"""
        M 20 10.5
        C 20 6.5 16.5 4 11.5 4
        C 6.5 4 3 7 3 11
        C 3 15 6.5 17 11.5 18.5
        C 16.5 20 20 22.5 20 26.5
        C 20 30.5 16.5 36 11.5 36
        C 6.5 36 3 33 3 29
    """),
    'u': (21, f"""
        M 4 18
        V 27.5
        A 6.5 6.5 0 0 0 17 27.5
        V 18
    """),
    # 几何 e：碗是正圆（r=9），横杠穿过碗中线，开口在右下（4~5 点钟方向）
    'e': (22, f"""
        M 2 26
        H 20
        A 9 9 0 1 0 16.8 32.9
    """),
    'n': (21, f"""
        M 4 36
        V 18
        M 4 25
        A 6.5 6.5 0 0 1 17 25
        V 36
    """),
    'M': (30, f"""
        M 4.5 36
        V 9.5
        L 15 26
        L 25.5 9.5
        V 36
    """),
    's': (20, f"""
        M 17 21.5
        C 17 18.5 14 16.8 9.8 16.8
        C 5.8 16.8 3 18.9 3 21.8
        C 3 24.6 5.9 25.9 9.8 26.9
        C 13.7 27.9 17 29.3 17 31.9
        C 17 34.8 14.2 36.8 9.8 36.8
        C 5.9 36.8 3 35.1 3 32.2
    """),
    'i': (4.5, f"""
        M 2.25 18
        V 36
    """),
    'c': (21, f"""
        M 18 21.5
        A 7.5 7.5 0 1 0 18 30.5
    """),
}

# dot 用实心圆附加（i 的点）
DOTS = {'i': [(2.25, 6.8, 4.0)]}


def emit(text: str, stroke=STROKE, track=TRACK):
    """按墨迹宽度排版：每个字形先平移到墨迹左缘，再按 track 累进"""
    x = 0.0
    paths, dots = [], []
    for ch in text:
        g = GLYPHS.get(ch)
        if not g:
            x += 12 + track
            continue
        w, d = g
        shift = x
        paths.append((shift, d))
        for (dx, dy, r) in DOTS.get(ch, []):
            dots.append((shift + dx, dy, r))
        x += w + track
    return paths, dots, x - track


def to_svg(text: str, color='#3a4557', shadow=True, size=200) -> str:
    paths, dots, width = emit(text)
    pad = STROKE / 2 + 4
    vb_w = width + pad * 2
    vb_h = 44 + pad * 2
    stroke_parts = [
        f'<path transform="translate({ox:.2f},0)" d="{d.strip()}"/>' for (ox, d) in paths
    ]
    dot_parts = [
        f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r}"/>' for (cx, cy, r) in dots
    ]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-pad:.1f} {-pad:.1f} {vb_w:.1f} {vb_h:.1f}" width="{vb_w:.0f}" height="{vb_h:.0f}">
  <g fill="none" stroke="{color}" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round">
    {chr(10).join(stroke_parts)}
  </g>
  <g fill="{color}">
    {chr(10).join(dot_parts)}
  </g>
</svg>'''


if __name__ == '__main__':
    print(to_svg('SuenMusic'))
