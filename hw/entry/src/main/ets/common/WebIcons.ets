/**
 * Web 图标库（T10 收官验收修复）：鸿蒙原生 SymbolGlyph 渲染。
 *
 * 【路线变更 2026-10-23 验收方裁定】原方案「1:1 移植 web NeuIcon.vue 的 SVG path
 * （ArkUI Path + scale）」实测渲染异常：`.scale()` 变换净效果 = 1 命令单位 × 1 物理像素，
 * `size` 参数完全不起作用 —— 所有 glyph 只有十几像素，按钮图标小到无法辨认/点击
 * （验收反馈「所有图标尺寸全部错误」「按钮无法准确点击」）。
 * 验收方裁定弃自绘 path，改鸿蒙原生 `sys.symbol` 符号（SymbolGlyph）。
 *
 * - `WebIcon`：纯图标（@Builder，只画不响应）。
 * - `WebIconButton`：图标按钮（@ComponentV2），质感三态：
 *   chrome = 标准键（panel 底 + line 描边 + 顶沿内高光，web NeuIconButton 默认）；
 *   plain  = 播放页次级键（透明无厚度，web FullPlayer 覆盖）；
 *   gradient = 播放页主播放键（panel2→panel 渐变 + line + accent 图标，web `.play-btn`）；
 *   primary = 琥珀填充键（accent 底 + badgeInk 图标，无边框）—— 搜索条主钮。
 *   按下 = translateY(1) 下沉 + 底色变 panel2（web `:active` 同款机械反馈）。
 *
 * - 尺寸语义与 web 对齐：web NeuIconButton PX_SIZE（键壳 28/36/44/60）×
 *   ICON_SIZE（图标 15/18/21/26）。SymbolGlyph 的 fontSize 即图标 em 尺寸，
 *   数值直接沿用 web 规格，视觉重量用 FontWeight.Medium 补偿（原生默认 Regular 偏细）。
 *
 * 页面里尺寸/间距/字号一律走 `Dim`，颜色只走 `Tokens`（本文件内联常量除外）。
 */

import { Tokens } from './Tokens';
import { Dim } from './Dimension';

/** web NeuIconButton PX_SIZE：键尺寸（sm/md/lg/xl） */
const BOX_SM = 28;
const BOX_MD = 36;
const BOX_LG = 44;
const BOX_XL = 60;
/** web NeuIconButton ICON_SIZE：图标比键壳小一圈才「装得进去」 */
const GLYPH_SM = 15;
const GLYPH_MD = 18;
const GLYPH_LG = 21;
const GLYPH_XL = 26;

/** 图标名常量（值为原 web NeuIcon 的 IconName，禁止裸字符串散落页面） */
export class WebIconName {
  static readonly DOTS: string = 'dots';
  static readonly PLAY: string = 'play';
  static readonly PAUSE: string = 'pause';
  static readonly PREV: string = 'prev';
  static readonly NEXT: string = 'next';
  static readonly SEARCH: string = 'search';
  static readonly HEART: string = 'heart';
  static readonly HEART_FILLED: string = 'heart-filled';
  static readonly LIST: string = 'list';
  static readonly CLOSE: string = 'close';
  static readonly CHEVRON_DOWN: string = 'chevron-down';
  /** 返回/上一页（chevron-down 旋转 -90°，同笔画语言） */
  static readonly CHEVRON_LEFT: string = 'chevron-left';
  static readonly CHEVRON_RIGHT: string = 'chevron-right';
  static readonly CHEVRON_UP: string = 'chevron-up';
  /** 新增（服务端管理「+」） */
  static readonly PLUS: string = 'plus';
  static readonly MODE_ORDER: string = 'mode-order';
  static readonly MODE_LOOP: string = 'mode-loop';
  static readonly MODE_REPEAT_ONE: string = 'mode-repeat-one';
  static readonly MODE_SHUFFLE: string = 'mode-shuffle';
  static readonly MODE_SHUFFLE_ONCE: string = 'mode-shuffle-once';
  /** 大头针（锚定/固定；sys.symbol.pin 已在资源表核验存在） */
  static readonly PIN: string = 'pin';
  static readonly DISLIKE_SONG: string = 'dislike-song';
  static readonly DISLIKE_ARTIST: string = 'dislike-artist';
}

