import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { APIClient, ApiError } from '../core/APIClient';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { Track, Album, Artist, Playlist, formatCount } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { Copy } from '../common/Copy';
import { Dim } from '../common/Dimension';
import { AppToast } from '../common/AppToast';
import { TrackRow, TrackRowSource } from '../common/TrackSources';
import { TrackItem } from './TrackItem';
import { EmptyState } from './EmptyState';
import { SkeletonList } from './SkeletonList';
import { AppState } from '../viewmodel/AppState';
import { openCollection } from '../common/CollectionNav';
import { NeuInput } from './NeuInput';
import { NeuTabs } from '../common/NeuTabs';
import { WebIcon, WebIconButton, WebIconName, NeuBtnChrome } from '../common/WebIcons';
import { WebButton, NeuBtnSize } from '../common/WebButtons';

const TAG = 'SuenMusic_Search';
const PREF_NAME = 'suenmusic';
const KEY_RECENT = 'recent_search';
/**
 * /api/search 每页条数。30 → 50：服务端 `limit` 上限就是 50，**仍是一次上游请求**
 * （qq search 无缓存，多拉几页就是多打几次 QQ）。搜索结果即队列，这决定点歌后队列长度。
 * 与 iOS `SearchView.pageLimit` 保持一致。
 */
const PAGE_LIMIT = 50;

const RECENT_MAX = 10;
/** 分片：type 用服务端命名（artist 分片在响应里叫 artists/hasMore.artist） */
const SLICE_TYPES: string[] = ['song', 'album', 'artist', 'playlist'];
/**
 * 结果网格列数：4 列（用户裁定 2026-10-23「看得清也不至于信息密度太低」，
 * 与 CollectionPage 歌手页专辑网格同密度；web neu-grid 移动端 2 列在网格节作废）。
 */
const SEARCH_GRID_COLS = 4;

/** 网格卡片视图模型（专辑/歌手/歌单三片共用） */
class CoverCell {
  key: string = '';
  cover: string = '';
  title: string = '';
  sub: string = '';
  circle: boolean = false;
  onTap: () => void = () => {};
}

/**
 * 搜索页：搜索框 + 分片切换（单曲/专辑/歌手）+ 翻页 + 最近搜索。
 *
 * 翻页的 `hasMore` 严格按分片键判断（`hasMore.artist` 之类）——
 * 搜歌手时 songs 恒空属正常，不能拿 `songs.length` 当"没结果"。
 * 点歌只有一个入口：`MediaPlayerCore.setQueue`（令牌失败降级空令牌）。
 * 单曲分片懒加载（S4 §四）：数据真相仍是 `this.songs`，`songRows` 是渲染投影。
 */
@Component
export struct SearchPage {
  @State @Watch('onKeywordChange') keyword: string = '';
  /** 0 = 单曲 / 1 = 专辑 / 2 = 歌手 / 3 = 歌单 */
  @State activeSlice: number = 0;
  @State searched: boolean = false;
  @State searching: boolean = false;
  @State loadingMore: boolean = false;
  @State songs: Track[] = [];
  @State albums: Album[] = [];
  @State artists: Artist[] = [];
  @State playlists: Playlist[] = [];
  @State hasMore: boolean[] = [false, false, false, false];
  @State page: number = 1;
  @State err: string = '';
  @State recent: string[] = [];
  /** 已收藏曲目 id（右滑手势的文案/序号染色用，失败静默） */
  @State favIds: string[] = [];
  /** 限流提示：来自服务端 degraded.message（HTTP 200 空结果），展示而非吞成"无结果" */
  @State degradedText: string = '';
  /** 单曲分片的 LazyForEach 渲染投影（数据真相仍是 this.songs） */
  private songRows: TrackRowSource = new TrackRowSource();

  lastQuery: string = '';
  /** 当前播放队列对应的搜索关键词（翻页续接时校验，避免串改别的搜索队列） */
  private queueQuery: string = '';
  /** 请求序号：切分片/重新搜索后，丢弃还在途的过期响应 */
  private reqSeq: number = 0;
  /** 客户端节流：冷却截止时刻（epoch ms，来自 degraded.retryAfterMs）。期间不发请求 */
  private cooldownUntil: number = 0;
  private pref: preferences.Preferences | null = null;

  aboutToAppear(): void {
    this.loadRecent();
  }

