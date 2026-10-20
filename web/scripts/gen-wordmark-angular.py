"""生成「SuenMusic」折角字标（实心多边形，匹配 MarkBold 钣金语言）。

与旧版（gen-wordmark.py，圆头描边）的区别：
  · 实心笔画：每条骨架线经 stroker 变成多边形，不再是 stroke
  · 端头 45° 切角：端面是一条斜过笔画中心的 45° 线，两角都被切掉
  · 转角尖接（miter，超限才坡）：与 MarkBold 的 45° 相接同语言
  · 全部直线段：圆弧一律改为折角（碗口是切角的方角），不用曲线

度量沿用旧版：笔宽 8、字距 7、大写中心线 8→32、x 高中心线 20→32。

用法：
    python3 gen-wordmark-angular.py            # SVG 到 stdout
    python3 write-wordmark-assets.py           # 写 WordMark.vue + docs/icon 资产
"""
from __future__ import annotations

import math

STROKE = 8.0
TRACK = 7.0
CAP_TOP, CAP_BASE = 8.0, 32.0  # 大写中心线
X_TOP, BASE = 18.0, 36.0      # x 高中心线（视觉 14→40，与旧版一致）

# 每个字形：宽度 + 骨架折线（本地坐标，左缘为 0）。全部开放折线。
GLYPHS = {
    # 大写 S：顶杠 → 右竖 → 斜切至左下 → 底杠（4 段，钣金 S）
    'S': (22, [(2, CAP_TOP), (18, CAP_TOP), (18, 20), (2, BASE), (18, BASE)]),
    # u：左竖 → 底杠 → 右竖
    'u': (21, [(4, X_TOP), (4, BASE), (17, BASE), (17, X_TOP)]),
    # e：方框碗（右下开口，终端在右下）+ 通栏横杠。碗心留 6×4 反白
    'e': (24, [(11, 33), (4, 33), (4, 21), (18, 21), (18, 33)],
             [(0, 27), (22, 27)]),
    # n：左竖 → 顶杠 → 右竖
    'n': (21, [(4, BASE), (4, X_TOP), (17, X_TOP), (17, BASE)]),
    # M：左竖 → 斜下 → 斜上 → 右竖
    'M': (30, [(4.5, BASE), (4.5, CAP_TOP), (15, 24), (25.5, CAP_TOP), (25.5, BASE)]),
    # 小写 s：顶杠 → 右竖 → 斜切至左下 → 底杠
    's': (20, [(3, 19), (17, 19), (17, 25), (5, 35), (17, 35)]),
    # i：竖 + 点（点是小方块）
    'i': (5, [(2.5, X_TOP), (2.5, BASE)]),
    # c：顶杠 → 左竖 → 底杠（右开口）
    'c': (21, [(17, 19), (3, 19), (3, 35), (17, 35)]),
}

# i 的点：相对字形左缘的方块（cx, cy, 半边）
DOTS = {'i': [(2.5, 10.0, 2.75)]}


# --------------------------------------------------------------------------- stroker
def _unit(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy)
    if L == 0:
        return None
    return (dx / L, dy / L)


def _miter(joint, seg_a, seg_b, sign: int, h: float, limit: float):
    """两段在 joint 处的尖接点；退化或超限返回 None（调用方坡接）。"""
    (pa, pb, da, na) = seg_a
    (_, _, db, nb) = seg_b
    A = (pb[0] + na[0] * sign * h, pb[1] + na[1] * sign * h)
    B = (joint[0] + nb[0] * sign * h, joint[1] + nb[1] * sign * h)
    denom = da[0] * db[1] - da[1] * db[0]
    if abs(denom) < 1e-9:
        return None
    rx, ry = B[0] - A[0], B[1] - A[1]
    t = (rx * db[1] - ry * db[0]) / denom
    m = (A[0] + da[0] * t, A[1] + da[1] * t)
    if math.hypot(m[0] - joint[0], m[1] - joint[1]) > limit * h:
        return None
    return m


