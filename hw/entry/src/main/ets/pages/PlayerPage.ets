/**
 * 全屏播放页（S3：封面 / 歌词 / 队列 三视图；S4 打磨：交叉淡入/按压动效/热区）。
 *
 * 三个视图只切换**展示**，播放状态机始终在 `MediaPlayerCore` 里 ——
 * 切视图不许碰播放（除歌词点击 = seek 这一条明确意图）。
 * 三视图切换 = 100ms 交叉淡入（S4 §二快动效）。
 */

import {
  MediaPlayerCore, K_TITLE, K_ARTIST, K_COVER, K_PLAYING, K_POS, K_DUR, K_INDEX
} from '../core/MediaPlayerCore';
import { Tokens } from '../common/Tokens';
import { Dim, Motion } from '../common/Dimension';
import { LyricView } from './LyricView';
import { QueueView } from './QueueView';

@Component
export struct PlayerPage {
  @StorageLink(K_TITLE) title: string = '';
  @StorageLink(K_ARTIST) artist: string = '';
  @StorageLink(K_COVER) cover: string = '';
  @StorageLink(K_PLAYING) playing: boolean = false;
  @StorageLink(K_POS) positionMs: number = 0;
  @StorageLink(K_DUR) durationMs: number = 1;
  @StorageLink(K_INDEX) index: number = -1;
  @StorageLink('np_error') err: string = '';

  // 窗口全屏布局下的系统避让区实时值（顶部「收起」与底部进度条需避开刘海/手势条）
  @StorageProp('topAvoidHeight') topAvoidHeight: number = 0;
  @StorageProp('bottomAvoidHeight') bottomAvoidHeight: number = 0;

  // 按压缩放（S4 §二：0.96 回弹）
  @State prevPressed: boolean = false;
  @State playPressed: boolean = false;
  @State nextPressed: boolean = false;

  /** 避让区 px → vp（走 UIContext 实例方法，全局 px2vp 已弃用） */
  private avoidVp(px: number): number {
    return this.getUIContext().px2vp(px);
  }

  /** 0 = 封面 / 1 = 歌词 / 2 = 队列 */
  @State mode: number = 0;
  /**
   * 拖动进度条期间（Begin→Moving）**不能用播放位置驱动滑块**：
   * 播放器每秒推一次 positionMs，会把手指拖到的位置反复拽回去。
   * 松手（End）/ 点击（Click）才真正 seek 一次 —— 也避免拖动时把
   * seek 请求打成串（AVPlayer 的 seek 很贵）。
   */
  @State dragging: boolean = false;
  @State dragPos: number = 0;

  onClose: () => void = () => {};

