#!/usr/bin/env python3
"""
从 MarkBold.vue 生成全端品牌图标。

字形唯一来源是 web/src/components/brand/MarkBold.vue 里的 P1~P4 路径常量 ——
改字形只改那一个文件，然后重跑本脚本：

    python3 scripts/gen-brand-icons.py

产物：
    web/public/           favicon.svg / favicon-16/32/192/512.png / apple-touch-icon.png / favicon.ico
    ios/                   AppIcon-1024.png
    android/app/src/main   adaptive（vector + 背景色）+ 各密度 mipmap PNG + monochrome
    fn/                    ICON.PNG / ICON_256.PNG / app/ui/images/icon_*.png
    docs/icon/             母版 SVG + 渲染 PNG（README 同步更新）

配色固定用深色品牌（图标不跟随主题）：
    底板 #17181B / 蚀刻边 #2A2C30 / 字 #E9E7E2 / 段0 琥珀 #E8A33D
"""
from __future__ import annotations

import re
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MARK_VUE = ROOT / "web/src/components/brand/MarkBold.vue"

PLATE = (0x17, 0x18, 0x1B, 255)
PLATE_EDGE = (0x2A, 0x2C, 0x30, 255)
GLYPH = (0xE9, 0xE7, 0xE2, 255)
ACCENT = (0xE8, 0xA3, 0x3D, 255)

PLATE_RX = 188.0          # 底板圆角（800 视口单位）
PLATE_EDGE_W = 3.0        # 蚀刻边宽（800 视口单位）
SS = 4                    # 超采样倍率


# --------------------------------------------------------------------------- 路径解析
def read_paths() -> list[str]:
    src = MARK_VUE.read_text(encoding="utf8")
    paths = []
    for i in range(1, 5):
        m = re.search(rf"const P{i}\s*=\s*\n?\s*'([^']+)'", src)
        if not m:
            sys.exit(f"在 {MARK_VUE} 里找不到 P{i}")
        paths.append(m.group(1))
    return paths


def tokenize(d: str) -> list[tuple[str, list[float]]]:
    """把 pathData 拆成 (命令, [参数])。命令已合并隐式重复（如 c 后的连续坐标对）。"""
    tokens: list[tuple[str, list[float]]] = []
    for m in re.finditer(r"([MmLlHhVvCcSsZz])|(-?\d*\.?\d+(?:e-?\d+)?)", d):
        if m.group(1):
            tokens.append((m.group(1), []))
        else:
            if not tokens:
                raise ValueError(f"pathData 以数字开头: {d[:40]}")
            tokens[-1][1].append(float(m.group(2)))
    return tokens


def flatten(d: str, curve_seg: int = 28) -> list[list[tuple[float, float]]]:
    """
    路径 → 子路径列表（每条是闭合多边形顶点）。
    同时把 MarkBold 的 transform（translate(0,800) scale(0.1,-0.1)）烘进坐标：
        x' = 0.1x,  y' = 800 - 0.1y
    """
    def tx(x: float, y: float) -> tuple[float, float]:
        return (0.1 * x, 800.0 - 0.1 * y)

    subpaths: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    x = y = 0.0
    start_x = start_y = 0.0
    cmd = ""

    def close() -> None:
        nonlocal cur
        if len(cur) >= 3:
            subpaths.append(cur)
        cur = []

    for op, args in tokenize(d):
        i = 0
        cmd = op if op else cmd
        while i < len(args) or op in ("Z", "z"):
            if cmd in ("M", "m"):
                nx = args[i] + (x if cmd == "m" else 0)
                ny = args[i + 1] + (y if cmd == "m" else 0)
                close()
                x, y = nx, ny
                start_x, start_y = x, y
                cur.append(tx(x, y))
                i += 2
                cmd = "l" if op == "m" else "L"   # 隐式 lineto
            elif cmd in ("L", "l"):
                nx = args[i] + (x if cmd == "l" else 0)
                ny = args[i + 1] + (y if cmd == "l" else 0)
                cur.append(tx(nx, ny))
                x, y = nx, ny
                i += 2
            elif cmd in ("H", "h"):
                nx = args[i] + (x if cmd == "h" else 0)
                cur.append(tx(nx, y))
                x = nx
                i += 1
            elif cmd in ("V", "v"):
                ny = args[i] + (y if cmd == "v" else 0)
                cur.append(tx(x, ny))
                y = ny
                i += 1
            elif cmd in ("C", "c"):
                rel = cmd == "c"
                p1 = (args[i] + (x if rel else 0), args[i + 1] + (y if rel else 0))
                p2 = (args[i + 2] + (x if rel else 0), args[i + 3] + (y if rel else 0))
                p3 = (args[i + 4] + (x if rel else 0), args[i + 5] + (y if rel else 0))
                a, b, c = tx(x, y), tx(*p1), tx(*p2)
                e = tx(*p3)
                for s in range(1, curve_seg + 1):
                    t = s / curve_seg
                    mt = 1 - t
                    px = mt**3 * a[0] + 3 * mt**2 * t * b[0] + 3 * mt * t**2 * c[0] + t**3 * e[0]
                    py = mt**3 * a[1] + 3 * mt**2 * t * b[1] + 3 * mt * t**2 * c[1] + t**3 * e[1]
                    cur.append((px, py))
                x, y = p3
                i += 6
            elif cmd in ("Z", "z"):
                close()
                x, y = start_x, start_y
                i += 1
            else:
                raise ValueError(f"不支持的路径命令: {cmd}")
            if i >= len(args):
                break
    close()
    return subpaths


