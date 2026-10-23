/**
 * 分段标签页（T10 收官第 ⑯⑰⑱ 条，web `NeuTabs.vue` 1:1）。
 *
 * 选中项用**凸起**表达（panel2 底 + 顶沿内高光 + Bold），而不是强调色 ——
 * web 铁律：分段标签连橙色都不用（搜索四个分片全染橙会非常吵）。
 *
 * 导轨：凹陷形态（bg 底 + line 描边 + radiusMd）内嵌 3px padding、2px gap；
 * 格子：minHeight 32（segH）、fs-sm 13、非选 Medium t2 / 选中 Bold t1。
 *
 * 使用方：SearchPage 四分片、SettingsPage 三分段 —— 禁止页面再手搓 sliceButton/segCell。
 */

import { Tokens } from './Tokens';
import { Dim } from './Dimension';

@Component
export struct NeuTabs {
  /** 标签文案（顺序即 value 顺序） */
  @Prop labels: string[] = [];
  /** 选中下标 */
  @Prop activeIndex: number = 0;
  onSelect: (index: number) => void = () => {};

  build() {
    Row({ space: Dim.s0 }) {
      ForEach(this.labels, (label: string, i: number) => {
        Text(label)
          .fontSize(Dim.fsBody)
          .fontWeight(this.activeIndex === i ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.activeIndex === i ? Tokens.text1 : Tokens.text2)
          .textAlign(TextAlign.Center)
          .constraintSize({ minHeight: Dim.segH })
          .padding({ left: Dim.s4, right: Dim.s4 })
          .layoutWeight(1)
          .borderRadius(Dim.radiusRow)
          .backgroundColor(this.activeIndex === i ? Tokens.panel2 : Color.Transparent)
          .border(this.activeIndex === i
            ? { width: { top: Dim.hairline }, color: { top: Tokens.hi } }
            : { width: 0 })
          .accessibilityText(label)
          .accessibilityLevel(this.activeIndex === i ? 'yes' : 'no')
          .onClick(() => {
            this.onSelect(i);
          })
      }, (label: string, i: number) => `${i}_${label}`)
    }
    .width('100%')
    .padding(Dim.s0)
    .borderRadius(Dim.radiusMd)
    .backgroundColor(Tokens.bg)
    .border({ width: Dim.hairline, color: Tokens.line })
  }
}