  private mmss(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  @Builder
  modeButton(label: string, value: number) {
    Text(label)
      .fontSize(Dim.fsBody)
      .fontColor(this.mode === value ? Tokens.accent : Tokens.text2)
      .padding({ left: Dim.s3, right: Dim.s3 })
      .constraintSize({ minHeight: Dim.touchMin })
      .borderRadius(Dim.radiusPill)
      .backgroundColor(this.mode === value ? Tokens.panel : Color.Transparent)
      .onClick(() => { this.mode = value; })
  }

  @Builder
  coverView() {
    Column({ space: Dim.s4 }) {
      Image(this.cover.length > 0 ? this.cover : $r('app.media.app_icon'))
        .width(Dim.coverXl)
        .height(Dim.coverXl)
        .borderRadius(Dim.radiusLg)
        .objectFit(ImageFit.Cover)
      Column({ space: Dim.s2 }) {
        Text(this.title)
          .fontSize(Dim.fsDisplay)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text1)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Center)
        Text(this.artist).fontSize(Dim.fsBody).fontColor(Tokens.text2).maxLines(1)
      }
      .width('100%')
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  bottomBar() {
    Column({ space: Dim.s2 }) {
      Slider({
        value: this.dragging ? this.dragPos : Math.min(this.positionMs, this.durationMs),
        min: 0,
        max: Math.max(1, this.durationMs),
        step: 1000
      })
        .selectedColor(Tokens.accent)
        .trackColor(Tokens.panel)
        .blockColor(Tokens.accent)
        .onChange((v: number, mode: SliderChangeMode) => {
          if (mode === SliderChangeMode.Begin) {
            this.dragging = true;
            this.dragPos = v;
          } else if (mode === SliderChangeMode.Moving) {
            this.dragPos = v;
          } else {
            this.dragging = false;
            MediaPlayerCore.shared().seek(Math.round(v));
          }
        })
      Row() {
        Text(this.mmss(this.positionMs)).fontSize(Dim.fsCaption).fontColor(Tokens.text2)
        Blank()
        Text(this.mmss(this.durationMs)).fontSize(Dim.fsCaption).fontColor(Tokens.text2)
      }
      .width('100%')

      Row({ space: Dim.s6 }) {
        Button('上一首')
          .height(Dim.touchMin)
          .fontSize(Dim.fsBody)
          .backgroundColor(Tokens.panel)
          .fontColor(Tokens.text1)
          .scale({ x: this.prevPressed ? Motion.pressScale : 1, y: this.prevPressed ? Motion.pressScale : 1 })
          .onTouch((e: TouchEvent) => {
            if (e.type === TouchType.Down) {
              this.prevPressed = true;
            } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
              this.prevPressed = false;
            }
          })
          .accessibilityText('上一首')
          .onClick(() => { MediaPlayerCore.shared().prev(); })
        Button(this.playing ? '暂停' : '播放')
          .height(Dim.touchMin)
          .width(Dim.btnPlayW)
          .fontSize(Dim.fsSub)
          .backgroundColor(Tokens.accent)
          .fontColor(Tokens.bg)
          .scale({ x: this.playPressed ? Motion.pressScale : 1, y: this.playPressed ? Motion.pressScale : 1 })
          .onTouch((e: TouchEvent) => {
            if (e.type === TouchType.Down) {
              this.playPressed = true;
            } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
              this.playPressed = false;
            }
          })
          .accessibilityText(this.playing ? '暂停' : '播放')
          .onClick(() => { MediaPlayerCore.shared().toggle(); })
        Button('下一首')
          .height(Dim.touchMin)
          .fontSize(Dim.fsBody)
          .backgroundColor(Tokens.panel)
          .fontColor(Tokens.text1)
          .scale({ x: this.nextPressed ? Motion.pressScale : 1, y: this.nextPressed ? Motion.pressScale : 1 })
          .onTouch((e: TouchEvent) => {
            if (e.type === TouchType.Down) {
              this.nextPressed = true;
            } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
              this.nextPressed = false;
            }
          })
          .accessibilityText('下一首')
          .onClick(() => { MediaPlayerCore.shared().next(); })
      }
      .justifyContent(FlexAlign.Center)
      .width('100%')

      if (this.err.length > 0) {
        Text(this.err)
          .fontSize(Dim.fsMinor)
          .fontColor('#E5484D')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Center)
        // 播放失败可重试（T4）：重装当前曲，清错误横幅
        Button('重试')
          .height(Dim.touchMin)
          .fontSize(Dim.fsMinor)
          .backgroundColor(Tokens.panel2)
          .fontColor(Tokens.text1)
          .accessibilityText('重试播放当前歌曲')
          .onClick(() => {
            this.err = '';
            MediaPlayerCore.shared().retryCurrent();
          })
      }
    }
    .width('100%')
    .padding({ top: Dim.s2, bottom: Dim.s2 })
  }

  build() {
    Column() {
      // 顶栏：收起 + 三视图切换
      Row() {
        Text('收起')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text2)
          .constraintSize({ minHeight: Dim.touchMin })
          .accessibilityText('收起播放页')
          .onClick(() => { this.onClose(); })
        Blank()
        Row({ space: Dim.s1 }) {
          this.modeButton('封面', 0)
          this.modeButton('歌词', 1)
          this.modeButton('队列', 2)
        }
      }
      .width('100%')
      .padding({ top: Dim.s1, bottom: Dim.s2 })

      // 三视图交叉淡入（S4 §二：100ms，快动效档）
      if (this.mode === 0) {
        Column() { this.coverView() }
          .layoutWeight(1)
          .width('100%')
          .transition(TransitionEffect.OPACITY.animation({ duration: Motion.fast, curve: Motion.curve }))
      } else if (this.mode === 1) {
        Column() { LyricView() }
          .layoutWeight(1)
          .width('100%')
          .transition(TransitionEffect.OPACITY.animation({ duration: Motion.fast, curve: Motion.curve }))
      } else {
        Column() { QueueView() }
          .layoutWeight(1)
          .width('100%')
          .transition(TransitionEffect.OPACITY.animation({ duration: Motion.fast, curve: Motion.curve }))
      }

      this.bottomBar()
    }
    .width('100%')
    .height('100%')
    .padding({
      left: Dim.s5,
      right: Dim.s5,
      top: this.avoidVp(this.topAvoidHeight) + Dim.s3,
      bottom: this.avoidVp(this.bottomAvoidHeight) + Dim.s4
    })
    .backgroundColor(Tokens.bg)
  }
}
