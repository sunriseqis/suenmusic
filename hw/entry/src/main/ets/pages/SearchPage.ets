import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { APIClient, ApiError } from '../core/APIClient';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { Track, Album, Artist } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { Copy } from '../common/Copy';
import { TrackItem } from './TrackItem';
import { AppState } from '../viewmodel/AppState';

const TAG = 'SuenMusic_Search';
const PREF_NAME = 'suenmusic';
const KEY_RECENT = 'recent_search';
const PAGE_LIMIT = 30;
const RECENT_MAX = 10;
/** 分片：type 用服务端命名（artist 分片在响应里叫 artists/hasMore.artist） */
const SLICE_TYPES: string[] = ['song', 'album', 'artist'];
const SLICE_LABELS: string[] = ['单曲', '专辑', '歌手'];

/**
 * 搜索页：搜索框 + 分片切换（单曲/专辑/歌手）+ 翻页 + 最近搜索。
 *
 * 翻页的 `hasMore` 严格按分片键判断（`hasMore.artist` 之类）——
 * 搜歌手时 songs 恒空属正常，不能拿 `songs.length` 当"没结果"。
 * 点歌只有一个入口：`MediaPlayerCore.setQueue`（令牌失败降级空令牌）。
 */
@Component
export struct SearchPage {
  @State keyword: string = '';
  /** 0 = 单曲 / 1 = 专辑 / 2 = 歌手 */
  @State activeSlice: number = 0;
  @State searched: boolean = false;
  @State searching: boolean = false;
  @State loadingMore: boolean = false;
  @State songs: Track[] = [];
  @State albums: Album[] = [];
  @State artists: Artist[] = [];
  @State hasMore: boolean[] = [false, false, false];
  @State page: number = 1;
  @State err: string = '';
  @State recent: string[] = [];
  /** 已收藏曲目 id（右滑手势的文案/序号染色用，失败静默） */
  @State favIds: string[] = [];
  /** 限流提示：来自服务端 degraded.message（HTTP 200 空结果），展示而非吞成"无结果" */
  @State degradedText: string = '';

  lastQuery: string = '';
  /** 请求序号：切分片/重新搜索后，丢弃还在途的过期响应 */
  private reqSeq: number = 0;
  /** 客户端节流：冷却截止时刻（epoch ms，来自 degraded.retryAfterMs）。期间不发请求 */
  private cooldownUntil: number = 0;
  private pref: preferences.Preferences | null = null;

  aboutToAppear(): void { this.loadRecent(); }

  // ---------------- 最近搜索（本地 preferences，上限 10 条按 q 去重） ----------------

  private async ensurePref(): Promise<void> {
    if (this.pref !== null) { return; }
    const ctx = this.getUIContext().getHostContext() as common.Context;
    this.pref = await preferences.getPreferences(ctx, PREF_NAME);
  }

  private async loadRecent(): Promise<void> {
    try {
      await this.ensurePref();
      const raw = this.pref === null ? '' : this.pref.getSync(KEY_RECENT, '') as string;
      if (raw.length > 0) {
        this.recent = JSON.parse(raw) as string[];
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, '读取最近搜索失败: %{public}s', JSON.stringify(e));
    }
  }

  private async saveRecent(query: string): Promise<void> {
    try {
      const list: string[] = [query];
      for (let i = 0; i < this.recent.length && list.length < RECENT_MAX; i++) {
        if (this.recent[i] !== query) { list.push(this.recent[i]); }
      }
      this.recent = list;
      await this.ensurePref();
      if (this.pref !== null) {
        this.pref.putSync(KEY_RECENT, JSON.stringify(list));
        await this.pref.flush();
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, '保存最近搜索失败: %{public}s', JSON.stringify(e));
    }
  }

  private async removeRecentAt(index: number): Promise<void> {
    const list: string[] = [];
    for (let i = 0; i < this.recent.length; i++) {
      if (i !== index) { list.push(this.recent[i]); }
    }
    this.recent = list;
    if (this.pref !== null) {
      this.pref.putSync(KEY_RECENT, JSON.stringify(list));
      await this.pref.flush();
    }
  }

