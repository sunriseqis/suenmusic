/**
 * 统一输入框（对齐 web NeuInput 的凹陷形态）。
 *
 * 系统 TextInput 默认配色压在深色面板上文字/占位几乎不可见（T10 批次 C 用户手测反馈），
 * 这里显式钉死全部颜色与尺寸：bg 凹陷底 + 发丝描边 + t1 文字 + t2 占位 + 琥珀光标。
 * 内容通过 @Link 与父组件双向同步（@Builder 参数按值传递不建立响应依赖，必须走 Link）。
 */

import { Tokens } from '../common/Tokens';
import { Dim } from '../common/Dimension';

@Component
export struct NeuInput {
  /** 输入内容（@Link 双向同步，父组件用 @State 同名状态初始化） */
  @Link content: string;
  placeholder: string = '';
  password: boolean = false;

  build() {
    TextInput({ text: this.content, placeholder: this.placeholder })
      .type(this.password ? InputType.Password : InputType.Normal)
      .height(Dim.touchMin)
      .fontSize(Dim.fsBody)
      .fontColor(Tokens.text1)
      .placeholderColor(Tokens.text2)
      .placeholderFont({ size: Dim.fsBody })
      .caretColor(Tokens.accent)
      .backgroundColor(Tokens.bg)
      .borderRadius(Dim.radiusMd)
      .border({ width: Dim.hairline, color: Tokens.line })
      .padding({ left: Dim.s3, right: Dim.s3 })
      .onChange((v: string) => {
        this.content = v;
      })
  }
}
