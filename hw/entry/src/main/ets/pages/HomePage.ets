import { AppState, K_HOME_REFRESH, K_USER_NAME, K_USER_DISPLAY } from '../viewmodel/AppState';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { HomeData, Track, Toplist, Album, albumArtistLine, StreamSessionToken } from '../core/Models';
import { ApiError, APIClient } from '../core/APIClient';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Tokens } from '../common/Tokens';
import { Copy } from '../common/Copy';
import { Dim, Motion } from '../common/Dimension';
import { AppToast } from '../common/AppToast';
import { TrackItem } from './TrackItem';
import { TrackRow, TrackRowSource } from '../common/TrackSources';
import { SkeletonList } from './SkeletonList';
import { WebButton, NeuBtnSize } from '../common/WebButtons';
import { openCollection } from '../common/CollectionNav';

/** 新歌列表实际展示行数（web 移动端 `slice(0, 8)`；点击任意一首 = 全量 newSongs 进队列） */
const NEW_SONG_ROWS = 8;

/**
 * 首页（T5.5 重建）：对齐移动版 Web（`Home.vue` ≤767px 断点 = 最终交付标准）。
 * 信息层级：欢迎语 → 新碟海报（一屏 2 张 1:1 大卡）→ 新歌首发（8 行 + 播放全部）
 * → 巅峰榜（两列封面卡）。哑光质感 = 色差层面 + 发丝线 + 顶沿内高光，禁外阴影。
 */
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
  /** 用户名 / 昵称（登录态写入 AppStorage）：欢迎区第一行；昵称缺失回退用户名 */
  @StorageProp(K_USER_NAME) userName: string = '';
  @StorageProp(K_USER_DISPLAY) userDisplay: string = '';
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

  /** home.newSongs 前 8 首 + favIds → LazyForEach 投影（数据/收藏每次变化后同步） */
  private syncSongRows(): void {
    const songs = this.home === null ? [] : this.home.newSongs;
    const rows: TrackRow[] = [];
    const shown = Math.min(songs.length, NEW_SONG_ROWS);
    for (let i = 0; i < shown; i++) {
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

  /** 巅峰榜 → 两列行分组（web ≤767px 两列网格；奇数行末卡独占半宽，与 web grid 同） */
  private toplistRows(): Toplist[][] {
    const all = this.home === null ? [] : this.home.toplists;
    const rows: Toplist[][] = [];
    for (let i = 0; i < all.length; i += 2) {
      const row: Toplist[] = [all[i]];
      if (i + 1 < all.length) {
        row.push(all[i + 1]);
      }
      rows.push(row);
    }
    return rows;
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
      AppToast.show(msg === undefined ? Copy.favOpFailed : msg);
      hilog.warn(0x0000, 'HomePage', '收藏切换失败: %{public}s', JSON.stringify(e));
      return false;
    }
  }

  /** 断网时取不到流令牌也继续：缓存命中的曲目走 `fd://` 离线播（详见 playAt 注释） */
  private async acquireToken(): Promise<string> {
    try {
      return (await APIClientToken()).token;
    } catch (e) {
      hilog.warn(0x0000, 'HomePage', '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
      return '';
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
    const token = await this.acquireToken();
    try {
      await MediaPlayerCore.shared().setQueue(songs, index, token, '首页');
    } catch (e) {
      this.err = Copy.describeError(e);
      hilog.error(0x0000, 'HomePage', 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  // ---------------- 区块 UI（web Home.vue ≤767px 逐区块对齐） ----------------

  /** 区块小标（web `.block-title`：11px、0.18em 字距、次级灰、中等字重） */
  @Builder
  sectionTitle(title: string) {
    Text(title)
      .fontSize(Dim.fsCaption)
      .letterSpacing(Dim.s0)
      .fontWeight(FontWeight.Medium)
      .fontColor(Tokens.text2)
      .width('100%')
      .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s4, bottom: Dim.s1 })
  }

  /** 哑光凸面的顶沿内高光（web `box-shadow: inset 0 1px 0 var(--hi)` 的等价物） */
  @Builder
  topSheen() {
    Row()
      .height(Dim.hairline)
      .width('100%')
      .backgroundColor(Tokens.hi)
      .position({ x: 0, y: 0 })
  }

  /**
   * 新碟海报大卡（web `.poster`）：封面铺满 + 日期角标（左上，自带暗底）+
   * 底部渐变压字（专辑名/歌手，对比度由上暗渐变兜底、不靠图片碰运气）。
   * 凸面板 = panel2 底 + 发丝线描边 + 顶沿内高光，无外阴影。
   */
  @Builder
  posterCard(a: Album) {
    Stack({ alignContent: Alignment.BottomStart }) {
      Image(a.picUrl.length > 0 ? a.picUrl : $r('app.media.app_icon'))
        .width('100%')
        .aspectRatio(1)
        .objectFit(ImageFit.Cover)
      this.topSheen()
      // 发行日角标（web `.poster-date`）：左上、rgba(0,0,0,0.5) 底白字；解析不出就空串不占位
      Text(releaseBadge(a.publishTime === undefined ? '' : a.publishTime))
        .fontSize(Dim.fsCaption)
        .fontColor(Color.White)
        .backgroundColor(Tokens.dateChip)
        .borderRadius(Dim.s0)
        .padding({ left: Dim.s1, right: Dim.s1, top: Dim.hairline, bottom: Dim.hairline })
        .position({ x: Dim.s3, y: Dim.s3 })
      // 压字区（web `.poster-meta`）：上暗渐变 0.78 → 0.42 → 透明
      Column({ space: Dim.s0 }) {
        Text(a.name)
          .fontSize(Dim.fsBody)
          .fontWeight(FontWeight.Bold)
          .fontColor(Color.White)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(albumArtistLine(a))
          .fontSize(Dim.fsMinor)
          .fontColor(Color.White)
          .opacity(0.82)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ top: Dim.s5, left: Dim.s3, right: Dim.s3, bottom: Dim.s3 })
      .linearGradient({
        angle: 270,
        colors: [
          [Tokens.posterScrim, 0],
          [Tokens.posterScrimMid, 0.52],
          ['#00000000', 1]
        ]
      })
    }
    .width('100%')
    .backgroundColor(Tokens.panel2)
    .borderRadius(Dim.radiusMd)
    .border({ width: Dim.hairline, color: Tokens.line })
    .clip(true)
    .margin({ left: Dim.s2, right: Dim.s2, bottom: Dim.s5 })
    .onClick(() => { openCollection('album', a.id, a.name); })
  }

  /**
   * 巅峰榜封面卡（web `CoverCard.vue` + badge「榜」）：
   * 1:1 封面 + 发丝线 + 顶沿内高光 + 右下 badge + 榜名两行 + 更新频率副行。
   */
  @Builder
  toplistCard(t: Toplist) {
    Column({ space: Dim.s2 }) {
      Stack({ alignContent: Alignment.BottomEnd }) {
        Image(t.picUrl.length > 0 ? t.picUrl : $r('app.media.app_icon'))
          .width('100%')
          .aspectRatio(1)
          .objectFit(ImageFit.Cover)
        this.topSheen()
        Text(Copy.badgeToplist)
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.badgeInk)
          .backgroundColor(Tokens.accent)
          .borderRadius(Dim.s0)
          .padding({ left: Dim.s1, right: Dim.s1, top: Dim.hairline, bottom: Dim.hairline })
          .margin(Dim.s1)
      }
      .width('100%')
      .backgroundColor(Tokens.panel2)
      .borderRadius(Dim.radiusMd)
      .border({ width: Dim.hairline, color: Tokens.line })
      .clip(true)
      Text(t.name)
        .fontSize(Dim.fsBody)
        .fontColor(Tokens.text1)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(t.updateFrequency === undefined ? '' : t.updateFrequency)
        .fontSize(Dim.fsMinor)
        .fontColor(Tokens.text2)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .onClick(() => { openCollection('toplist', t.id, t.name); })
  }

  build() {
    Column() {
      if (this.loading && this.home === null) {
        // 冷启动首屏：海报占位 + 列表占位（与真实区块同序，加载完成不跳变）
        SkeletonList({ withPoster: true })
      } else if (this.err.length > 0 && this.home === null) {
        Column({ space: Dim.s3 }) {
          Text(this.err).fontSize(Dim.fsBody).fontColor('#E5484D')
          WebButton({
            labelStr: '重试',
            sizeKind: NeuBtnSize.MD,
            onTap: () => { this.load(); }
          })
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
            // 欢迎区（用户定稿形态）：第一行昵称（大字）、第二行 AI 欢迎语，
            // 两行都坚决单行（超长省略）—— AI 短语长度由后端约束，客户端只兜底不换行
            if (this.home.welcomePhrase !== undefined && this.home.welcomePhrase.length > 0) {
              ListItem() {
                Column({ space: Dim.s0 }) {
                  Text(this.userDisplay.length > 0 ? this.userDisplay : this.userName)
                    .fontSize(Dim.fsBrand)
                    .fontWeight(FontWeight.Bold)
                    .fontColor(Tokens.text1)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                  Text(this.home.welcomePhrase)
                    .fontSize(Dim.fsBody)
                    .fontColor(Tokens.text2)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                }
                .width('100%')
                .alignItems(HorizontalAlign.Start)
                .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s1 })
              }
            }
            // ---- 新碟首发：一屏 2 张 1:1 大卡横滑（web ≤767px `--poster-per-page: 2`） ----
            if (this.home.newAlbums.length > 0) {
              ListItem() { this.sectionTitle(Copy.sectionNewAlbums) }
              ListItem() {
                Swiper() {
                  ForEach(this.home.newAlbums, (a: Album) => {
                    this.posterCard(a)
                  }, (a: Album) => a.id)
                }
                .width('100%')
                .displayCount(2)
                .loop(false)
                .cachedCount(1)
                .duration(Motion.standard)
                .curve(Motion.curve)
                .indicator(Indicator.dot()
                  .itemWidth(Dim.dot)
                  .itemHeight(Dim.dot)
                  .color(Tokens.line)
                  .selectedColor(Tokens.accent))
              }
              .padding({ left: Dim.s2, right: Dim.s2 })
            }
            // ---- 新歌首发：8 行曲目 + 播放全部（web `slice(0, 8)` + `.list-play-all`） ----
            if (this.home.newSongs.length > 0) {
              ListItem() { this.sectionTitle(Copy.sectionNewSongs) }
              // 长列表懒加载（S4 §四）：只挂可见区附近的行
              LazyForEach(this.songRows, (row: TrackRow) => {
                ListItem() {
                  TrackItem({
                    track: row.track,
                    index: row.no,
                    isFav: row.fav,
                    showDur: true,
                    onSwipeToggle: () => this.toggleFav(row.track),
                    onTap: () => { this.playAt(row.track.id); }
                  })
                }
              }, (row: TrackRow) => row.track.id)
            }
            // ---- 巅峰榜：两列封面卡（web ≤767px 两列 CoverCard 网格） ----
            if (this.home.toplists.length > 0) {
              ListItem() { this.sectionTitle(Copy.sectionToplists) }
              ForEach(this.toplistRows(), (row: Toplist[]) => {
                ListItem() {
                  Row({ space: Dim.s4 }) {
                    ForEach(row, (t: Toplist) => {
                      this.toplistCard(t)
                    }, (t: Toplist) => t.id)
                  }
                  .width('100%')
                  .padding({ left: Dim.s4, right: Dim.s4, bottom: Dim.s3 })
                }
              }, (row: Toplist[]) => row[0].id)
            }
            // 尾部留白：最后一排榜单卡不贴 tab 栏
            ListItem() {
              Row().height(Dim.s4).width('100%')
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

/**
 * 发行日角标：`2026-09-11` → `09-11`（web `releaseBadge` 同口径）。
 * 上游 release_time 的完整格式不是契约的一部分，解析不出月日就返回空串 ——
 * 宁可少一个角标，也不要显示 `NaN-NaN`。
 */
function releaseBadge(raw: string): string {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (m === null) {
    return '';
  }
  const month = m[2];
  const day = m[3];
  if (month === undefined || day === undefined) {
    return '';
  }
  const pad = (v: string): string => v.length < 2 ? '0' + v : v;
  return pad(month) + '-' + pad(day);
}

/** 取流会话令牌的小包装（避免在页面里堆 try/catch） */
async function APIClientToken(): Promise<StreamSessionToken> {
  return APIClient.shared().streamSessionToken();
}