  private async clearRecent(): Promise<void> {
    this.recent = [];
    if (this.pref !== null) {
      this.pref.deleteSync(KEY_RECENT);
      await this.pref.flush();
    }
  }

  // ---------------- 搜索与翻页 ----------------

  private sliceCount(): number {
    if (this.activeSlice === 0) { return this.songs.length; }
    if (this.activeSlice === 1) { return this.albums.length; }
    return this.artists.length;
  }

  private sliceHasMore(): boolean {
    return this.hasMore[this.activeSlice];
  }

  private async doSearch(query: string, targetPage: number): Promise<void> {
    const q = query.trim();
    if (q.length === 0) { return; }
    const now = Date.now();
    if (now < this.cooldownUntil) {
      // 冷却期节流：不打服务端（Lead 实测 60s 冷却里连发 27 次无反馈），
      // 本地告知剩余秒数。翻页请求直接拦下，不动现有结果。
      if (targetPage === 1) {
        this.reqSeq++;
        this.songs = [];
        this.albums = [];
        this.artists = [];
        this.hasMore = [false, false, false];
        this.searching = false;
        this.loadingMore = false;
        this.err = '';
        this.searched = true;
        const sec = Math.ceil((this.cooldownUntil - now) / 1000);
        this.degradedText = `QQ 音乐搜索被限流，请在 ${sec} 秒后重试`;
      }
      return;
    }
    const slice = this.activeSlice;
    const mySeq = ++this.reqSeq;
    const first = targetPage === 1;
    if (first) { this.searching = true; } else { this.loadingMore = true; }
    this.err = '';
    this.degradedText = '';
    try {
      const res = await APIClient.shared().search(q, SLICE_TYPES[slice], targetPage, PAGE_LIMIT);
      if (mySeq !== this.reqSeq) {
        // 期间用户已切分片或重新搜索：过期响应直接丢弃
        return;
      }
      if (slice === 0) {
        this.songs = first ? res.songs : this.mergeTracks(this.songs, res.songs);
        // 只查新拉进来这页的收藏标记（在途的旧曲目沿用已知状态）
        this.refreshFavMarks(res.songs);
      } else if (slice === 1) {
        this.albums = first ? res.albums : this.mergeAlbums(this.albums, res.albums);
      } else {
        this.artists = first ? res.artists : this.mergeArtists(this.artists, res.artists);
      }
      this.hasMore = [res.hasMore.song, res.hasMore.album, res.hasMore.artist];
      this.page = res.page;
      this.lastQuery = q;
      this.searched = true;
      // 空结果 + degraded = QQ 上游限流（2001）：显示服务端给的人话 + 记下冷却窗做节流。
      // 有结果时部分分片可能也在限流，但不打扰用户（与 web Search.vue 同口径）。
      const total = res.songs.length + res.albums.length + res.artists.length;
      if (res.degraded !== null && res.degraded.code !== null && total === 0) {
        this.degradedText = res.degraded.message === undefined
          ? 'QQ 音乐搜索被限流，请稍后重试' : res.degraded.message;
        if (res.degraded.retryAfterMs !== undefined && res.degraded.retryAfterMs > 0) {
          this.cooldownUntil = Date.now() + res.degraded.retryAfterMs;
        }
      }
      if (first) { this.saveRecent(q); }
    } catch (e) {
      if (mySeq !== this.reqSeq) { return; }
      this.err = (e as ApiError).message === undefined ? '搜索失败' : (e as ApiError).message;
    } finally {
      if (mySeq === this.reqSeq) {
        this.searching = false;
        this.loadingMore = false;
      }
    }
  }

  /** 翻页追加去重（QQ 翻页边界可能重复）：不重复、不跳条 */
  private mergeTracks(base: Track[], incoming: Track[]): Track[] {
    const seen = new Set<string>();
    for (let i = 0; i < base.length; i++) { seen.add(base[i].id); }
    const merged: Track[] = [];
    for (let i = 0; i < base.length; i++) { merged.push(base[i]); }
    for (let i = 0; i < incoming.length; i++) {
      if (!seen.has(incoming[i].id)) { merged.push(incoming[i]); }
    }
    return merged;
  }