def bounds(subpaths: list[list[tuple[float, float]]]):
    xs = [p[0] for sp in subpaths for p in sp]
    ys = [p[1] for sp in subpaths for p in sp]
    return min(xs), min(ys), max(xs), max(ys)


# --------------------------------------------------------------------------- 渲染
def render(size: int, *, glyph_only: bool = False, round_mask: bool = False,
            amber: bool = True, glyph_fit: float | None = None) -> Image.Image:
    """
    渲染一枚图标。
    glyph_only  : 只画字（透明底）——给 Android 自适应前景
    glyph_fit   : 字占画布的比例（None = 原始 800 视口铺满）
    round_mask  : 圆形裁切——给 ic_launcher_round
    """
    paths = read_paths()
    flat_paths = [flatten(p) for p in paths]      # 每条 path → 若干子多边形
    all_pts = [pt for sps in flat_paths for sp in sps for pt in sp]

    canvas = size * SS
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    scale = canvas / 800.0
    if glyph_fit is not None:
        x0, y0, x1, y1 = bounds([all_pts])
        gw, gh = x1 - x0, y1 - y0
        inner = canvas * glyph_fit
        scale = min(inner / gw, inner / gh)

    def to_px(pt):
        if glyph_fit is not None:
            x0, y0, x1, y1 = bounds([all_pts])
            gw, gh = (x1 - x0), (y1 - y0)
            ox = (canvas - gw * scale) / 2 - x0 * scale
            oy = (canvas - gh * scale) / 2 - y0 * scale
            return (pt[0] * scale + ox, pt[1] * scale + oy)
        return (pt[0] * scale, pt[1] * scale)

    if not glyph_only:
        # 底板 + 蚀刻边
        inset = PLATE_EDGE_W / 2 * scale
        draw.rounded_rectangle(
            [inset, inset, canvas - inset, canvas - inset],
            radius=PLATE_RX * scale,
            fill=PLATE, outline=PLATE_EDGE, width=max(1, int(PLATE_EDGE_W * scale)),
        )

    for idx, sps in enumerate(flat_paths):
        color = ACCENT if (amber and idx == 0) else GLYPH
        for sp in sps:
            draw.polygon([to_px(p) for p in sp], fill=color)

    if round_mask:
        mask = Image.new("L", (canvas, canvas), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, canvas - 1, canvas - 1], fill=255)
        img.putalpha(mask)

    return img.resize((size, size), Image.LANCZOS)


