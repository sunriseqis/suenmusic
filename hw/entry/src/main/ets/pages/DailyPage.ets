import { hilog } from '@kit.PerformanceAnalysisKit';
import { APIClient, ApiError } from '../core/APIClient';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { DailyRecommend, Track } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { Copy, parseAiHeader } from '../common/Copy';
import { Dim } from '../common/Dimension';
import { AppToast } from '../common/AppToast';
import { DislikeDialog } from '../common/DislikeDialog';
import { TrackItem } from './TrackItem';
import { EmptyState } from './EmptyState';
import { SkeletonList } from './SkeletonList';
import { WebButton, NeuBtnSize } from '../common/WebButtons';
import { AppState, K_DAILY_REFRESH } from '../viewmodel/AppState';

const TAG = 'SuenMusic_Daily';
/** greeting 拆不出主标题时的回退页名（web parseAiHeader 默认值同款） */
const DEFAULT_HEADER_TITLE = '专属推荐';

/**
 * 每日推荐：只读（歌单由服务端每天 00:30 产出，无「换一批」）。
 *
 * **`shortfall` 不是错误** —— 曲库不足是正常业务结果，界面给统一空态
 * （S4 §五：日历图标 + 引导文案），不重试、不报错。
 * 行尾「不喜欢」双钮（T10 批次 A）：track / artist 两级调优，
 * 服务端落地后从「当日歌单 + 播放队列」同时摘掉（web Daily.vue 同口径）。
 */
@Component
export struct DailyPage {
  @State data: DailyRecommend | null = null;
  @State loading: boolean = false;
  @State err: string = '';
  /** 已收藏曲目 id（右滑手势的文案/序号染色用，失败静默） */
  @State favIds: string[] = [];
  /** 待确认的「不喜欢」目标（null = 弹窗关）；弹窗由页面持有，行组件只上报点击 */
  @State dislikeAsk: Track | null = null;
  /** 播放页 dislike 当前曲后 +1（服务端已过滤，重拉即最新） */
  @StorageProp(K_DAILY_REFRESH) @Watch('onDailyRev') dailyRev: number = 0;

  aboutToAppear(): void { this.load(); }

  /** 播放页的 dislike 落地后重拉当日歌单（跨页同步，不靠切 Tab 触发） */
  private onDailyRev(): void {
    this.load();
  }

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

  // ---------------- 专属推荐语（greeting → 主标题/副题，web parseAiHeader 同口径） ----------------
  // 首页欢迎语（welcomePhrase）只属于首页 —— 本页不渲染，两个概念彻底分开（T5.5 用户反馈）。

  private headerTitle(): string {
    const g = this.data === null ? '' : (this.data.greeting ?? '');
    return parseAiHeader(g, DEFAULT_HEADER_TITLE).title;
  }

