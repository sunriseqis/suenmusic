/**
 * 全屏播放页（S3：封面 / 歌词 / 队列 三视图）。
 *
 * 三个视图只切换**展示**，播放状态机始终在 `MediaPlayerCore` 里 ——
 * 切视图不许碰播放（除歌词点击 = seek 这一条明确意图）。
 */

import {
  MediaPlayerCore, K_TITLE, K_ARTIST, K_COVER, K_PLAYING, K_POS, K_DUR, K_INDEX
} from '../core/MediaPlayerCore';
import { Tokens } from '../common/Tokens';
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
      .fontSize(13)
      .fontColor(this.mode === value ? Tokens.accent : Tokens.text2)
      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
      .borderRadius(14)
      .backgroundColor(this.mode === value ? Tokens.panel : Color.Transparent)
      .onClick(() => { this.mode = value; })
  }

  @Builder
  coverView() {
    Column({ space: 18 }) {
      Image(this.cover.length > 0 ? this.cover : $r('app.media.app_icon'))
        .width(280)
        .height(280)
        .borderRadius(16)
        .objectFit(ImageFit.Cover)
      Column({ space: 6 }) {
        Text(this.title)
          .fontSize(20)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text1)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Center)
        Text(this.artist).fontSize(13).fontColor(Tokens.text2).maxLines(1)
      }
      .width('100%')
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  bottomBar() {
    Column({ space: 10 }) {
      Slider({
        value: this.dragging ? this.dragPos : Math.min(this.positionMs, this.durationMs),
        min: 0,
        max: Math.max(1, this.durationMs),
        step: 1000
      })
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
        Text(this.mmss(this.positionMs)).fontSize(11).fontColor(Tokens.text2)
        Blank()
        Text(this.mmss(this.durationMs)).fontSize(11).fontColor(Tokens.text2)
      }
      .width('100%')

      Row({ space: 28 }) {
        Button('上一首')
          .height(40)
          .fontSize(13)
          .backgroundColor(Tokens.panel)
          .fontColor(Tokens.text1)
          .onClick(() => { MediaPlayerCore.shared().prev(); })
        Button(this.playing ? '暂停' : '播放')
          .height(44)
          .width(96)
          .fontSize(14)
          .backgroundColor(Tokens.accent)
          .fontColor(Tokens.bg)
          .onClick(() => { MediaPlayerCore.shared().toggle(); })
        Button('下一首')
          .height(40)
          .fontSize(13)
          .backgroundColor(Tokens.panel)
          .fontColor(Tokens.text1)
          .onClick(() => { MediaPlayerCore.shared().next(); })
      }
      .justifyContent(FlexAlign.Center)
      .width('100%')

      if (this.err.length > 0) {
        Text(this.err)
          .fontSize(12)
          .fontColor('#E5484D')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Center)
        // 播放失败可重试（T4）：重装当前曲，清错误横幅
        Button('重试')
          .height(28)
          .fontSize(12)
          .backgroundColor(Tokens.panel2)
          .fontColor(Tokens.text1)
          .onClick(() => {
            this.err = '';
            MediaPlayerCore.shared().retryCurrent();
          })
      }
    }
    .width('100%')
    .padding({ top: 8, bottom: 8 })
  }

  build() {
    Column() {
      // 顶栏：收起 + 三视图切换
      Row() {
        Text('收起')
          .fontSize(13)
          .fontColor(Tokens.text2)
          .onClick(() => { this.onClose(); })
        Blank()
        Row({ space: 4 }) {
          this.modeButton('封面', 0)
          this.modeButton('歌词', 1)
          this.modeButton('队列', 2)
        }
      }
      .width('100%')
      .padding({ top: 4, bottom: 8 })

      if (this.mode === 0) {
        this.coverView()
      } else if (this.mode === 1) {
        LyricView()
      } else {
        QueueView()
      }

      this.bottomBar()
    }
    .width('100%')
    .height('100%')
    .padding({
      left: 20,
      right: 20,
      top: this.avoidVp(this.topAvoidHeight) + 12,
      bottom: this.avoidVp(this.bottomAvoidHeight) + 16
    })
    .backgroundColor(Tokens.bg)
  }
}
