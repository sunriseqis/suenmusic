/**
 * 统一输入框（对齐 web NeuInput 的凹陷形态）。
 *
 * 系统 TextInput 默认配色压在深色面板上文字/占位几乎不可见（T10 批次 C 用户手测反馈），
 * 这里显式钉死全部颜色与尺寸：bg 凹陷底 + 发丝描边 + t1 文字 + t2 占位 + 琥珀光标。
 * 内容通过 @Link 与父组件双向同步（@Builder 参数按值传递不建立响应依赖，必须走 Link）。
 *
 * T10 批次 E：可选前置放大镜图标（web NeuInput `icon="search"`，收藏内搜索用）。
 * 结构从「TextInput 自带底色描边」改为「Row 容器承载凹陷形态 + TextInput 透明嵌入」，
 * 图标才能落进凹陷区内；无图标时视觉与旧版完全一致。
 */

import { Tokens } from '../common/Tokens';
import { Dim } from '../common/Dimension';
import { WebIcon, WebIconName } from '../common/WebIcons';

@Component
export struct NeuInput {
  /** 输入内容（@Link 双向同步，父组件用 @State 同名状态初始化） */
  @Link content: string;
  placeholder: string = '';
  password: boolean = false;
  /** 前置放大镜图标（web NeuInput icon="search"） */
  searchIcon: boolean = false;
  /** 软键盘「搜索」键提交（SearchPage 用；不传则只当普通输入框） */
  onSubmit: (value: string) => void = () => {};
  /** 软键盘动作键类型（搜索场景传 EnterKeyType.Search，键盘才显示「搜索」） */
  enterKey: EnterKeyType = EnterKeyType.Done;

  build() {
    Row({ space: Dim.s2 }) {
      if (this.searchIcon) {
        WebIcon(WebIconName.SEARCH, Dim.iconSm, Tokens.text2)
      }
      TextInput({ text: this.content, placeholder: this.placeholder })
        .type(this.password ? InputType.Password : InputType.Normal)
        .height(Dim.touchMin)
        .fontSize(Dim.fsBody)
        .fontColor(Tokens.text1)
        .placeholderColor(Tokens.text2)
        .placeholderFont({ size: Dim.fsBody })
        .caretColor(Tokens.accent)
        .backgroundColor(Color.Transparent)
        .padding(0)
        .layoutWeight(1)
        .onChange((v: string) => {
          this.content = v;
        })
        .enterKeyType(this.enterKey)
        .onSubmit((enterKey: EnterKeyType, event: SubmitEvent) => {
          this.onSubmit(this.content);
        })
    }
    .height(Dim.touchMin)
    .backgroundColor(Tokens.bg)
    .borderRadius(Dim.radiusMd)
    .border({ width: Dim.hairline, color: Tokens.line })
    .padding({ left: Dim.s3, right: Dim.s3 })
    .alignItems(VerticalAlign.Center)
  }
}
