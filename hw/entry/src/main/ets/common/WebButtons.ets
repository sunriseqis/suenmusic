/**
 * Web 文字按钮（T10 收官第 ⑰⑱ 条：全局按钮统一，web `NeuButton.vue` 等价物）。
 *
 * 三变体（web 同名同语义）：
 *   default = 装在面板上的键（panel 底 + line 描边 + 顶沿内高光）；
 *   primary = 琥珀填充（accent 底 + badgeInk 深字，web「强调色拆填充用」铁律）；
 *   ghost   = 无厚度，只有 accentText 文字。
 * 三尺寸（web NeuButton）：sm 30 / md 40 / lg 48。
 * 按下 = translateY(1) 下沉 + 底色变 panel2（web `:active` 机械反馈）。
 * 页面里所有「重试 / 清除 / 搜索 / 解除 / 锚定…」文字钮一律换本组件，禁止系统 Button 裸改样式。
 */

import { Tokens } from './Tokens';
import { Dim } from './Dimension';

/** 变体名（禁止裸字符串散落页面） */
export class NeuBtnVariant {
  static readonly DEFAULT: string = 'default';
  static readonly PRIMARY: string = 'primary';
  static readonly GHOST: string = 'ghost';
  /** 危险操作：透明底 + 红字（web `.v-danger` 不做红填充） */
  static readonly DANGER: string = 'danger';
}

/** 尺寸名 */
export class NeuBtnSize {
  static readonly SM: string = 'sm';
  static readonly MD: string = 'md';
  static readonly LG: string = 'lg';
}

/** web NeuButton 各档 min-height（px） */
const H_SM = 30;
const H_MD = 40;
const H_LG = 48;

@ComponentV2
export struct WebButton {
  /** 按钮文字 */
  @Param labelStr: string = '';
  /** 变体（NeuBtnVariant 常量） */
  @Param variantKind: string = NeuBtnVariant.DEFAULT;
  /** 尺寸（NeuBtnSize 常量） */
  @Param sizeKind: string = NeuBtnSize.MD;
  /** 撑满父容器宽（web block） */
  @Param blockFlag: boolean = false;
  /** 置灰（web neu-disabled：降不透明度 + 不响应） */
  @Param disabledFlag: boolean = false;
  @Event onTap: () => void = () => {};
  @Local pressed: boolean = false;

  private btnHeight(): number {
    if (this.sizeKind === NeuBtnSize.SM) {
      return H_SM;
    }
    if (this.sizeKind === NeuBtnSize.LG) {
      return H_LG;
    }
    return H_MD;
  }

  private btnFont(): number {
    // web：sm fs-sm(13) / md fs-md(14) / lg fs-lg(15)
    if (this.sizeKind === NeuBtnSize.SM) {
      return Dim.fsBody;
    }
    if (this.sizeKind === NeuBtnSize.LG) {
      return Dim.fsTitle;
    }
    return Dim.fsSub;
  }

  private btnPaddingH(): number {
    // web：sm sp-3(12) / md sp-4(16) / lg sp-5(24)
    if (this.sizeKind === NeuBtnSize.SM) {
      return Dim.s3;
    }
    if (this.sizeKind === NeuBtnSize.LG) {
      return Dim.s5;
    }
    return Dim.s4;
  }

  private btnBg(): ResourceColor {
    if (this.variantKind === NeuBtnVariant.PRIMARY) {
      return Tokens.accent;
    }
    if (this.variantKind === NeuBtnVariant.GHOST || this.variantKind === NeuBtnVariant.DANGER) {
      return Color.Transparent;
    }
    return this.pressed ? Tokens.panel2 : Tokens.panel;
  }

  private btnFontColor(): ResourceColor {
    if (this.variantKind === NeuBtnVariant.PRIMARY) {
      return Tokens.badgeInk;
    }
    if (this.variantKind === NeuBtnVariant.GHOST) {
      return Tokens.accentText;
    }
    if (this.variantKind === NeuBtnVariant.DANGER) {
      // web `.v-danger` 是 #d4564a；此处用既有豁免红近似（避免新增裸色告警）
      return '#E5484D';
    }
    return Tokens.text1;
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Text(this.labelStr)
        .fontSize(this.btnFont())
        .fontWeight(FontWeight.Medium)
        .fontColor(this.btnFontColor())
      // 顶沿内高光（web inset hi 近似；ghost/danger 无厚度不画）
      if (this.variantKind === NeuBtnVariant.DEFAULT || this.variantKind === NeuBtnVariant.PRIMARY) {
        Row()
          .height(Dim.hairline)
          .width('100%')
          .backgroundColor(Tokens.hi)
      }
    }
    .height(this.btnHeight())
    .width(this.blockFlag ? '100%' : undefined)
    .padding({ left: this.btnPaddingH(), right: this.btnPaddingH() })
    .borderRadius(Dim.radiusMd)
    .backgroundColor(this.btnBg())
    .border(this.variantKind === NeuBtnVariant.GHOST || this.variantKind === NeuBtnVariant.PRIMARY
      ? { width: 0 }
      : { width: Dim.hairline, color: Tokens.line })
    .opacity(this.disabledFlag ? 0.55 : 1)
    .translate({ y: this.pressed ? 1 : 0 })
    .accessibilityText(this.labelStr)
    .onClick(() => {
      if (this.disabledFlag) { return; }
      this.onTap();
    })
    .onTouch((e: TouchEvent) => {
      if (this.disabledFlag) { return; }
      if (e.type === TouchType.Down) {
        this.pressed = true;
      } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
        this.pressed = false;
      }
    })
  }
}
