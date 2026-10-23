import { Tokens } from './Tokens';
import { Dim, Motion } from './Dimension';
import { WebIcon, WebIconName } from './WebIcons';

/** 危险语义色（T2 既有豁免，唯一允许的裸色） */
const DANGER = '#E5484D';

/**
 * 「不喜欢」三选弹窗（**自绘哑光风格**）。
 *
 * 用户 2026-10-23 反馈：替换掉系统 `showAlertDialog`（风格割裂）。
 * 结构与页面其余浮层同体系：scrim 背板 + panel 卡片 + 发丝线描边 + 顶沿内高光，
 * 两个选项各自带说明副行，无歌手信息时「这位歌手」置灰。
 *
 * 只负责选范围；落地动作（toast / 移出列表 / 队列摘除）由页面回调承担。
 */
@ComponentV2
export struct DislikeDialog {
  /** 曲名（说明副行用） */
  @Param trackName: string = '';
  /** 歌手名（空 = 无歌手信息，「这位歌手」置灰） */
  @Param artistName: string = '';
  @Event onTrack: () => void = () => {};
  @Event onArtist: () => void = () => {};
  @Event onCancel: () => void = () => {};

  private hasArtist(): boolean {
    return this.artistName.length > 0;
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      // 背板：点空白处 = 取消
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Tokens.scrim)
        .onClick(() => {
          this.onCancel();
        })

      // 哑光卡片
      Column({ space: Dim.s2 }) {
        Text('不喜欢')
          .fontSize(Dim.fsTitle)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text1)
          .width('100%')
        Text(this.trackName.length > 0 ? '《' + this.trackName + '》' : '')
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.text2)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .margin({ bottom: Dim.s1 })

        // ① 不喜欢这首歌
        Row({ space: Dim.s3 }) {
          WebIcon(WebIconName.DISLIKE_SONG, Dim.iconMd, DANGER)
          Column({ space: Dim.s0 }) {
            Text('不喜欢这首歌')
              .fontSize(Dim.fsBody)
              .fontWeight(FontWeight.Medium)
              .fontColor(Tokens.text1)
            Text('后续不再推荐这首歌')
              .fontSize(Dim.fsCaption)
              .fontColor(Tokens.text2)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }
        .width('100%')
        .padding(Dim.s3)
        .borderRadius(Dim.radiusSm)
        .backgroundColor(Tokens.panel2)
        .border({ width: Dim.hairline, color: Tokens.line })
        .alignItems(VerticalAlign.Center)
        .accessibilityText('不喜欢这首歌')
        .onClick(() => {
          this.onTrack();
        })

        // ② 不喜欢这位歌手（无歌手信息置灰）
        Row({ space: Dim.s3 }) {
          WebIcon(WebIconName.DISLIKE_ARTIST, Dim.iconMd, this.hasArtist() ? DANGER : Tokens.text2)
          Column({ space: Dim.s0 }) {
            Text('不喜欢这位歌手')
              .fontSize(Dim.fsBody)
              .fontWeight(FontWeight.Medium)
              .fontColor(Tokens.text1)
            Text(this.hasArtist() ? '后续不再推荐歌手「' + this.artistName + '」' : '这首歌没有歌手信息')
              .fontSize(Dim.fsCaption)
              .fontColor(Tokens.text2)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }
        .width('100%')
        .padding(Dim.s3)
        .borderRadius(Dim.radiusSm)
        .backgroundColor(Tokens.panel2)
        .border({ width: Dim.hairline, color: Tokens.line })
        .alignItems(VerticalAlign.Center)
        .opacity(this.hasArtist() ? 1 : 0.5)
        .accessibilityText('不喜欢这位歌手')
        .onClick(() => {
          if (this.hasArtist()) {
            this.onArtist();
          }
        })

        // ③ 取消（无厚度，贴卡片底部）
        Row() {
          Text('取消')
            .fontSize(Dim.fsBody)
            .fontColor(Tokens.text2)
        }
        .width('100%')
        .height(Dim.touchMin)
        .justifyContent(FlexAlign.Center)
        .accessibilityText('取消')
        .onClick(() => {
          this.onCancel();
        })
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