  private headerSub(): string {
    const g = this.data === null ? '' : (this.data.greeting ?? '');
    return parseAiHeader(g, DEFAULT_HEADER_TITLE).sub;
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
          duration: 2000,
          alignment: Alignment.Bottom
        });
      } catch (toastErr) {
        hilog.warn(0x0000, 'SuenMusic_Fav', 'toast 显示失败: %{public}s', JSON.stringify(toastErr));
      }
      hilog.warn(0x0000, 'SuenMusic_Fav', '收藏切换失败: %{public}s', JSON.stringify(e));
      return false;
    }
  }

  // ---------------- 不喜欢调优（T10 批次 A，web Daily.vue dislikeTrack/dislikeArtist 同口径） ----------------

  /** 轻提示走自绘 AppToast（系统 toast 位置不可控，用户 2026-10-23 反馈「提示漂移」） */
  private showToast(message: string): void {
    AppToast.show(message);
  }

  /** 把一首歌从「当日歌单 + 播放队列」里同时摘掉。自然缩水，不补位。 */
  private removeFromList(track: Track): void {
    const core = MediaPlayerCore.shared();
    const q = core.getQueueSnapshot();
    for (let i = 0; i < q.length; i++) {
      if (q[i].id === track.id) {
        void core.removeAt(i);
        break;
      }
    }
    if (this.data === null) { return; }
    const next: Track[] = [];
    for (let i = 0; i < this.data.tracks.length; i++) {
      if (this.data.tracks[i].id !== track.id) { next.push(this.data.tracks[i]); }
    }
    this.data.tracks = next;
  }

  private async dislikeTrack(track: Track): Promise<void> {
    try {
      await APIClient.shared().dislike('track', track.id, track.name);
    } catch (e) {
      this.showToast(Copy.describeError(e));
      return;
    }
    this.showToast(`已不再推荐「${track.name}」`);
    this.removeFromList(track);
  }

  private async dislikeArtist(track: Track): Promise<void> {
    const first = track.ar.length > 0 ? track.ar[0] : null;
    const mid = first === null ? '' : (first.mid ?? '');
    const name = first === null ? '' : first.name;
    if (mid.length === 0) {
      this.showToast('这首曲目没有可识别的歌手信息');
      return;
    }
    try {
      await APIClient.shared().dislike('artist', mid, name);
    } catch (e) {
      this.showToast(Copy.describeError(e));
      return;
    }
    this.showToast(`已不再推荐歌手「${name}」的相关歌曲`);
    if (this.data === null) { return; }
    // 该歌手的所有歌都从当日歌单与队列里移除（快照迭代，removeFromList 逐首摘）
    const targets: Track[] = [];
    for (let i = 0; i < this.data.tracks.length; i++) {
      const t = this.data.tracks[i];
      const a = t.ar.length > 0 ? t.ar[0] : null;
      if (a !== null && (a.mid ?? '') === mid) { targets.push(t); }
    }
    for (let i = 0; i < targets.length; i++) {
      this.removeFromList(targets[i]);
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
      await MediaPlayerCore.shared().setQueue(data.tracks, index, token, '每日推荐');
    } catch (e) {
      this.err = Copy.describeError(e);
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  build() {
    // 外层 Stack：列表/空态在 Column 里，「不喜欢」弹窗盖在其上（弹窗自带 scrim 背板）
    Stack() {
      Column() {
      if (this.loading && this.data === null) {
        // 首次加载：骨架屏替代转圈（S4 §六）
        SkeletonList()
      } else if (this.err.length > 0 && this.data === null) {
        Column({ space: Dim.s3 }) {
          Text(this.err).fontSize(Dim.fsBody).fontColor('#E5484D')
          WebButton({
            labelStr: '重试',
            sizeKind: NeuBtnSize.MD,
            onTap: () => { this.load(); }
          })
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (this.data !== null) {
        // 专属推荐语：greeting 首逗号前的短语作主标题、其后作副题小字（web `.head-info` 同构）
        Column({ space: Dim.s1 }) {
          Text(this.headerTitle())
            .fontSize(Dim.fsBrand)
            .fontWeight(FontWeight.Bold)
            .fontColor(Tokens.text1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          if (this.headerSub().length > 0) {
            Text(this.headerSub())
              .fontSize(Dim.fsBody)
              .fontColor(Tokens.text2)
              .width('100%')
          }
        }
        .width('100%')
        .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3 })
        // 第 ⑮ 条：推荐语与曲目列表的间距（web `.daily{gap:sp-4}` = 16px），
        // List 空间不够时间距也会被压没 —— 用 margin 保底
        .margin({ bottom: Dim.s4 })

        if (this.data.tracks.length > 0) {
          List({ space: 0 }) {
            ForEach(this.data.tracks, (t: Track, i: number) => {
              ListItem() {
                TrackItem({
                  track: t,
                  index: i + 1,
                  isFav: this.favIds.indexOf(t.id) >= 0,
                  dislikeable: true,
                  onDislikeTrack: () => { this.dislikeTrack(t); },
                  onDislikeArtist: () => { this.dislikeArtist(t); },
                  onDislikeAsk: () => { this.dislikeAsk = t; },
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
            WebButton({
              labelStr: '重试',
              sizeKind: NeuBtnSize.MD,
              onTap: () => { this.load(); }
            })
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

      // 「不喜欢」选择弹窗（自绘哑光三选；系统 AlertDialog 风格割裂 —— 用户 2026-10-23 反馈）
      if (this.dislikeAsk !== null) {
        DislikeDialog({
          trackName: this.dislikeAsk.name,
          artistName: this.dislikeAsk.ar.length > 0 ? this.dislikeAsk.ar[0].name : '',
          onTrack: (): void => {
            const t = this.dislikeAsk;
            this.dislikeAsk = null;
            if (t !== null) { this.dislikeTrack(t); }
          },
          onArtist: (): void => {
            const t = this.dislikeAsk;
            this.dislikeAsk = null;
            if (t !== null) { this.dislikeArtist(t); }
          },
          onCancel: (): void => {
            this.dislikeAsk = null;
          }
        })
      }
    }
    .width('100%')
    .height('100%')
  }
}