  /** 搜索框内容变更监听：清空搜索框即回到最近搜索历史并清空结果 */
  private onKeywordChange(): void {
    if (this.keyword.trim().length === 0) {
      this.clearSearchState();
    }
  }

  /** 重置搜索状态与结果，返回「最近搜索」页 */
  private clearSearchState(): void {
    this.reqSeq++;
    this.searched = false;
    this.searching = false;
    this.loadingMore = false;
    this.songs = [];
    this.albums = [];
    this.artists = [];
    this.playlists = [];
    this.hasMore = [false, false, false, false];
    this.page = 1;
    this.err = '';
    this.degradedText = '';
    this.lastQuery = '';
    this.syncSongRows();
    this.loadRecent();
  }

  // ---------------- 最近搜索（本地 preferences，上限 10 条按 q 去重） ----------------

  private async ensurePref(): Promise<void> {
    if (this.pref !== null) { return; }
    const ctx = this.getUIContext().getHostContext() as common.Context;
    try {
      this.pref = await preferences.getPreferences(ctx, PREF_NAME);
    } catch (e) {
      // 打不开偏好：最近搜索功能整体退化为内存态，不拦搜索
      hilog.warn(0x0000, TAG, '打开偏好存储失败: %{public}s', JSON.stringify(e));
    }
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
    try {
      if (this.pref !== null) {
        this.pref.putSync(KEY_RECENT, JSON.stringify(list));
        await this.pref.flush();
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, '删除最近搜索失败: %{public}s', JSON.stringify(e));
    }
  }

  private async clearRecent(): Promise<void> {
    this.recent = [];
    try {
      if (this.pref !== null) {
        this.pref.deleteSync(KEY_RECENT);
        await this.pref.flush();
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, '清空最近搜索失败: %{public}s', JSON.stringify(e));
    }
  }

  // ---------------- 搜索与翻页 ----------------

  private sliceCount(): number {
    if (this.activeSlice === 0) { return this.songs.length; }
    if (this.activeSlice === 1) { return this.albums.length; }
    if (this.activeSlice === 2) { return this.artists.length; }
    return this.playlists.length;
  }

  private sliceHasMore(): boolean {
    return this.hasMore[this.activeSlice];
  }

  /** this.songs + favIds → LazyForEach 投影（数据/收藏每次变化后同步） */
  private syncSongRows(): void {
    const rows: TrackRow[] = [];
    for (let i = 0; i < this.songs.length; i++) {
      rows.push(new TrackRow(this.songs[i], this.hasFav(this.songs[i].id), i + 1));
    }
    this.songRows.reload(rows);
  }

