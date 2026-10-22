import { AppState, K_HOME_REFRESH } from '../viewmodel/AppState';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { HomeData, Track, Toplist, StreamSessionToken } from '../core/Models';
import { ApiError, APIClient } from '../core/APIClient';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Tokens } from '../common/Tokens';
import { Copy } from '../common/Copy';
import { Dim } from '../common/Dimension';
import { TrackItem } from './TrackItem';
import { TrackRow, TrackRowSource } from '../common/TrackSources';
import { SkeletonList } from './SkeletonList';

/** 首页：新歌/榜单（S2 只做能点播的列表；S4 加骨架屏/下拉刷新/懒加载） */
@Component
export struct HomePage {
  @State home: HomeData | null = null;
  @State loading: boolean = false;
  @State err: string = '';
  /** 已收藏曲目 id（右滑手势的文案/序号染色用，失败静默） */
  @State favIds: string[] = [];
  /** 正在展示离线快照时的写入时刻（0 = 在线最新数据） */
  @State offlineAt: number = 0;
  /** 本次会话最近一次联网拉取成功时刻（热启动转离线时横幅时间戳的兜底） */
  @State lastOkAt: number = 0;
  /** 热启动刷新信号（NativeRoot 回前台 +1）：后台重拉，离线时横幅能及时出现/消失 */
  @StorageLink(K_HOME_REFRESH) @Watch('onHomeRev') homeRev: number = 0;
  /** 下拉刷新状态（Refresh 两向绑定） */
  @State refreshing: boolean = false;
  /** 新歌列表的 LazyForEach 渲染投影（数据真相仍是 home.newSongs） */
  private songRows: TrackRowSource = new TrackRowSource();

  aboutToAppear(): void { this.load(); }

  /** 热启动回前台（rev 变化）：重拉首页。离线时失败 → 挂离线横幅；在线成功 → 清横幅 */
  private onHomeRev(): void {
    this.load();
  }

  private async load(): Promise<void> {
    // 先渲染快照（如有）：离线冷启动也有列表可看，然后照样后台刷新
    if (this.home === null) {
      const snap = AppState.shared().readHomeSnapshot();
      if (snap !== null) {
        this.home = snap;
        this.offlineAt = AppState.shared().homeSnapshotAt();
        this.refreshFavMarks(snap.newSongs);
      }
    }
    this.loading = this.home === null;
    this.err = '';
    try {
      const fresh = await AppState.shared().home();
      this.home = fresh;
      this.lastOkAt = Date.now();
      this.offlineAt = 0;
      AppState.shared().saveHomeSnapshot(fresh);
      this.refreshFavMarks(fresh.newSongs);
    } catch (e) {
      // 刷新失败不覆盖已有数据（离线提示行继续在）；只有连数据都没有时才报错
      if (this.home === null) {
        this.err = Copy.describeError(e);
      } else if ((e as ApiError).isNetwork) {
        // 热启动转离线：手里有数据但这次联网刷新失败 —— 同样挂离线提示行。
        // 时间戳优先用快照写入时刻（与展示数据同源），无快照时退回本次会话最近成功时刻
        const snapAt = AppState.shared().homeSnapshotAt();
        this.offlineAt = snapAt > 0 ? snapAt : this.lastOkAt;
      }
      hilog.warn(0x0000, 'HomePage', '首页刷新失败: %{public}s', JSON.stringify(e));
    } finally {
      this.loading = false;
      this.refreshing = false;
    }
  }

  /** home.newSongs + favIds → LazyForEach 投影（数据/收藏每次变化后同步） */
  private syncSongRows(): void {
    const songs = this.home === null ? [] : this.home.newSongs;
    const rows: TrackRow[] = [];
    for (let i = 0; i < songs.length; i++) {
      rows.push(new TrackRow(songs[i], this.hasFav(songs[i].id), i + 1));
    }
    this.songRows.reload(rows);
  }

  /** 快照时刻 → 「10-21 12:30」（离线提示行用） */
  private fmtSnapshotTime(ms: number): string {
    const d = new Date(ms);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hour = d.getHours();
    const minute = d.getMinutes();
    const md = (month < 10 ? '0' + month : '' + month) + '-' + (day < 10 ? '0' + day : '' + day);
    const hm = (hour < 10 ? '0' + hour : '' + hour) + ':' + (minute < 10 ? '0' + minute : '' + minute);
    return md + ' ' + hm;
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
    this.songRows.setFav(trackId, fav);
  }

