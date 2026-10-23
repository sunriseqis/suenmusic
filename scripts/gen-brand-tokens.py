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

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web/src/styles/tokens.css"
HW_OUT = ROOT / "hw/entry/src/main/ets/common/Tokens.ets"
IOS_OUT = ROOT / "ios/SuenMusic/UI/DesignTokens.swift"
# T12：鸿蒙端颜色资源（base = 浅色 / dark = 深色），深浅随系统自动切
HW_COLOR_BASE = ROOT / "hw/entry/src/main/resources/base/element/color.json"
HW_COLOR_DARK = ROOT / "hw/entry/src/main/resources/dark/element/color.json"


def res_name(name: str) -> str:
    """语义名 → 颜色资源名：accentText → t_accent_text"""
    return "t_" + re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()

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
    # 海报位/封面卡共有形态（T5.5）：顶沿内高光、压字渐变、日期角标、badge 深字
    "--hi": "hi",
    "--poster-scrim": "posterScrim",
    "--poster-scrim-mid": "posterScrimMid",
    "--date-chip": "dateChip",
    "--badge-ink": "badgeInk",
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

    # ---------------- 鸿蒙颜色资源（T12 色板资源化） ----------------
    def write_color_json(path: Path, rows: list[tuple[str, str, str]], extra: dict[str, str]) -> None:
        entries: dict[str, str] = {}
        if path.exists():
            try:
                for e in json.loads(path.read_text(encoding="utf8")).get("color", []):
                    entries[str(e["name"])] = str(e["value"])
            except Exception:
                entries = {}
        entries.update(extra)
        for name, hexv, _raw in rows:
            entries[res_name(name)] = hexv
        data = {"color": [{"name": k, "value": entries[k]} for k in sorted(entries)]}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
        print(f"  {path.relative_to(ROOT)}  {len(rows)} 个颜色资源")

    dark_bg = next((h for n, h, _ in dark_rows if n == 'bg'), '#0E0F11')
    light_bg = next((h for n, h, _ in light_rows if n == 'bg'), '#F2F0EA')
    # 阶段 1 先让 base 也写**深色**：此时客户端还没有主题开关（阶段 2 才有），
    # 若 base 立刻切浅色，跟随系统浅色的机器会突然变成半成品浅色界面。
    # 阶段 2 接线完成后把 EMIT_LIGHT_IN_BASE 置 True 即可一键切到「base=浅色 / dark=深色」。
    EMIT_LIGHT_IN_BASE = False
    base_rows = light_rows if EMIT_LIGHT_IN_BASE else dark_rows
    base_bg = light_bg if EMIT_LIGHT_IN_BASE else dark_bg
    write_color_json(HW_COLOR_BASE, base_rows, {"start_window_background": base_bg})
    write_color_json(HW_COLOR_DARK, dark_rows, {"start_window_background": dark_bg})

    # ---------------- ArkTS（资源引用：深浅由资源目录切） ----------------
    hw = [
        "/**",
        " * 设计令牌（**自动生成，不要手改**）。",
        " *",
        " * 来源：`web/src/styles/tokens.css` → `python3 scripts/gen-brand-tokens.py`。",
        " *",
        " * T12 起：颜色是**资源引用**（`$r('app.color.t_*')`），色值同时写进",
        " * `resources/base/element/color.json`（浅色）与 `resources/dark/element/color.json`（深色），",
        " * 系统切深浅色时自动跟随；页面只认 `Tokens.xxx`，不需要知道当前主题。",
        " */",
        "",
        "export class Tokens {",
        "  // 深浅两套由系统资源目录决定（base = 浅色纸白 / dark = 深色哑光石墨）",
    ]
    for name, hexv, raw in dark_rows:
        hw.append(f"  static readonly {name}: ResourceColor = $r('app.color.{res_name(name)}'); // dark {hexv} / light {dict((n, h) for n, h, _ in light_rows).get(name, hexv)}")
    hw += ["}", ""]
    HW_OUT.parent.mkdir(parents=True, exist_ok=True)
    HW_OUT.write_text("\n".join(hw), encoding="utf8")
    print(f"  {HW_OUT.relative_to(ROOT)}  {len(dark_rows)} 个令牌（ResourceColor）")

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