def save(img: Image.Image, path: Path, *, opaque: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if opaque:
        flat = Image.new("RGB", img.size, PLATE[:3])
        flat.paste(img, mask=img.split()[3] if img.mode == "RGBA" else None)
        flat.save(path, "PNG", optimize=True)
    else:
        img.save(path, "PNG", optimize=True)
    print(f"  {path.relative_to(ROOT)}  {img.size}")


# --------------------------------------------------------------------------- 各端
def gen_web() -> None:
    pub = ROOT / "web/public"
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="512" height="512" role="img" aria-label="SuenMusic">
  <title>SuenMusic</title>
  <!-- 由 scripts/gen-brand-icons.py 生成；字形源：web/src/components/brand/MarkBold.vue -->
  <rect x="4" y="4" width="792" height="792" rx="188" fill="#17181B" stroke="#2A2C30" stroke-width="3"/>
  <g transform="translate(0,800) scale(0.1,-0.1)">
{chr(10).join(f'    <path d="{p}" fill="{"#E8A33D" if i == 0 else "#E9E7E2"}"/>' for i, p in enumerate(read_paths()))}
  </g>
</svg>
'''
    (pub / "favicon.svg").write_text(svg, encoding="utf8")
    print(f"  {pub.relative_to(ROOT)}/favicon.svg")

    master = render(512)
    save(master, pub / "favicon-512.png")
    save(master.resize((192, 192), Image.LANCZOS), pub / "favicon-192.png")
    save(master.resize((32, 32), Image.LANCZOS), pub / "favicon-32.png")
    save(master.resize((16, 16), Image.LANCZOS), pub / "favicon-16.png")
    save(master.resize((180, 180), Image.LANCZOS), pub / "apple-touch-icon.png")
    # ico：16/32/48 三档（PIL 从 256 基准图缩放）
    base = render(256)
    base.save(pub / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"  {pub.relative_to(ROOT)}/favicon.ico  16/32/48")


def gen_ios() -> None:
    setdir = ROOT / "ios/App/App/Assets.xcassets/AppIcon.appiconset"
    save(render(1024), setdir / "AppIcon-1024.png", opaque=True)


ANDROID_DENSITIES = {
    "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192,
}


def gen_android() -> None:
    res = ROOT / "android/app/src/main/res"

    # 背景色（adaptive 的 <background android:drawable="@color/..."> 与 vector 都指它）
    color_xml = res / "values/ic_launcher_background.xml"
    color_xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<resources>\n'
        '    <color name="ic_launcher_background">#17181B</color>\n'
        '</resources>\n', encoding="utf8")
    print(f"  {color_xml.relative_to(ROOT)}")

    vec_bg = res / "drawable/ic_launcher_background.xml"
    vec_bg.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    android:width="108dp"\n'
        '    android:height="108dp"\n'
        '    android:viewportWidth="108"\n'
        '    android:viewportHeight="108">\n'
        '    <path\n'
        '        android:fillColor="#17181B"\n'
        '        android:pathData="M0,0h108v108h-108z" />\n'
        '</vector>\n', encoding="utf8")
    print(f"  {vec_bg.relative_to(ROOT)}")

    # 前景 / 单色：把 800 视口路径烘成 108 视口（VectorDrawable 不支持负 scale）
    paths = read_paths()
    fg_paths, mono_paths = [], []
    for i, p in enumerate(paths):
        for sp in flatten(p):
            pts = " ".join(f"{x * 0.108:.3f},{y * 0.108:.3f}" for x, y in sp)
            fill = "#E8A33D" if i == 0 else "#E9E7E2"
            fg_paths.append(
                f'    <path\n        android:fillColor="{fill}"\n'
                f'        android:pathData="M{pts} z" />')
            mono_paths.append(
                f'    <path\n        android:fillColor="#FFFFFF"\n'
                f'        android:pathData="M{pts} z" />')

    fg = res / "drawable-v24/ic_launcher_foreground.xml"
    fg.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!-- 由 scripts/gen-brand-icons.py 生成 -->\n'
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    android:width="108dp"\n'
        '    android:height="108dp"\n'
        '    android:viewportWidth="108"\n'
        '    android:viewportHeight="108">\n'
        + "\n".join(fg_paths) + '\n</vector>\n', encoding="utf8")
    print(f"  {fg.relative_to(ROOT)}")

    mono = res / "drawable/ic_launcher_monochrome.xml"
    mono.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!-- Android 13+ 主题图标：系统会按取色重新着色，这里只要形状 -->\n'
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    android:width="108dp"\n'
        '    android:height="108dp"\n'
        '    android:viewportWidth="108"\n'
        '    android:viewportHeight="108">\n'
        + "\n".join(mono_paths) + '\n</vector>\n', encoding="utf8")
    print(f"  {mono.relative_to(ROOT)}")

    # adaptive-icon：补 monochrome（API<33 的启动器会忽略这个标签）
    for name in ("ic_launcher", "ic_launcher_round"):
        xml = res / f"mipmap-anydpi-v26/{name}.xml"
        xml.write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@color/ic_launcher_background"/>\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
            '    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n'
            '</adaptive-icon>\n', encoding="utf8")
        print(f"  {xml.relative_to(ROOT)}")

    # 各密度 PNG：legacy 完整图标 + 圆形版 + 自适应前景（1.5x 画布，字收进安全区）
    for den, px in ANDROID_DENSITIES.items():
        d = res / f"mipmap-{den}"
        save(render(px), d / "ic_launcher.png")
        save(render(px, round_mask=True), d / "ic_launcher_round.png")
        save(render(int(px * 1.5), glyph_only=True, glyph_fit=0.60),
             d / "ic_launcher_foreground.png")


def gen_fn() -> None:
    save(render(256), ROOT / "fn/ICON_256.PNG")
    save(render(64), ROOT / "fn/ICON.PNG")
    save(render(64), ROOT / "fn/app/ui/images/icon_64.png")
    save(render(256), ROOT / "fn/app/ui/images/icon_256.png")


DOC_SIZES = [48, 72, 96, 144, 192, 512]


def gen_docs() -> None:
    d = ROOT / "docs/icon"
    paths = read_paths()
    # 母版 SVG：前景（字）/ 背景（底板）/ 单色（字）
    fg_body = "\n".join(
        f'  <path d="{p}" fill="{"#E8A33D" if i == 0 else "#E9E7E2"}"/>'
        for i, p in enumerate(paths))
    (d / "ic_launcher_foreground.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">\n'
        f'{fg_body}\n</svg>\n', encoding="utf8")
    (d / "ic_launcher_background.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">\n'
        '  <rect x="4" y="4" width="792" height="792" rx="188" fill="#17181B" '
        'stroke="#2A2C30" stroke-width="3"/>\n</svg>\n', encoding="utf8")
    mono_body = "\n".join(f'  <path d="{p}" fill="#000000"/>' for p in paths)
    (d / "ic_launcher_monochrome.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">\n'
        f'{mono_body}\n</svg>\n', encoding="utf8")
    for f in ("ic_launcher_foreground.svg", "ic_launcher_background.svg",
              "ic_launcher_monochrome.svg"):
        print(f"  {d.relative_to(ROOT)}/{f}")
    for px in DOC_SIZES:
        save(render(px), d / f"ic_launcher_{px}.png")


def gen_splash() -> None:
    """启动图：深色底 + 居中品牌标（无底板，像一枚水印）。"""
    def splash(w: int, h: int) -> Image.Image:
        img = Image.new("RGB", (w, h), PLATE[:3])
        mark = int(min(w, h) * 0.24)
        m = render(mark, glyph_only=True, amber=True).convert("RGBA")
        img.paste(m, ((w - mark) // 2, (h - mark) // 2), m)
        return img

    ios_set = ROOT / "ios/App/App/Assets.xcassets/Splash.imageset"
    big = splash(2732, 2732)
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        save(big, ios_set / name)

    res = ROOT / "android/app/src/main/res"
    for f in sorted(res.glob("drawable*/splash.png")):
        w, h = Image.open(f).size
        save(splash(w, h), f)


def main() -> None:
    print("web/public:")
    gen_web()
    print("ios:")
    gen_ios()
    print("android:")
    gen_android()
    print("splash:")
    gen_splash()
    print("fn:")
    gen_fn()
    print("docs/icon:")
    gen_docs()
    print("完成。改字形请编辑 web/src/components/brand/MarkBold.vue 后重跑本脚本。")


if __name__ == "__main__":
    main()
