/**
 * 骨架屏（S4 §六）：首页 / 搜索 / 收藏首次加载时替代 `LoadingProgress`
 * —— 灰条（封面位 + 双文本条）+ 呼吸脉动，冷启动首屏不再是转圈。
 *
 * T5.5：首页传 `withPoster: true` 时先渲染一段「海报占位」（横排两张方卡，
 * 与新碟 Swiper 同构）再接列表条 —— 骨架与真实区块顺序一致（web Home.vue
 * 的 sk-posters 先行），加载完成时页面不会突然长高。
 */
import { Dim, Motion } from '../common/Dimension';
import { Tokens } from '../common/Tokens';

@Component
export struct SkeletonList {
  @State pulse: number = 0.45;
  /** 首页骨架：前置一段海报占位（新碟 Swiper 的影子） */
  withPoster: boolean = false;

  aboutToAppear(): void {
    // 呼吸脉动：200ms EaseOut 往返、无限循环（组件销毁即停），不超 300ms 红线
    this.getUIContext().animateTo(
      { duration: Motion.standard, curve: Motion.curve, iterations: -1, playMode: PlayMode.Alternate },
      () => {
        this.pulse = 1;
      }
    );
  }

  /** 海报占位：两张 1:1 方卡横排，宽度对齐真实海报大卡（62% 屏宽切两半） */
  @Builder
  posterBlock() {
    Row({ space: Dim.s4 }) {
      Column()
        .layoutWeight(1)
        .aspectRatio(1)
        .borderRadius(Dim.radiusMd)
        .backgroundColor(Tokens.panel2)
        .opacity(this.pulse)
      Column()
        .layoutWeight(1)
        .aspectRatio(1)
        .borderRadius(Dim.radiusMd)
        .backgroundColor(Tokens.panel2)
        .opacity(this.pulse)
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s3 })
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
      if (this.withPoster) {
        this.posterBlock()
      }
      this.skeletonRow()
      this.skeletonRow()
      this.skeletonRow()
    }
    .width('100%')
  }
}
