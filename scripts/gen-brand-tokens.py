#!/usr/bin/env python3
"""
从 web/src/styles/tokens.css 生成两端原生设计令牌。

**唯一真相源是 CSS**。原生端不许手抄颜色 —— 手抄必然漂移（这次 S2 就抄错了三处：
页面底用了 panel 色、次级文字用了浅色主题的 t2）。

    python3 scripts/gen-brand-tokens.py

产物：
    hw/entry/src/main/ets/common/Tokens.ets      ArkTS 常量
    ios/SuenMusic/UI/DesignTokens.swift          Swift 常量

只取"跨端通用"的那一组（底色/面板/发丝线/三级文字/琥珀/遮罩/进度轨）。
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web/src/styles/tokens.css"
HW_OUT = ROOT / "hw/entry/src/main/ets/common/Tokens.ets"
IOS_OUT = ROOT / "ios/SuenMusic/UI/DesignTokens.swift"

# CSS 变量名 → 两端通用的语义名
WANTED = {
    "--bg": "bg",
    "--panel": "panel",
    "--panel-2": "panel2",
    "--line": "line",
    "--t1": "text1",
    "--t2": "text2",
    "--accent": "accent",
    "--accent-text": "accentText",
    "--scrim": "scrim",
    "--track": "track",
}


def parse_block(css: str, selector: str) -> dict[str, str]:
    """取出某个选择器块里的 `--var: value;` 映射"""
    m = re.search(re.escape(selector) + r"\s*\{(.*?)\}", css, re.S)
    if m is None:
        raise SystemExit(f"在 tokens.css 里找不到 {selector} 块")
    out: dict[str, str] = {}
    for var, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", m.group(1)):
        out[var] = value.strip()
    return out


def to_hex(value: str) -> str:
    """rgba(...) → #AARRGGBB；#rgb/#rrggbb 统一成大写 6 位"""
    v = value.strip()
    m = re.match(r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)", v)
    if m:
        r, g, b = (int(float(m.group(i))) for i in (1, 2, 3))
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        aa = "{:02X}".format(int(round(a * 255)))
        return "#" + aa + "{:02X}{:02X}{:02X}".format(r, g, b)
    if v.startswith("#"):
        h = v[1:].upper()
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return "#" + h
    raise SystemExit(f"无法识别的颜色：{v}")


def main() -> None:
    css = SRC.read_text(encoding="utf8")
    dark = parse_block(css, ":root[data-theme='dark']")
    light = parse_block(css, ":root[data-theme='light']")

    def collect(block: dict[str, str]) -> list[tuple[str, str, str]]:
        rows = []
        for var, name in WANTED.items():
            if var in block:
                rows.append((name, to_hex(block[var]), block[var]))
        return rows

    dark_rows = collect(dark)
    light_rows = collect(light)

    # ---------------- ArkTS ----------------
    hw = [
        "/**",
        " * 设计令牌（**自动生成，不要手改**）。",
        " *",
        " * 来源：`web/src/styles/tokens.css` → `python3 scripts/gen-brand-tokens.py`。",
        " * 原生端手抄颜色必然漂移：S2 第一版就把页面底写成了 panel 色、次级文字用了",
        " * 浅色主题的 t2。改配色只改 CSS，然后重跑脚本。",
        " */",
        "",
        "export class Tokens {",
        "  // ---- 深色（哑光石墨）—— 客户端默认主题 ----",
    ]
    for name, hexv, raw in dark_rows:
        hw.append(f"  static readonly {name}: string = '{hexv}'; // {raw}")
    hw += ["", "  // ---- 浅色（纸白）—— 备用 ----"]
    for name, hexv, raw in light_rows:
        hw.append(f"  static readonly {name}Light: string = '{hexv}'; // {raw}")
    hw += ["}", ""]
    HW_OUT.parent.mkdir(parents=True, exist_ok=True)
    HW_OUT.write_text("\n".join(hw), encoding="utf8")
    print(f"  {HW_OUT.relative_to(ROOT)}  {len(dark_rows) + len(light_rows)} 个令牌")

    # ---------------- Swift ----------------
    def swift_color(name: str, hexv: str) -> str:
        h = hexv.lstrip("#")
        if len(h) == 8:  # AARRGGBB
            a, r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4, 6))
            return f"Color(red: {r:.3f}, green: {g:.3f}, blue: {b:.3f}, opacity: {a:.3f})"
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        return f"Color(red: {r:.3f}, green: {g:.3f}, blue: {b:.3f})"

    sw = [
        "/**",
        " * 设计令牌（**自动生成，不要手改**）。",
        " *",
        " * 来源：`web/src/styles/tokens.css` → `python3 scripts/gen-brand-tokens.py`。",
        " */",
        "",
        "import SwiftUI",
        "",
        "enum DesignTokens {",
        "    // ---- 深色（哑光石墨）—— 客户端默认主题 ----",
    ]
    for name, hexv, raw in dark_rows:
        sw.append(f"    static let {name} = {swift_color(name, hexv)} // {raw}")
    sw += ["", "    // ---- 浅色（纸白）—— 备用 ----"]
    for name, hexv, raw in light_rows:
        sw.append(f"    static let {name}Light = {swift_color(name, hexv)} // {raw}")
    sw += ["}", ""]
    IOS_OUT.parent.mkdir(parents=True, exist_ok=True)
    IOS_OUT.write_text("\n".join(sw), encoding="utf8")
    print(f"  {IOS_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