  private async refreshFavMarks(tracks: Track[]): Promise<void> {
    const unknown: string[] = [];
    for (let i = 0; i < tracks.length; i++) {
      if (!this.hasFav(tracks[i].id)) { unknown.push(tracks[i].id); }
    }
    if (unknown.length === 0) {
      this.syncSongRows();
      return;
    }
    try {
      const fav = await APIClient.shared().favoredIds(unknown);
      for (let i = 0; i < fav.length; i++) { this.setFav(fav[i], true); }
    } catch (e) {
      hilog.warn(0x0000, 'SuenMusic_Fav', '拉取收藏标记失败（静默）: %{public}s', JSON.stringify(e));
    } finally {
      this.syncSongRows();
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
        hilog.warn(0x0000, 'HomePage', 'toast 显示失败: %{public}s', JSON.stringify(toastErr));
      }
      hilog.warn(0x0000, 'HomePage', '收藏切换失败: %{public}s', JSON.stringify(e));
      return false;
    }
  }

  private async playAt(trackId: string): Promise<void> {
    /**
     * 断网（飞行模式）时取不到流令牌 —— 不能因此拦截点击：
     * 缓存命中的曲目走 `fd://` 离线播根本不需要令牌，所以这里降级成
     * 空令牌继续 setQueue；真正无网又无缓存的曲目由播放内核的失败
     * 自愈（failStreak ≥ 3 停下）给出人话提示，不会无限连跳。
     * 懒加载行点击时按下标定位会过期（收藏页剪行同因），改按 id 找。
     */
    const songs = this.home === null ? [] : this.home.newSongs;
    let index = -1;
    for (let i = 0; i < songs.length; i++) {
      if (songs[i].id === trackId) { index = i; break; }
    }
    if (index < 0) { return; }
    let token = '';
    try {
      token = (await APIClientToken()).token;
    } catch (e) {
      hilog.warn(0x0000, 'HomePage', '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      await MediaPlayerCore.shared().setQueue(songs, index, token);
    } catch (e) {
      this.err = Copy.describeError(e);
      hilog.error(0x0000, 'HomePage', 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  build() {
    Column() {
      if (this.loading && this.home === null) {
        // 冷启动首屏：骨架块替代转圈（S4 §六）
        SkeletonList()
      } else if (this.err.length > 0 && this.home === null) {
        Column({ space: Dim.s3 }) {
          Text(this.err).fontSize(Dim.fsBody).fontColor('#E5484D')
          Button('重试')
            .height(Dim.touchMin)
            .fontSize(Dim.fsSub)
            .backgroundColor(Tokens.panel)
            .fontColor(Tokens.text1)
            .onClick(() => { this.load(); })
        }.width('100%').margin({ top: Dim.s5 })
      } else if (this.home !== null) {
        // 下拉刷新（S4 §10.3）：阻尼以 Refresh 默认手感为准，轻拉即刷、刷完即收
        Refresh({ refreshing: $$this.refreshing }) {
          List({ space: 0 }) {
            if (this.offlineAt > 0) {
              ListItem() {
                Text('离线数据 · 最后更新 ' + this.fmtSnapshotTime(this.offlineAt))
                  .fontSize(Dim.fsCaption).fontColor(Tokens.text2)
                  .width('100%').padding({ left: Dim.s4, top: Dim.s2, bottom: Dim.s1 })
              }
            }
            if (this.home.welcomePhrase !== undefined && this.home.welcomePhrase.length > 0) {
              ListItem() {
                Text(this.home.welcomePhrase).fontSize(Dim.fsSection).fontWeight(FontWeight.Medium)
                  .width('100%').padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s1 })
              }
            }
            if (this.home.newSongs.length > 0) {
              ListItem() {
                Text('新歌首发').fontSize(Dim.fsMinor).fontColor(Tokens.text2)
                  .width('100%').padding({ left: Dim.s4, top: Dim.s3, bottom: Dim.s1 })
              }
              // 长列表懒加载（S4 §四）：只挂可见区附近的行
              LazyForEach(this.songRows, (row: TrackRow) => {
                ListItem() {
                  TrackItem({
                    track: row.track,
                    index: row.no,
                    isFav: row.fav,
                    onSwipeToggle: () => this.toggleFav(row.track),
                    onTap: () => { this.playAt(row.track.id); }
                  })
                }
              }, (row: TrackRow) => row.track.id)
            }
            if (this.home.toplists.length > 0) {
              ListItem() {
                Text('榜单').fontSize(Dim.fsMinor).fontColor(Tokens.text2)
                  .width('100%').padding({ left: Dim.s4, top: Dim.s4, bottom: Dim.s1 })
              }
              ForEach(this.home.toplists, (l: Toplist) => {
                ListItem() {
                  Row() {
                    Text(l.name).fontSize(Dim.fsTitle).fontColor(Tokens.text1)
                    Blank()
                    Text(l.updateFrequency === undefined ? '' : l.updateFrequency)
                      .fontSize(Dim.fsCaption).fontColor(Tokens.text2)
                  }
                  .width('100%').padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s3 })
                }
              }, (l: Toplist) => l.id)
            }
          }
          .width('100%')
          .layoutWeight(1)
        }
        .onRefreshing(() => { this.load(); })
        .layoutWeight(1)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}

/** 取流会话令牌的小包装（避免在页面里堆 try/catch） */
async function APIClientToken(): Promise<StreamSessionToken> {
  return APIClient.shared().streamSessionToken();
}
