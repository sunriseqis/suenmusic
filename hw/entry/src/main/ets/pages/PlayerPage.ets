/**
 * 全屏播放页（S3：封面 / 歌词 / 队列 三视图；S4 打磨：交叉淡入/按压动效/热区）。
 *
 * 三个视图只切换**展示**，播放状态机始终在 `MediaPlayerCore` 里 ——
 * 切视图不许碰播放（除歌词点击 = seek 这一条明确意图）。
 * 三视图切换 = 100ms 交叉淡入（S4 §二快动效）。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  MediaPlayerCore, K_TITLE, K_ARTIST, K_COVER, K_PLAYING, K_POS, K_DUR, K_INDEX, K_TRACKID
} from '../core/MediaPlayerCore';
import { APIClient } from '../core/APIClient';
import { Track } from '../core/Models';
import { AppState } from '../viewmodel/AppState';
import { Tokens } from '../common/Tokens';
import { Dim, Motion } from '../common/Dimension';
import { Copy, cleanAiText } from '../common/Copy';
import { LyricView } from './LyricView';
import { QueueView } from './QueueView';

const TAG = 'SuenMusic_Player';

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
  /** 两级「不喜欢」浮层是否展开（推荐理由卡内，web dislikeMenuOpen） */
  @State dislikeOpen: boolean = false;
  /** 切歌即收起浮层（web watch track.id 同口径） */
  @StorageLink(K_TRACKID) @Watch('onTrackChanged') trackId: string = '';

  private onTrackChanged(): void {
    this.dislikeOpen = false;
  }

  onClose: () => void = () => {};

  // ---------------- 专属推荐理由卡 + 两级不喜欢（T10 批次 A，web FullPlayer has-reco 同构） ----------------

  /** 当前播放曲目（队列快照按下标取；K_INDEX/K_TITLE 变化驱动重渲染） */
  private currentTrack(): Track | null {
    const q = MediaPlayerCore.shared().getQueueSnapshot();
    if (this.index < 0 || this.index >= q.length) { return null; }
    return q[this.index];
  }

  /** 是否携带专属推荐理由（有卡时封面收缩让位，web has-reco） */
  private hasReco(): boolean {
    const t = this.currentTrack();
    return t !== null && t.recommendReason !== undefined && t.recommendReason.length > 0;
  }

  private recoText(): string {
    const t = this.currentTrack();
    if (t === null || t.recommendReason === undefined) { return ''; }
    return cleanAiText(t.recommendReason);
  }

  private firstArtistName(): string {
    const t = this.currentTrack();
    if (t === null || t.ar.length === 0) { return this.artist; }
    return t.ar[0].name;
  }

  private showToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: message, duration: 2000 });
    } catch (e) {
      hilog.warn(0x0000, TAG, 'toast 显示失败: %{public}s', JSON.stringify(e));
    }
  }

  /** 队列里该歌手的歌（当前曲除外）从尾往头删，前面的下标不失效；当前曲最后摘触发切歌 */
  private async removeArtistFromQueue(mid: string, currentId: string): Promise<void> {
    const core = MediaPlayerCore.shared();
    const q = core.getQueueSnapshot();
    const targets: number[] = [];
    for (let i = 0; i < q.length; i++) {
      if (q[i].id === currentId) { continue; }
      const a = q[i].ar.length > 0 ? q[i].ar[0] : null;
      if (a !== null && (a.mid ?? '') === mid) { targets.push(i); }
    }
    targets.sort((a: number, b: number): number => b - a);
    for (let k = 0; k < targets.length; k++) {
      await core.removeAt(targets[k]);
    }
    const q2 = core.getQueueSnapshot();
    for (let i = 0; i < q2.length; i++) {
      if (q2[i].id === currentId) {
        await core.removeAt(i);
        break;
      }
    }
  }

  /** 两级不喜欢落地（web FullPlayer onDislike 同口径）：toast + 队列摘除 + 通知每日页重拉 */
  private async doDislike(kind: string): Promise<void> {
    const t = this.currentTrack();
    if (t === null) { return; }
    this.dislikeOpen = false;
    try {
      if (kind === 'track') {
        await APIClient.shared().dislike('track', t.id, t.name);
        this.showToast(`已将《${t.name}》移出推荐，后续将减少同类推荐`);
        if (this.index >= 0) {
          await MediaPlayerCore.shared().removeAt(this.index);
        }
      } else {
        const first = t.ar.length > 0 ? t.ar[0] : null;
        const mid = first === null ? '' : (first.mid ?? '');
        if (mid.length === 0) {
          this.showToast('该歌曲无歌手信息');
          return;
        }
        await APIClient.shared().dislike('artist', mid, first === null ? '' : first.name);
        this.showToast(`已屏蔽歌手「${first === null ? '' : first.name}」，后续将不再推荐`);
        await this.removeArtistFromQueue(mid, t.id);
      }
    } catch (e) {
      this.showToast(Copy.describeError(e));
      hilog.warn(0x0000, TAG, 'dislike 失败: %{public}s', JSON.stringify(e));
      return;
    }
    AppState.shared().bumpDailyRefresh();
  }

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
      .onClick(() => {
        this.mode = value;
        this.dislikeOpen = false;
      })
  }

  /** 两级不喜欢浮层（web dislike-popover）：两个选项 + 说明副行，展开在推荐卡上方 */
  @Builder
  dislikePop() {
    Column() {
      Row({ space: Dim.s2 }) {
        SymbolGlyph($r('sys.symbol.heart_slash'))
          .fontSize(Dim.iconSm)
          .fontColor(['#E5484D'])
          .margin({ top: Dim.s0 })
        Column({ space: Dim.s0 }) {
          Text('不喜欢这首歌')
            .fontSize(Dim.fsCaption)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text1)
          Text(`后续不再推荐《${this.title}》`)
            .fontSize(Dim.fsCaption)
            .fontColor(Tokens.text2)
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s2, bottom: Dim.s2 })
      .borderRadius(Dim.radiusSm)
      .alignItems(VerticalAlign.Top)
      .onClick(() => {
        this.doDislike('track');
      })

      Divider()
        .strokeWidth(Dim.hairline)
        .color(Tokens.line)
        .margin({ top: Dim.s1, bottom: Dim.s1 })

      Row({ space: Dim.s2 }) {
        SymbolGlyph($r('sys.symbol.person_xmark'))
          .fontSize(Dim.iconSm)
          .fontColor(['#E5484D'])
          .margin({ top: Dim.s0 })
        Column({ space: Dim.s0 }) {
          Text('不喜欢该歌手')
            .fontSize(Dim.fsCaption)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text1)
          Text(`后续不再推荐歌手「${this.firstArtistName()}」`)
            .fontSize(Dim.fsCaption)
            .fontColor(Tokens.text2)
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s2, bottom: Dim.s2 })
      .borderRadius(Dim.radiusSm)
      .alignItems(VerticalAlign.Top)
      .onClick(() => {
        this.doDislike('artist');
      })
    }
    .width(Dim.popW)
    .padding(Dim.s2)
    .borderRadius(Dim.radiusMd)
    .backgroundColor(Tokens.panel)
    .border({ width: Dim.hairline, color: Tokens.line })
    .alignSelf(ItemAlign.End)
  }

  /** 专属推荐理由卡（web m-info-card）：标签 + 不喜欢入口 + 理由正文 */
  @Builder
  recoCard() {
    Column({ space: Dim.s2 }) {
      Row() {
        Text('专属推荐理由')
          .fontSize(Dim.fsCaption)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text2)
        Blank()
        // 两级不喜欢入口（web dislike-trigger-btn）：子组件消费点击，不会冒泡到页面根的收起逻辑
        Row({ space: Dim.s1 }) {
          SymbolGlyph($r('sys.symbol.heart_slash'))
            .fontSize(Dim.iconSm)
            .fontColor([this.dislikeOpen ? '#E5484D' : Tokens.text2])
          Text('不喜欢')
            .fontSize(Dim.fsCaption)
            .fontColor(this.dislikeOpen ? '#E5484D' : Tokens.text2)
          SymbolGlyph(this.dislikeOpen ? $r('sys.symbol.chevron_up') : $r('sys.symbol.chevron_down'))
            .fontSize(Dim.fsCaption)
            .fontColor([Tokens.text2])
        }
        .constraintSize({ minHeight: Dim.btnMd })
        .padding({ left: Dim.s2, right: Dim.s2 })
        .borderRadius(Dim.radiusSm)
        .border({ width: Dim.hairline, color: Tokens.line })
        .backgroundColor(Tokens.panel)
        .onClick(() => {
          this.dislikeOpen = !this.dislikeOpen;
        })
      }
      .width('100%')

      Text(this.recoText())
        .fontSize(Dim.fsMinor)
        .fontColor(Tokens.text2)
        .width('100%')
    }
    .width('100%')
    .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s3, bottom: Dim.s3 })
    .borderRadius(Dim.radiusSm)
    .border({ width: Dim.hairline, color: Tokens.line })
    .backgroundColor(Tokens.panel2)
  }

  @Builder
  coverView() {
    Column({ space: Dim.s4 }) {
      Image(this.cover.length > 0 ? this.cover : $r('app.media.app_icon'))
        .width(this.hasReco() ? Dim.coverReco : Dim.coverXl)
        .height(this.hasReco() ? Dim.coverReco : Dim.coverXl)
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
      if (this.hasReco()) {
        if (this.dislikeOpen) {
          this.dislikePop()
        }
        this.recoCard()
      }
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
    // 不喜欢浮层展开时，点浮层外任意处收起（web pop-backdrop 语义；
    // 浮层内按钮都 stopPropagation，不会误触这条）
    .onClick(() => {
      if (this.dislikeOpen) { this.dislikeOpen = false; }
    })
  }
}
