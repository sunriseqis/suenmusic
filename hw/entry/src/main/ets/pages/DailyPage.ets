import { hilog } from '@kit.PerformanceAnalysisKit';
import { APIClient, ApiError } from '../core/APIClient';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { DailyRecommend, Track } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { Copy } from '../common/Copy';
import { Dim, Motion } from '../common/Dimension';
import { TrackItem } from './TrackItem';
import { EmptyState } from './EmptyState';
import { SkeletonList } from './SkeletonList';
import { AppState } from '../viewmodel/AppState';

const TAG = 'SuenMusic_Daily';

/**
 * 每日推荐：只读（歌单由服务端每天 00:30 产出，无「换一批」）。
 *
 * **`shortfall` 不是错误** —— 曲库不足是正常业务结果，界面给统一空态
 * （S4 §五：日历图标 + 引导文案），不重试、不报错。
 * 「播放全部」= 当日歌单整队入 `setQueue`，从第 1 首起播。
 */
@Component
export struct DailyPage {
  @State data: DailyRecommend | null = null;
  @State loading: boolean = false;
  @State err: string = '';
  /** 已收藏曲目 id（右滑手势的文案/序号染色用，失败静默） */
  @State favIds: string[] = [];
  /** 「播放全部」按压缩放动效（S4 §二） */
  @State playAllPressed: boolean = false;

  aboutToAppear(): void { this.load(); }

  private async load(): Promise<void> {
    if (this.loading) { return; }
    this.loading = true;
    this.err = '';
    try {
      this.data = await APIClient.shared().dailyRecommend();
      if (this.data !== null) { this.refreshFavMarks(this.data.tracks); }
    } catch (e) {
      this.err = Copy.describeError(e);
    } finally {
      this.loading = false;
    }
  }

  // ---------------- 收藏标记（右滑手势的支撑，失败静默不打断浏览） ----------------

  private hasFav(trackId: string): boolean {
    return this.favIds.indexOf(trackId) >= 0;
  }

  private setFav(trackId: string, fav: boolean): void {
    const next: string[] = [];
    if (fav) { next.push(trackId); }
    for (let i = 0; i < this.favIds.length; i++) {
      if (this.favIds[i] !== trackId) { next.push(this.favIds[i]); }
    }
    this.favIds = next;
  }

  private async refreshFavMarks(tracks: Track[]): Promise<void> {
    const unknown: string[] = [];
    for (let i = 0; i < tracks.length; i++) {
      if (!this.hasFav(tracks[i].id)) { unknown.push(tracks[i].id); }
    }
    if (unknown.length === 0) { return; }
    try {
      const fav = await APIClient.shared().favoredIds(unknown);
      for (let i = 0; i < fav.length; i++) { this.setFav(fav[i], true); }
    } catch (e) {
      hilog.warn(0x0000, 'SuenMusic_Fav', '拉取收藏标记失败（静默）: %{public}s', JSON.stringify(e));
    }
  }

  /** 右滑过阈值：乐观翻转 + 服务端落地，失败回滚 + Copy 文案 toast */
  private async toggleFav(track: Track): Promise<boolean> {
    const wasFav = this.hasFav(track.id);
    this.setFav(track.id, !wasFav);
    try {
      if (wasFav) {
        await APIClient.shared().removeFavorite(track.id);
      } else {
        await APIClient.shared().addFavorite(track.id, track);
      }
      AppState.shared().bumpFavRev();
      return true;
    } catch (e) {
      this.setFav(track.id, wasFav);
      const msg = (e as ApiError).message;
      try {
        this.getUIContext().getPromptAction().showToast({
          message: msg === undefined ? Copy.favOpFailed : msg,
          duration: 2000
        });
      } catch (toastErr) {
        hilog.warn(0x0000, 'SuenMusic_Fav', 'toast 显示失败: %{public}s', JSON.stringify(toastErr));
      }
      hilog.warn(0x0000, 'SuenMusic_Fav', '收藏切换失败: %{public}s', JSON.stringify(e));
      return false;
    }
  }

