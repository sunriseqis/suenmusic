import { Tokens } from './Tokens';
import { Dim, Motion } from './Dimension';
import { WebButton, NeuBtnVariant, NeuBtnSize } from './WebButtons';

/**
 * 通用二次确认弹窗（**自绘哑光风格**，不用系统 AlertDialog）。
 *
 * 与 `DislikeDialog` 同一套质感：scrim 背板 + panel 卡片 + 发丝线描边 + 大圆角。
 * 两枚按钮走 `WebButton`（取消 = 默认键 / 确认 = danger 时透明底红字）。
 */
@ComponentV2
export struct ConfirmDialog {
  @Param titleStr: string = '';
  @Param messageStr: string = '';
  @Param confirmLabel: string = '确定';
  @Param cancelLabel: string = '取消';
  /** 危险操作（确认键红字，web .v-danger 口径：透明底红字，不做红填充） */
  @Param dangerFlag: boolean = false;
  /** 单按钮（信息型弹窗：只有「知道了」，不给取消）—— T8 关于/卡片说明用 */
  @Param singleFlag: boolean = false;
  @Event onConfirm: () => void = () => {};
  @Event onCancel: () => void = () => {};

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Tokens.scrim)
        .onClick(() => {
          this.onCancel();
        })

      Column({ space: Dim.s3 }) {
        Text(this.titleStr)
          .fontSize(Dim.fsTitle)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text1)
          .width('100%')
        Text(this.messageStr)
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text2)
          .width('100%')

        Row({ space: Dim.s2 }) {
          if (!this.singleFlag) {
          WebButton({
            labelStr: this.cancelLabel,
            variantKind: NeuBtnVariant.DEFAULT,
            sizeKind: NeuBtnSize.MD,
            blockFlag: true,
            onTap: () => {
              this.onCancel();
            }
          })
            .layoutWeight(1)
          }
          WebButton({
            labelStr: this.confirmLabel,
            variantKind: this.dangerFlag ? NeuBtnVariant.DANGER : NeuBtnVariant.PRIMARY,
            sizeKind: NeuBtnSize.MD,
            blockFlag: true,
            onTap: () => {
              this.onConfirm();
            }
          })
            .layoutWeight(1)
        }
        .width('100%')
        .padding({ top: Dim.s1 })
      }
      .width('86%')
      .padding(Dim.s4)
      .borderRadius(Dim.radiusLg)
      .backgroundColor(Tokens.panel)
      .border({ width: Dim.hairline, color: Tokens.line })
      .transition(TransitionEffect.OPACITY
        .animation({ duration: Motion.fast, curve: Motion.curve }))
    }
    .width('100%')
    .height('100%')
  }
}