/** 图标按钮质感（web NeuIconButton 的语境） */
export class NeuBtnChrome {
  static readonly CHROME: string = 'chrome';
  static readonly PLAIN: string = 'plain';
  static readonly GRADIENT: string = 'gradient';
  /** 琥珀填充键（web NeuIconButton primary：accent 底 + badgeInk 图标，无边框）—— 搜索条主钮 */
  static readonly PRIMARY: string = 'primary';
}

/**
 * 图标名 → 鸿蒙原生 `sys.symbol` 资源映射。
 * 名称均已对照 SDK sysResource 符号表核实（3933 个可用符号）。
 * 无精确对应的用语义最近符号：shuffle-once → shuffle、mode-order → arrow_right
 * （激活态由调用方以颜色区分）。
 */
function sysSymbolOf(name: string): Resource {
  switch (name) {
    case WebIconName.DOTS:
      return $r('sys.symbol.more');
    case WebIconName.PLAY:
      return $r('sys.symbol.play_fill');
    case WebIconName.PAUSE:
      return $r('sys.symbol.pause');
    case WebIconName.PREV:
      return $r('sys.symbol.backward_end_fill');
    case WebIconName.NEXT:
      return $r('sys.symbol.forward_end_fill');
    case WebIconName.SEARCH:
      return $r('sys.symbol.magnifyingglass');
    case WebIconName.PIN:
      return $r('sys.symbol.pin');
    case WebIconName.HEART:
      return $r('sys.symbol.heart');
    case WebIconName.HEART_FILLED:
      return $r('sys.symbol.heart_fill');
    case WebIconName.LIST:
      return $r('sys.symbol.list_bullet');
    case WebIconName.CLOSE:
      return $r('sys.symbol.xmark');
    case WebIconName.CHEVRON_DOWN:
      return $r('sys.symbol.chevron_down');
    case WebIconName.CHEVRON_LEFT:
      return $r('sys.symbol.chevron_left');
    case WebIconName.CHEVRON_RIGHT:
      return $r('sys.symbol.chevron_right');
    case WebIconName.CHEVRON_UP:
      return $r('sys.symbol.chevron_up');
    case WebIconName.PLUS:
      return $r('sys.symbol.plus');
    case WebIconName.MODE_ORDER:
      return $r('sys.symbol.arrow_right');
    case WebIconName.MODE_LOOP:
      return $r('sys.symbol.repeat');
    case WebIconName.MODE_REPEAT_ONE:
      return $r('sys.symbol.repeat_1');
    case WebIconName.MODE_SHUFFLE:
      return $r('sys.symbol.shuffle');
    case WebIconName.MODE_SHUFFLE_ONCE:
      return $r('sys.symbol.shuffle');
    case WebIconName.DISLIKE_SONG:
      return $r('sys.symbol.hand_thumbsdown');
    case WebIconName.DISLIKE_ARTIST:
      return $r('sys.symbol.hand_thumbsdown_fill');
    default:
      // 未知图标兜底：列表（最中性的图形），绝不让按钮画成空白
      return $r('sys.symbol.list_bullet');
  }
}

/**
 * 纯图标：`WebIcon(WebIconName.HEART, 20, Tokens.text1)`。
 * SymbolGlyph 渲染：fontSize 即图标 em 尺寸（沿用 web ICON_SIZE 数值），
 * FontWeight.Medium 补偿原生 Regular 偏细的视觉重量。
 */
@Builder
export function WebIcon(name: string, size: number, color: ResourceColor) {
  SymbolGlyph(sysSymbolOf(name))
    .fontSize(size)
    .fontColor([color])
    .fontWeight(FontWeight.Medium)
}

/**
 * 图标按钮（web NeuIconButton 等价物，@ComponentV2 —— 可嵌在 V1 页面里）。
 *
 * 用法：
 *   WebIconButton({
 *     iconName: WebIconName.HEART, boxSize: 36, glyphColor: Tokens.text2,
 *     chromeKind: NeuBtnChrome.PLAIN,
 *     onTap: () => { this.toggleFav(); }
 *   })
 * 默认键色：次级灰 / 调用方按态换 accent。
 * 事件名用 onTap：@Event onClick 与基类 CommonMethod.onClick 方法同名冲突（编译报
 * “not assignable to the same property in base type CustomComponent”），禁止改回。
 */