  private async playAll(): Promise<void> {
    const data = this.data;
    if (data === null || data.tracks.length === 0) { return; }
    let token = '';
    try {
      token = (await APIClient.shared().streamSessionToken()).token;
    } catch (e) {
      hilog.warn(0x0000, TAG, '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      await MediaPlayerCore.shared().setQueue(data.tracks, 0, token);
    } catch (e) {
      this.err = Copy.describeError(e);
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  private async playAt(index: number): Promise<void> {
    const data = this.data;
    if (data === null) { return; }
    let token = '';
    try {
      token = (await APIClient.shared().streamSessionToken()).token;
    } catch (e) {
      hilog.warn(0x0000, TAG, '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      await MediaPlayerCore.shared().setQueue(data.tracks, index, token);
    } catch (e) {
      this.err = Copy.describeError(e);
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  build() {
    Column() {
      if (this.loading && this.data === null) {
        // 首次加载：骨架屏替代转圈（S4 §六）
        SkeletonList()
      } else if (this.err.length > 0 && this.data === null) {
        Column({ space: Dim.s3 }) {
          Text(this.err).fontSize(Dim.fsBody).fontColor('#E5484D')
          Button('重试')
            .height(Dim.touchMin)
            .fontSize(Dim.fsSub)
            .backgroundColor(Tokens.panel)
            .fontColor(Tokens.text1)
            .onClick(() => { this.load(); })
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (this.data !== null) {
        if (this.data.welcomePhrase !== undefined && this.data.welcomePhrase.length > 0) {
          Text(this.data.welcomePhrase)
            .fontSize(Dim.fsHeadline)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text1)
            .width('100%')
            .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3 })
        }
        if (this.data.greeting !== undefined && this.data.greeting.length > 0) {
          Text(this.data.greeting)
            .fontSize(Dim.fsMinor)
            .fontColor(Tokens.text2)
            .width('100%')
            .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s1 })
        }

        if (this.data.tracks.length > 0) {
          Button('播放全部')
            .width('100%')
            .height(Dim.touchMin)
            .fontSize(Dim.fsSub)
            .backgroundColor(Tokens.accent)
            .fontColor(Tokens.bg)
            .margin({ left: Dim.s4, right: Dim.s4, top: Dim.s3 })
            // 按压缩放回弹（S4 §二：0.96，松手还原）
            .scale({ x: this.playAllPressed ? Motion.pressScale : 1, y: this.playAllPressed ? Motion.pressScale : 1 })
            .onTouch((e: TouchEvent) => {
              if (e.type === TouchType.Down) {
                this.playAllPressed = true;
              } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
                this.playAllPressed = false;
              }
            })
            .onClick(() => { this.playAll(); })
          List({ space: 0 }) {
            ForEach(this.data.tracks, (t: Track, i: number) => {
              ListItem() {
                TrackItem({
                  track: t,
                  index: i + 1,
                  isFav: this.favIds.indexOf(t.id) >= 0,
                  onSwipeToggle: () => this.toggleFav(t),
                  onTap: () => { this.playAt(i); }
                })
              }
            }, (t: Track) => t.id)
          }
          .width('100%')
          .layoutWeight(1)
        } else if (this.data.status === 'shortfall') {
          // 曲库不足：统一空态（日历图标，S4 §五），服务端 message 优先；不是错误、不重试
          EmptyState({
            icon: $r('sys.symbol.calendar'),
            title: this.data.message === undefined ? Copy.emptyDailyTitle : this.data.message,
            subtitle: Copy.emptyDailySub
          })
        } else if (this.data.status === 'generating') {
          EmptyState({
            title: this.data.message === undefined ? '今日歌单正在生成，稍后再来看看' : this.data.message
          })
        } else if (this.data.status === 'error') {
          Column({ space: Dim.s3 }) {
            Text(this.data.message === undefined ? '今日歌单生成失败' : this.data.message)
              .fontSize(Dim.fsBody).fontColor(Tokens.text2)
            Button('重试')
              .height(Dim.touchMin)
              .fontSize(Dim.fsSub)
              .backgroundColor(Tokens.panel)
              .fontColor(Tokens.text1)
              .onClick(() => { this.load(); })
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          // 状态 ready 但曲目被过滤成空：与 shortfall 同口径的统一空态
          EmptyState({
            icon: $r('sys.symbol.calendar'),
            title: Copy.emptyDailyTitle,
            subtitle: Copy.emptyDailySub
          })
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
