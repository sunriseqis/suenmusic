/**
 * 统一空态（S4 §五）：图标（可选）+ 标题 + 副文案 + 可选按钮。
 *
 * 五种场景（文案在 `Copy.ets`，禁止页面自造）：
 * 搜索无结果 / 收藏为空 / 每日 shortfall / 歌词无 / 队列空。
 * 图标只允许 `sys.symbol`（禁止 emoji 当图标）。
 */
import { Dim } from '../common/Dimension';
import { Tokens } from '../common/Tokens';

@Component
export struct EmptyState {
  /** 可选图标（`$r('sys.symbol.magnifyingglass')` 这类），不传则只有文字 */
  icon: Resource | undefined = undefined;
  title: string = '';
  subtitle: string = '';
  actionLabel: string = '';
  onAction: () => void = () => {};

  build() {
    Column({ space: Dim.s2 }) {
      if (this.icon !== undefined) {
        SymbolGlyph(this.icon)
          .fontSize(Dim.iconXl)
          .fontColor([Tokens.text2])
      }
      Text(this.title)
        .fontSize(Dim.fsBody)
        .fontColor(Tokens.text1)
      if (this.subtitle.length > 0) {
        Text(this.subtitle)
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.text2)
      }
      if (this.actionLabel.length > 0) {
        Button(this.actionLabel)
          .height(Dim.touchMin)
          .fontSize(Dim.fsSub)
          .backgroundColor(Tokens.panel)
          .fontColor(Tokens.text1)
          .onClick(() => { this.onAction(); })
      }
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }
}