@ComponentV2
export struct WebIconButton {
  /** 图标名（WebIconName 常量） */
  @Param iconName: string = WebIconName.DOTS;
  /** 键尺寸（web PX_SIZE：28/36/44/60） */
  @Param boxSize: number = BOX_MD;
  /** 图标尺寸；0 = 按 boxSize 自动取 web ICON_SIZE（15/18/21/26） */
  @Param glyphSize: number = 0;
  /** 图标色 */
  @Param glyphColor: ResourceColor = Tokens.text1;
  /** 质感：chrome 标准键 / plain 播放页次级透明键 / gradient 主播放键 / primary 琥珀填充 */
  @Param chromeKind: string = NeuBtnChrome.CHROME;
  /** 选中态（plain 键的滑块凸起：panel2 底 + 顶沿高光，色仍由调用方传） */
  @Param selectedFlag: boolean = false;
  @Event onTap: () => void = () => {};
  @Local pressed: boolean = false;

  private autoGlyph(): number {
    if (this.glyphSize > 0) {
      return this.glyphSize;
    }
    if (this.boxSize <= BOX_SM) {
      return GLYPH_SM;
    }
    if (this.boxSize <= BOX_MD) {
      return GLYPH_MD;
    }
    if (this.boxSize <= BOX_LG) {
      return GLYPH_LG;
    }
    return GLYPH_XL;
  }

  private chromeBg(): ResourceColor {
    if (this.chromeKind === NeuBtnChrome.PRIMARY) {
      // 琥珀填充：按压只下沉不变色（无更深的琥珀 token，web :active 同款位移反馈）
      return Tokens.accent;
    }
    if (this.chromeKind === NeuBtnChrome.PLAIN) {
      if (this.pressed) {
        return Tokens.panel2;
      }
      return this.selectedFlag ? Tokens.panel2 : Color.Transparent;
    }
    if (this.pressed) {
      return Tokens.panel2;
    }
    return Tokens.panel;
  }

  private chromeBorder(): BorderOptions | undefined {
    // primary 琥珀填充自带边界，不加描边（web NeuButton primary 同款）
    if (this.chromeKind === NeuBtnChrome.PRIMARY) {
      return undefined;
    }
    // plain 平时无厚度；选中/按下才有顶沿高光（滑块凸起的近似）
    if (this.chromeKind === NeuBtnChrome.PLAIN) {
      if (this.selectedFlag || this.pressed) {
        return { width: { top: Dim.hairline }, color: { top: Tokens.hi } };
      }
      return undefined;
    }
    return { width: Dim.hairline, color: Tokens.line };
  }

  build() {
    // 图标居中（Stack 默认 Center）；顶沿内高光用 position 钉在键壳上沿，
    // 不再借 alignContent=Top 连累图标跟着顶对齐（原 bug 之一）
    Stack() {
      SymbolGlyph(sysSymbolOf(this.iconName))
        .fontSize(this.autoGlyph())
        .fontColor([this.glyphColor])
        .fontWeight(FontWeight.Medium)
      // ⚠️ 2026-10-23 删除：原来这里有一条 1vp 顶沿内高光（`Row().width('100%')` + Tokens.hi），
      // 只在非 PLAIN 键（= GRADIENT：播放页主播放键、搜索键）上画 —— 用户在播放键上看到
      // 「按钮上方有一条横线」就是它。GRADIENT 键本身已有 linearGradient 提供厚度感，不需要这条线。
      // 连同迷你条那处 barSheen（同款实现）一起，本端不再有「键顶高光横线」。
    }
    .width(this.boxSize)
    .height(this.boxSize)
    .borderRadius(Dim.radiusMd)
    .backgroundColor(this.chromeBg())
    .border(this.chromeBorder())
    .linearGradient(this.chromeKind === NeuBtnChrome.GRADIENT
      ? {
        angle: 180,
        colors: [[Tokens.panel2, 0], [Tokens.panel, 1]]
      }
      : undefined)
    .translate({ y: this.pressed ? 1 : 0 })
    .accessibilityText(this.iconName)
    .onClick(() => {
      this.onTap();
    })
    .onTouch((e: TouchEvent) => {
      if (e.type === TouchType.Down) {
        this.pressed = true;
      } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
        this.pressed = false;
      }
    })
  }
}
