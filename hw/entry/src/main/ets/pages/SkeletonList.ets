/**
 * 骨架屏（S4 §六）：首页 / 搜索 / 收藏首次加载时替代 `LoadingProgress`
 * —— 3 行灰条（封面位 + 双文本条）+ 呼吸脉动，冷启动首屏不再是转圈。
 */
import { Dim, Motion } from '../common/Dimension';
import { Tokens } from '../common/Tokens';

@Component
export struct SkeletonList {
  @State pulse: number = 0.45;

  aboutToAppear(): void {
    // 呼吸脉动：200ms EaseOut 往返、无限循环（组件销毁即停），不超 300ms 红线
    this.getUIContext().animateTo(
      { duration: Motion.standard, curve: Motion.curve, iterations: -1, playMode: PlayMode.Alternate },
      () => {
        this.pulse = 1;
      }
    );
  }

  @Builder
  skeletonRow() {
    Row({ space: Dim.s3 }) {
      Column()
        .width(Dim.coverSm)
        .height(Dim.coverSm)
        .borderRadius(Dim.radiusSm)
        .backgroundColor(Tokens.panel2)
        .opacity(this.pulse)
      Column({ space: Dim.s2 }) {
        Column()
          .width('70%')
          .height(Dim.s5)
          .borderRadius(Dim.radiusRow)
          .backgroundColor(Tokens.panel2)
          .opacity(this.pulse)
        Column()
          .width('45%')
          .height(Dim.s4)
          .borderRadius(Dim.radiusRow)
          .backgroundColor(Tokens.panel2)
          .opacity(this.pulse)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .height(Dim.rowHeight)
    .padding({ left: Dim.s4, right: Dim.s4 })
  }

  build() {
    Column() {
      this.skeletonRow()
      this.skeletonRow()
      this.skeletonRow()
    }
    .width('100%')
  }
}