  private async doSearch(query: string, targetPage: number): Promise<void> {
    const q = query.trim();
    if (q.length === 0) {
      this.clearSearchState();
      return;
    }
    const now = Date.now();
    if (now < this.cooldownUntil) {
      // 冷却期节流：不打服务端（Lead 实测 60s 冷却里连发 27 次无反馈），
      // 本地告知剩余秒数。翻页请求直接拦下，不动现有结果。
      if (targetPage === 1) {
        this.reqSeq++;
        this.songs = [];
        this.albums = [];
        this.artists = [];
        this.playlists = [];
        this.hasMore = [false, false, false, false];
        this.searching = false;
        this.loadingMore = false;
        this.err = '';
        this.searched = true;
        this.syncSongRows();
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
    // 搜索发起即记下关键词：失败后「重试」才有词可试（原来只在成功后记，失败重试是空操作）
    this.lastQuery = q;
    hilog.info(0x0000, TAG, '搜索请求: q=%{public}s type=%{public}s page=%{public}d', q, SLICE_TYPES[slice], targetPage);
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
      } else if (slice === 2) {
        this.artists = first ? res.artists : this.mergeArtists(this.artists, res.artists);
      } else {
        this.playlists = first ? res.playlists : this.mergePlaylists(this.playlists, res.playlists);
      }
      // 翻页续接队列：只有当「当前队列就是这个关键词搜出来的」才续
      if (slice === 0 && !first && this.queueQuery === this.normalizeQuery(q)) {
        MediaPlayerCore.shared().appendToQueue(res.songs, '搜索');
      }
      this.hasMore = [res.hasMore.song, res.hasMore.album, res.hasMore.artist, res.hasMore.playlist];
      this.page = res.page;
      this.searched = true;
      this.syncSongRows();
      // 空结果 + degraded = QQ 上游限流（2001）：显示服务端给的人话 + 记下冷却窗做节流。
      // 有结果时部分分片可能也在限流，但不打扰用户（与 web Search.vue 同口径）。
      const total = res.songs.length + res.albums.length + res.artists.length + res.playlists.length;
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
      this.err = Copy.describeError(e);
      // 首搜失败必须可见：原实现 searched 只在成功时置 true，
      // 失败后 UI 仍停留在「最近搜索」，错误被完全吞掉（观感=点了没反应）
      if (first && this.sliceCount() === 0) { this.searched = true; }
      hilog.warn(0x0000, TAG, '搜索失败: q=%{public}s err=%{public}s', q, this.err);
    } finally {
      if (mySeq === this.reqSeq) {
        this.searching = false;
        this.loadingMore = false;
        this.syncSongRows();
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

  private mergePlaylists(base: Playlist[], incoming: Playlist[]): Playlist[] {
    const seen = new Set<string>();
    for (let i = 0; i < base.length; i++) { seen.add(base[i].id); }
    const merged: Playlist[] = [];
    for (let i = 0; i < base.length; i++) { merged.push(base[i]); }
    for (let i = 0; i < incoming.length; i++) {
      if (!seen.has(incoming[i].id)) { merged.push(incoming[i]); }
    }
    return merged;
  }

  /** 计数文案：QQ 搜索响应没有总数，上游还有下一页时如实标 `N+`（web countLabel） */
  private countLabel(n: number, more: boolean): string {
    return more ? `${n}+` : `${n}`;
  }

  // ---------------- 结果网格（4 列，用户裁定密度；三片共用 CoverCell 投影） ----------------

  /** 专辑 → 网格卡（副行 = 歌手名） */
  private albumCells(): CoverCell[] {
    const cells: CoverCell[] = [];
    for (let i = 0; i < this.albums.length; i++) {
      const a = this.albums[i];
      const c = new CoverCell();
      c.key = a.id;
      c.cover = a.picUrl;
      c.title = a.name;
      c.sub = a.artist === undefined ? '' : a.artist.name;
      c.circle = false;
      const target = a;
      c.onTap = (): void => { openCollection('album', target.id, target.name); };
      cells.push(c);
    }
    return cells;
  }

  /** 歌手 → 网格卡（圆形头像，副行 = N 首作品） */
  private artistCells(): CoverCell[] {
    const cells: CoverCell[] = [];
    for (let i = 0; i < this.artists.length; i++) {
      const a = this.artists[i];
      const c = new CoverCell();
      c.key = a.id;
      c.cover = a.picUrl;
      c.title = a.name;
      c.sub = a.musicSize > 0 ? `${a.musicSize} 首作品` : '';
      c.circle = true;
      const target = a;
      c.onTap = (): void => { openCollection('artist', target.id, target.name); };
      cells.push(c);
    }
    return cells;
  }

  /** 歌单 → 网格卡（副行 = N 次播放） */
  private playlistCells(): CoverCell[] {
    const cells: CoverCell[] = [];
    for (let i = 0; i < this.playlists.length; i++) {
      const p = this.playlists[i];
      const c = new CoverCell();
      c.key = p.id;
      c.cover = p.picUrl.length > 0 ? p.picUrl : p.coverImgUrl;
      c.title = p.name;
      c.sub = `${formatCount(p.playCount)} 次播放`;
      c.circle = false;
      const target = p;
      c.onTap = (): void => {
        openCollection('playlist', String(target.tid ?? target.id), target.name);
      };
      cells.push(c);
    }
    return cells;
  }

  /** 一维卡列表 → 4 列行 */
  private gridRows(cells: CoverCell[]): CoverCell[][] {
    const rows: CoverCell[][] = [];
    for (let i = 0; i < cells.length; i += SEARCH_GRID_COLS) {
      const row: CoverCell[] = [cells[i]];
      for (let j = 1; j < SEARCH_GRID_COLS && i + j < cells.length; j++) {
        row.push(cells[i + j]);
      }
      rows.push(row);
    }
    return rows;
  }

  /** 不足一整行的空位数（占位保持前几张宽度稳定） */
  private padSlots(count: number): number[] {
    const n = (SEARCH_GRID_COLS - (count % SEARCH_GRID_COLS)) % SEARCH_GRID_COLS;
    const out: number[] = [];
    for (let i = 0; i < n; i++) { out.push(i); }
    return out;
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
      // 单行 notifyChange 在 LazyForEach 里不必然触发重建（实测：序号不染色、
      // 右滑背景仍显示「收藏」），这里补一次整组重投影，保证行内状态立即正确。
      this.syncSongRows();
      return true;
    } catch (e) {
      this.setFav(track.id, wasFav);
      this.syncSongRows();
      const msg = (e as ApiError).message;
      AppToast.show(msg === undefined ? Copy.favOpFailed : msg);
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

  /** 懒加载行闭包里的按下标定位会过期（翻页/合并后行还在），改按 id 找 */
  private async playAt(trackId: string): Promise<void> {
    let index = -1;
    for (let i = 0; i < this.songs.length; i++) {
      if (this.songs[i].id === trackId) { index = i; break; }
    }
    if (index < 0) { return; }
    // 与 HomePage.playAt 同一语义：令牌失败降级空令牌，缓存曲走 fd://
    let token = '';
    try {
      token = (await APIClient.shared().streamSessionToken()).token;
    } catch (e) {
      hilog.warn(0x0000, TAG, '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      // 记下这次队列对应的关键词：翻页续接时用它判断能不能续（否则会串改别的搜索队列）
      this.queueQuery = this.normalizeQuery(this.lastQuery);
      await MediaPlayerCore.shared().setQueue(this.songs, index, token, '搜索');
    } catch (e) {
      this.err = Copy.describeError(e);
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  /** 播放全部（web Search playAll：把当前单曲分片整页入队） */
  /** 关键词归一化（去首尾空白 + 小写）：比较「这条队列是不是同一个搜索」用 */
  private normalizeQuery(raw: string): string {
    return raw.trim().toLowerCase();
  }

  private async playAllSongs(): Promise<void> {
    if (this.songs.length === 0) { return; }
    let token = '';
    try {
      token = (await APIClient.shared().streamSessionToken()).token;
    } catch (e) {
      hilog.warn(0x0000, TAG, '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      this.queueQuery = this.normalizeQuery(this.lastQuery);
      await MediaPlayerCore.shared().setQueue(this.songs, 0, token, '搜索');
    } catch (e) {
      this.err = Copy.describeError(e);
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  // ---------------- UI ----------------

  /** 顶沿内高光（web neu-raised 的 inset hi 等价物，HomePage topSheen 同款） */
  @Builder
  topSheen() {
    Row()
      .height(Dim.hairline)
      .width('100%')
      .backgroundColor(Tokens.hi)
      .position({ x: 0, y: 0 })
  }

  /**
   * 封面卡（web `CoverCard.vue`）：1:1 封面 + 发丝线 + 顶沿内高光 +
   * 标题两行 + 副行单行；circle = 歌手圆头像。
   */
  @Builder
  coverCard(cover: string, title: string, sub: string, circle: boolean, onTap: () => void) {
    Column({ space: Dim.s2 }) {
      Stack() {
        Image(cover.length > 0 ? cover : $r('app.media.app_icon'))
          .width('100%')
          .aspectRatio(1)
          .objectFit(ImageFit.Cover)
          .borderRadius(circle ? Dim.radiusPill : Dim.radiusMd)
        this.topSheen()
      }
      .width('100%')
      .backgroundColor(Tokens.panel2)
      .borderRadius(circle ? Dim.radiusPill : Dim.radiusMd)
      .border({ width: Dim.hairline, color: Tokens.line })
      .clip(true)
      Text(title)
        .fontSize(Dim.fsBody)
        .fontColor(Tokens.text1)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (sub.length > 0) {
        Text(sub)
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.text2)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
    }
    // ⚠️ 不能用 width('100%')：在 Row 里会解析成整行宽（两张卡各 100% → 溢出超大）。
    // layoutWeight(1) 才是半宽自适应等价物。
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .accessibilityText(title)
    .onClick(() => { onTap(); })
  }

  /** 网格单行：4 张卡 + 不足整行的占位（专辑/歌手/歌单三片共用） */
  @Builder
  coverRow(row: CoverCell[]) {
    Row({ space: Dim.s2 }) {
      ForEach(row, (c: CoverCell) => {
        this.coverCard(c.cover, c.title, c.sub, c.circle, c.onTap)
      }, (c: CoverCell) => c.key)
      ForEach(this.padSlots(row.length), (n: number) => {
        Column().layoutWeight(1)
      }, (n: number) => 'pad' + n.toString())
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s2, bottom: Dim.s2 })
  }

  /** 分块头（web .block-head：11px 宽字距小标 + 计数 + 右侧「播放全部」） */
  @Builder
  blockHead(label: string, count: number, more: boolean, showPlayAll: boolean) {
    Row() {
      Text(`${label} ${this.countLabel(count, more)}`)
        .fontSize(Dim.fsCaption)
        .letterSpacing(Dim.s0)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text2)
      Blank()
      if (showPlayAll) {
        Row({ space: Dim.s2 }) {
          WebIcon(WebIconName.PLAY, Dim.icon13, Tokens.accentText)
          Text('播放全部')
            .fontSize(Dim.fsBody)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.accentText)
        }
        .padding({ left: Dim.s3, right: Dim.s3 })
        .constraintSize({ minHeight: Dim.btnMd })
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .borderRadius(Dim.radiusMd)
        .border({ width: Dim.hairline, color: Tokens.line })
        .backgroundColor(Tokens.panel)
        .accessibilityText('播放全部')
        .onClick(() => { this.playAllSongs(); })
      }
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s2, bottom: Dim.s2 })
  }

  @Builder
  listFooter() {
    Row() {
      if (this.loadingMore) {
        LoadingProgress().width(Dim.iconMd).height(Dim.iconMd)
      } else if (this.err.length > 0) {
        // 翻页失败：给人话 + 可手动重试（不自动轰炸）
        Text(this.err)
          .fontSize(Dim.fsMinor).fontColor(Tokens.danger)
          .onClick(() => { this.loadMore(); })
      } else if (this.sliceHasMore()) {
        Text('加载更多')
          .fontSize(Dim.fsMinor).fontColor(Tokens.text2)
          .padding({ top: Dim.s3, bottom: Dim.s3 })
          .onClick(() => { this.loadMore(); })
      } else if (this.sliceCount() > 0) {
        Text('没有更多了')
          .fontSize(Dim.fsMinor).fontColor(Tokens.text2)
          .padding({ top: Dim.s3, bottom: Dim.s3 })
      }
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  recentList() {
    Column() {
      Row() {
        Text('最近搜索').fontSize(Dim.fsBody).fontColor(Tokens.text2)
        Blank()
        Text('清空')
          .fontSize(Dim.fsMinor).fontColor(Tokens.text2)
          .padding({ top: Dim.s1, bottom: Dim.s1, left: Dim.s2, right: Dim.s2 })
          .constraintSize({ minHeight: Dim.touchMin })
          .accessibilityText('清空最近搜索')
          .onClick(() => { this.clearRecent(); })
      }
      .width('100%')
      .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s1 })

      List({ space: 0 }) {
        ForEach(this.recent, (q: string, i: number) => {
          ListItem() {
            Row() {
              Text(q)
                .fontSize(Dim.fsSub).fontColor(Tokens.text1).maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
              Text('删除')
                .fontSize(Dim.fsMinor).fontColor(Tokens.text2)
                .padding({ left: Dim.s2, right: Dim.s2 })
                .constraintSize({ minHeight: Dim.touchMin })
                .accessibilityText(`删除搜索记录 ${q}`)
                .onClick(() => { this.removeRecentAt(i); })
            }
            .width('100%')
            .height(Dim.touchMin)
            .padding({ left: Dim.s4, right: Dim.s4 })
            .onClick(() => {
              this.keyword = q;
              this.doSearch(q, 1);
            })
          }
        }, (q: string) => q)
      }
        .scrollBar(BarState.Off)
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
  }

  build() {
    Column() {
      // 搜索条（第 ⑨⑯ 条，web Search `.bar`：NeuInput + 琥珀图标主钮并排，gap sp-3）
      Row({ space: Dim.s3 }) {
        NeuInput({
          content: this.keyword,
          placeholder: '歌名、歌手、专辑、歌单',
          searchIcon: true,
          clearable: true,
          enterKey: EnterKeyType.Search,
          onSubmit: (v: string) => { this.doSearch(v, 1); }
        })
          .layoutWeight(1)
        // 材质与播放页主播放键对齐（GRADIENT 凸面 + amber 字形），尺寸严格等于搜索框体高（Dim.touchMin =
        // NeuInput 高度）—— 不再用琥珀填充块（比框体显高、全端独一份；用户 2026-10-23 反馈）
        WebIconButton({
          iconName: WebIconName.SEARCH,
          boxSize: Dim.touchMin,
          glyphColor: Tokens.accent,
          chromeKind: NeuBtnChrome.GRADIENT,
          onTap: () => { this.doSearch(this.keyword, 1); }
        })
          .accessibilityText('搜索')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s5 })

      // 四分片分段（第 ⑯ 条：换共享 NeuTabs，导轨 + 凸起滑块，非 accent）
      NeuTabs({
        labels: ['单曲', '专辑', '歌手', '歌单'],
        activeIndex: this.activeSlice,
        onSelect: (i: number) => { this.switchSlice(i); }
      })
        .margin({ left: Dim.s4, right: Dim.s4, top: Dim.s4 })

      if (this.searching && this.sliceCount() === 0) {
        // 首次搜索加载：骨架屏替代转圈（S4 §六）。
        // 放在 !searched 之前：首搜在途时立即离开「最近搜索」页，给出发起反馈
        SkeletonList()
      } else if (!this.searched) {
        if (this.recent.length > 0) {
          this.recentList()
        } else {
          // 初始提示：空态（无图标，副文案即引导）
          EmptyState({ title: '搜索你想听的歌', subtitle: '搜歌曲、歌手或专辑' })
        }
      } else if (this.degradedText.length > 0 && this.sliceCount() === 0) {
        // QQ 上游限流：服务端 200 + degraded，提示而非空结果（T2 补验第 7 条）
        Column({ space: Dim.s2 }) {
          Text(this.degradedText)
            .fontSize(Dim.fsBody).fontColor(Tokens.accent).textAlign(TextAlign.Center)
            .padding({ left: Dim.s6, right: Dim.s6 })
          Text('上游限流是临时的，稍等一下再试，不是搜索坏了')
            .fontSize(Dim.fsMinor).fontColor(Tokens.text2)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (this.err.length > 0 && this.sliceCount() === 0) {
        Column({ space: Dim.s3 }) {
          Text(this.err).fontSize(Dim.fsBody).fontColor(Tokens.danger)
          WebButton({
            labelStr: '重试',
            sizeKind: NeuBtnSize.MD,
            onTap: () => { this.doSearch(this.lastQuery, 1); }
          })
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (this.sliceCount() === 0) {
        // 搜到了空结果：统一空态（S4 §五）
        EmptyState({
          icon: $r('sys.symbol.magnifyingglass'),
          title: Copy.emptySearchTitle,
          subtitle: Copy.emptySearchSub
        })
      } else {
        List({ space: 0 }) {
          if (this.activeSlice === 0) {
            // 单曲块头：计数 + 播放全部（web Search 单曲 section）
            ListItem() { this.blockHead('单曲', this.songs.length, this.sliceHasMore(), true) }
            // 单曲长列表懒加载（S4 §四）
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
          } else if (this.activeSlice === 1) {
            ListItem() { this.blockHead('专辑', this.albums.length, this.sliceHasMore(), false) }
            ForEach(this.gridRows(this.albumCells()), (row: CoverCell[]) => {
              ListItem() { this.coverRow(row) }
            }, (row: CoverCell[]) => row.length > 0 ? row[0].key : '')
          } else if (this.activeSlice === 2) {
            ListItem() { this.blockHead('歌手', this.artists.length, this.sliceHasMore(), false) }
            ForEach(this.gridRows(this.artistCells()), (row: CoverCell[]) => {
              ListItem() { this.coverRow(row) }
            }, (row: CoverCell[]) => row.length > 0 ? row[0].key : '')
          } else {
            ListItem() { this.blockHead('歌单', this.playlists.length, this.sliceHasMore(), false) }
            ForEach(this.gridRows(this.playlistCells()), (row: CoverCell[]) => {
              ListItem() { this.coverRow(row) }
            }, (row: CoverCell[]) => row.length > 0 ? row[0].key : '')
          }
          ListItem() { this.listFooter() }
        }
          .scrollBar(BarState.Off)
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