  private mergeAlbums(base: Album[], incoming: Album[]): Album[] {
    const seen = new Set<string>();
    for (let i = 0; i < base.length; i++) { seen.add(base[i].id); }
    const merged: Album[] = [];
    for (let i = 0; i < base.length; i++) { merged.push(base[i]); }
    for (let i = 0; i < incoming.length; i++) {
      if (!seen.has(incoming[i].id)) { merged.push(incoming[i]); }
    }
    return merged;
  }

  private mergeArtists(base: Artist[], incoming: Artist[]): Artist[] {
    const seen = new Set<string>();
    for (let i = 0; i < base.length; i++) { seen.add(base[i].id); }
    const merged: Artist[] = [];
    for (let i = 0; i < base.length; i++) { merged.push(base[i]); }
    for (let i = 0; i < incoming.length; i++) {
      if (!seen.has(incoming[i].id)) { merged.push(incoming[i]); }
    }
    return merged;
  }

  private switchSlice(slice: number): void {
    if (slice === this.activeSlice) { return; }
    this.activeSlice = slice;
    // 已有关键词时切分片 = 用新 type 重查第一页
    if (this.lastQuery.length > 0) {
      this.doSearch(this.lastQuery, 1);
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
      this.getUIContext().getPromptAction().showToast({
        message: msg === undefined ? Copy.favOpFailed : msg,
        duration: 2000
      });
      hilog.warn(0x0000, 'SuenMusic_Fav', '收藏切换失败: %{public}s', JSON.stringify(e));
      return false;
    }
  }

  /** 滚到底自动翻页；`onReachEnd` 连发与手动点击共用同一道防重入闸门 */
  private loadMore(): void {
    if (!this.searched || this.searching || this.loadingMore) { return; }
    if (this.lastQuery.length === 0 || !this.sliceHasMore()) { return; }
    this.doSearch(this.lastQuery, this.page + 1);
  }