def stroke(pts, h: float, miter_limit: float = 3.0):
    """开放折线 → 实心多边形顶点（45° 切角端头 + 尖接转角）。"""
    segs = []
    for i in range(len(pts) - 1):
        d = _unit(pts[i], pts[i + 1])
        if d is None:
            continue
        n = (-d[1], d[0])
        segs.append((pts[i], pts[i + 1], d, n))
    if not segs:
        return []

    def side(sign: int):
        out = []
        for i, (p0, p1, d, n) in enumerate(segs):
            if i == 0:
                out.append((p0[0] + n[0] * sign * h, p0[1] + n[1] * sign * h))
            else:
                m = _miter(p0, segs[i - 1], segs[i], sign, h, miter_limit)
                if m is not None:
                    out.append(m)
                else:  # 坡接：两段各自的偏移点都留下
                    pn = segs[i - 1][3]
                    out.append((p0[0] + pn[0] * sign * h, p0[1] + pn[1] * sign * h))
                    out.append((p0[0] + n[0] * sign * h, p0[1] + n[1] * sign * h))
            if i == len(segs) - 1:
                out.append((p1[0] + n[0] * sign * h, p1[1] + n[1] * sign * h))
        return out

    pos, neg = side(+1), side(-1)
    S, E = pts[0], pts[-1]
    d0, n0 = segs[0][2], segs[0][3]
    dk, nk = segs[-1][2], segs[-1][3]
    h2 = h
    poly = [
        (S[0] + n0[0] * h2 - d0[0] * h2, S[1] + n0[1] * h2 - d0[1] * h2),   # 起端 45° 切角
        (S[0] - n0[0] * h2 + d0[0] * h2, S[1] - n0[1] * h2 + d0[1] * h2),
        *neg[1:],
        (E[0] - nk[0] * h2 + dk[0] * h2, E[1] - nk[1] * h2 + dk[1] * h2),   # 末端 45° 切角
        (E[0] + nk[0] * h2 - dk[0] * h2, E[1] + nk[1] * h2 - dk[1] * h2),
        *pos[:-1][::-1],
    ]
    return poly


# --------------------------------------------------------------------------- 排版
def emit(text: str, stroke_w: float = STROKE):
    """返回 [(shift, [polygon...]), ...] 与 [(cx, cy, half), ...]，以及总宽。"""
    h = stroke_w / 2
    x = 0.0
    glyphs, dots = [], []
    for ch in text:
        spec = GLYPHS.get(ch)
        if not spec:
            x += 12 + TRACK
            continue
        if len(spec) == 3:
            w, mains, extras = spec
        else:
            w, mains = spec
            extras = []
        polys = [stroke(mains, h)] + ([stroke(extras, h)] if extras else [])
        glyphs.append((x, [p for p in polys if p]))
        for (dx, dy, r) in DOTS.get(ch, []):
            dots.append((x + dx, dy, r))
        x += w + TRACK
    return glyphs, dots, x - TRACK


def _poly_d(poly) -> str:
    return "M " + " L ".join(f"{x:.2f} {y:.2f}" for x, y in poly) + " Z"


def build_markup(text: str = "SuenMusic"):
    """返回 (viewBox, 实心 path 组, 方块点组)。"""
    glyphs, dots, width = emit(text)
    pad = STROKE / 2 + 4
    vb = f"{-pad:.1f} {-pad:.1f} {width + pad * 2:.1f} {44 + pad * 2:.1f}"
    paths = []
    for shift, polys in glyphs:
        for p in polys:
            paths.append(f'      <path transform="translate({shift:.2f} 0)" d="{_poly_d(p)}"/>')
    dot_parts = []
    for cx, cy, r in dots:
        dot_parts.append(
            f'      <path transform="translate({cx:.2f} {cy:.2f})" '
            f'd="M {-r:.2f} {-r:.2f} L {r:.2f} {-r:.2f} L {r:.2f} {r:.2f} L {-r:.2f} {r:.2f} Z"/>'
        )
    return vb, "\n".join(paths), "\n".join(dot_parts)


def to_svg(text: str = "SuenMusic", color: str = "#e9edf4") -> str:
    vb, body, dots = build_markup(text)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">\n'
        f'  <g fill="{color}">\n{body}\n{dots}\n  </g>\n</svg>\n'
    )


if __name__ == "__main__":
    print(to_svg("SuenMusic"))