  private async playAt(index: number): Promise<void> {
    // 与 HomePage.playAt 同一语义：令牌失败降级空令牌，缓存曲走 fd://
    let token = '';
    try {
      token = (await APIClient.shared().streamSessionToken()).token;
    } catch (e) {
      hilog.warn(0x0000, TAG, '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      await MediaPlayerCore.shared().setQueue(this.songs, index, token);
    } catch (e) {
      this.err = '无法装载音源：' + ((e as ApiError).message ?? '');
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  // ---------------- UI ----------------

  @Builder
  sliceButton(label: string, slice: number) {
    Text(label)
      .fontSize(13)
      .fontColor(this.activeSlice === slice ? Tokens.accent : Tokens.text2)
      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
      .borderRadius(14)
      .backgroundColor(this.activeSlice === slice ? Tokens.panel : Color.Transparent)
      .onClick(() => { this.switchSlice(slice); })
  }

  @Builder
  albumRow(album: Album) {
    Row({ space: 10 }) {
      Image(album.picUrl.length > 0 ? album.picUrl : $r('app.media.app_icon'))
        .width(44).height(44).borderRadius(6).objectFit(ImageFit.Cover)
      Column({ space: 2 }) {
        Text(album.name)
          .fontSize(15).fontColor(Tokens.text1).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(album.singerName === undefined ? '' : album.singerName)
          .fontSize(11).fontColor(Tokens.text2).maxLines(1)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .height(56)
    .padding({ left: 16, right: 16 })
  }

  @Builder
  artistRow(artist: Artist) {
    Row({ space: 10 }) {
      Image(artist.picUrl.length > 0 ? artist.picUrl : $r('app.media.app_icon'))
        .width(44).height(44).borderRadius(22).objectFit(ImageFit.Cover)
      Column({ space: 2 }) {
        Text(artist.name)
          .fontSize(15).fontColor(Tokens.text1).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`单曲 ${artist.musicSize} · 专辑 ${artist.albumSize}`)
          .fontSize(11).fontColor(Tokens.text2).maxLines(1)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .height(56)
    .padding({ left: 16, right: 16 })
  }

  @Builder
  listFooter() {
    Row() {
      if (this.loadingMore) {
        LoadingProgress().width(20).height(20)
      } else if (this.err.length > 0) {
        // 翻页失败：给人话 + 可手动重试（不自动轰炸）
        Text(this.err)
          .fontSize(12).fontColor('#E5484D')
          .onClick(() => { this.loadMore(); })
      } else if (this.sliceHasMore()) {
        Text('加载更多')
          .fontSize(12).fontColor(Tokens.text2)
          .padding({ top: 12, bottom: 12 })
          .onClick(() => { this.loadMore(); })
      } else if (this.sliceCount() > 0) {
        Text('没有更多了')
          .fontSize(12).fontColor(Tokens.text2)
          .padding({ top: 12, bottom: 12 })
      }
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  recentList() {
    Column() {
      Row() {
        Text('最近搜索').fontSize(13).fontColor(Tokens.text2)
        Blank()
        Text('清空')
          .fontSize(12).fontColor(Tokens.text2)
          .padding({ top: 4, bottom: 4 })
          .onClick(() => { this.clearRecent(); })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 4 })

      List({ space: 0 }) {
        ForEach(this.recent, (q: string, i: number) => {
          ListItem() {
            Row() {
              Text(q)
                .fontSize(14).fontColor(Tokens.text1).maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
              Text('删除')
                .fontSize(12).fontColor(Tokens.text2)
                .padding({ top: 6, bottom: 6, left: 8 })
                .onClick(() => { this.removeRecentAt(i); })
            }
            .width('100%')
            .height(44)
            .padding({ left: 16, right: 16 })
            .onClick(() => {
              this.keyword = q;
              this.doSearch(q, 1);
            })
          }
        }, (q: string) => q)
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
  }

  build() {
    Column() {
      Search({ value: this.keyword, placeholder: '搜索歌曲、歌手、专辑' })
        .searchButton('搜索')
        .onChange((v: string) => { this.keyword = v; })
        .onSubmit((v: string) => { this.doSearch(v, 1); })
        .placeholderColor(Tokens.text2)
        .fontColor(Tokens.text1)
        .caretStyle({ color: Tokens.accent })
        .backgroundColor(Tokens.panel)
        .height(40)
        .margin({ left: 16, right: 16, top: 12 })

      Row({ space: 4 }) {
        this.sliceButton('单曲', 0)
        this.sliceButton('专辑', 1)
        this.sliceButton('歌手', 2)
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .padding({ top: 8, bottom: 8 })

      if (!this.searched) {
        if (this.recent.length > 0) {
          this.recentList()
        } else {
          Column() {
            Text('搜索你想听的歌')
              .fontSize(13).fontColor(Tokens.text2)
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        }
      } else if (this.searching && this.sliceCount() === 0) {
        Row() { LoadingProgress().width(28).height(28) }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
      } else if (this.degradedText.length > 0 && this.sliceCount() === 0) {
        // QQ 上游限流：服务端 200 + degraded，提示而非空结果（T2 补验第 7 条）
        Column({ space: 8 }) {
          Text(this.degradedText)
            .fontSize(13).fontColor(Tokens.accent).textAlign(TextAlign.Center)
            .padding({ left: 32, right: 32 })
          Text('上游限流是临时的，稍等一下再试，不是搜索坏了')
            .fontSize(12).fontColor(Tokens.text2)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (this.err.length > 0 && this.sliceCount() === 0) {
        Column({ space: 10 }) {
          Text(this.err).fontSize(13).fontColor('#E5484D')
          Button('重试').onClick(() => { this.doSearch(this.lastQuery, 1); })
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List({ space: 0 }) {
          if (this.activeSlice === 0) {
            ForEach(this.songs, (t: Track, i: number) => {
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
          } else if (this.activeSlice === 1) {
            ForEach(this.albums, (a: Album) => {
              ListItem() { this.albumRow(a) }
            }, (a: Album) => a.id)
          } else {
            ForEach(this.artists, (a: Artist) => {
              ListItem() { this.artistRow(a) }
            }, (a: Artist) => a.id)
          }
          ListItem() { this.listFooter() }
        }
        .width('100%')
        .layoutWeight(1)
        .onReachEnd(() => { this.loadMore(); })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
