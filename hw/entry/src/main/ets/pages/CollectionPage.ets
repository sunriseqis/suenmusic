/**
 * 集合详情页（T10 批次 D，web `Collection.vue` 移动端对齐）：
 * 榜单 / QQ 歌单 / 专辑 / 歌手四种来源共用一套模板。
 *
 * 鸿蒙端无页面路由：由 NativeRoot 作全屏浮层拉起（`CollectionNav` 信号），
 * 内部嵌套跳转（歌手 → 专辑 → 相似歌手…）用自持栈管理，系统返回经
 * `K_COLLECTION_BACK` 信号转发进来逐层弹出。
 *
 * 各来源能力差异如实处理（web 同款口径）：
 *   - 榜单：有 updateFrequency，无描述
 *   - QQ 歌单：有描述与创建者，曲目可能为空（歌单下架）
 *   - 专辑：曲目可能为空（版权限制，上游 notice 原样显示，不自造话术）
 *   - 歌手：按名搜索召回，可能 degraded，上限 50 首一批、最多 10 批
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { APIClient, ApiError } from '../core/APIClient';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { Track, Album, TrackArtist, SimiArtist, formatCount, albumArtistLine } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { Copy } from '../common/Copy';
import { Dim } from '../common/Dimension';
import { TrackItem } from './TrackItem';
import { SkeletonList } from './SkeletonList';
import { CollectionEntry, K_COLLECTION_DEPTH, K_COLLECTION_BACK } from '../common/CollectionNav';
import { WebIcon, WebIconName } from '../common/WebIcons';
import { WebButton, NeuBtnVariant, NeuBtnSize } from '../common/WebButtons';
import { AppState } from '../viewmodel/AppState';

const TAG = 'SuenMusic_Collection';
/** 歌手页曲目分页：每页条数（web SONGS_PER_PAGE） */
const SONGS_PER_PAGE = 10;
/** 歌手页专辑分页：每页条数（web ALBUMS_PER_PAGE） */
const ALBUMS_PER_PAGE = 12;
/**
 * 歌手页专辑网格列数：4 列（用户裁定 2026-10-23，web neu-grid 移动端 2 列在此处作废——
 * 2 列大卡占 6 行，曲目列表被推得太低，翻屏太多才看到歌）。
 */
const ALBUM_GRID_COLS = 4;
/** 每批向上游要多少条（web BATCH_SIZE） */
const BATCH_SIZE = 50;
/** 最多取几批，给风控兜底（web MAX_BATCH） */
const MAX_BATCH = 10;
/** 头部封面边长（web ≤767px `.art` 148px） */
const HEAD_ART = 148;
/** 介绍折叠态行数（web `max-height: 5.4em` / line-height 1.8 ≈ 3 行） */
const DESC_CLAMP_LINES = 3;
/** 介绍行高（web line-height 1.8 × fs-sm 13px） */
const DESC_LINE_H = 23;
/** 介绍挂「展开」的长度阈值：约 3 行 × 25 字/行（web 按 DOM 实测溢出，此处按长度近似） */
const DESC_CLAMP_CHARS = 75;

/** 歌手头像：从召回曲目就地取（web pickArtistAvatar 同口径），优先认 id 完全匹配那位 */
function pickArtistAvatar(songs: Track[], artistId: string, fallbackName: string): string {
  for (let i = 0; i < songs.length; i++) {
    const ar = songs[i].ar;
    for (let j = 0; j < ar.length; j++) {
      const one = ar[j];
      const pic = one.picUrl;
      if (one.id === artistId && pic !== undefined && pic.length > 0) {
        return pic;
      }
    }
  }
  if (songs.length > 0) {
    const first = songs[0].ar;
    if (first.length > 0) {
      const lead = first[0];
      const leadPic = lead.picUrl;
      if (leadPic !== undefined && leadPic.length > 0 && lead.name === fallbackName) {
        return leadPic;
      }
    }
  }
  return '';
}

/** 歌手名数组 → 一行（无「未知歌手」兜底版：专辑副行缺歌手就空着，不造信息） */
function artistNamesLine(artists: TrackArtist[]): string {
  const names: string[] = [];
  for (let i = 0; i < artists.length; i++) {
    if (artists[i].name.length > 0) { names.push(artists[i].name); }
  }
  return names.join(' / ');
}

@Component
export struct CollectionPage {
  @Prop kind: string = 'album';
  /** ⚠️ 不能叫 `id`：与 ArkUI 内置属性同名会报类型冲突（同 NativeRoot `tabIndex` 先例） */
  @Prop entryId: string = '';
  @Prop name: string = '';
  onClose: () => void = () => {};

  /** 内部栈深度：NativeRoot 系统返回据此决定弹内层还是关浮层 */
  @StorageLink(K_COLLECTION_DEPTH) depth: number = 1;
  /** 系统返回转发信号（浮层开着且深度 > 1 时 NativeRoot 自增） */
  @StorageProp(K_COLLECTION_BACK) @Watch('onBackSignal') backSignal: number = 0;

  @State title: string = '';
  @State subtitle: string = '';
  @State description: string = '';
  @State cover: string = '';
  @State tracks: Track[] = [];
  @State loading: boolean = true;
  @State err: string = '';
  /** 上游限流说明（与 err 分开：是「空结果 + 解释」，不是失败） */
  @State degradedText: string = '';
  /** 曲目为空时上游给的原因（目前只有专辑给，有则原样展示） */
  @State notice: string = '';
  @State descExpanded: boolean = false;

  // ---- 专辑页头部结构化歌手（web albumArtists/albumCompany） ----
  @State albumCompany: string = '';

  // ---- 歌手页分页（页码动态增长，见 web Collection.vue 分页注释） ----
  @State songPage: number = 1;
  @State albumPage: number = 1;
  @State songBatch: number = 1;
  @State albumBatch: number = 1;
  @State songsHasMore: boolean = false;
  @State albumsHasMore: boolean = false;
  @State songsLoadingMore: boolean = false;
  @State albumsLoadingMore: boolean = false;
  /** 入队前整列装填中（歌手页没拉完时先拉完剩余批次再 setQueue） */
  @State queueFilling: boolean = false;

  // ---- 歌手页专辑 / 相似歌手（补充内容：独立请求、独立兜错） ----
  @State albums: Album[] = [];
  @State albumsLoading: boolean = false;
  @State simiArtists: SimiArtist[] = [];
  @State simiLoading: boolean = false;

  // ---- 批量收藏 ----
  @State favIds: string[] = [];
  @State allFavorited: boolean = false;
  @State favoriting: boolean = false;
  @State favToast: string = '';

  /** 内部导航栈（栈顶即当前展示的集合） */
  private stack: CollectionEntry[] = [];
  /** 歌手名：翻页/补充请求都要带上，省一次上游详情请求 */
  private singerName: string = '';
  /** 请求序号：内部跳转后丢弃在途过期响应 */
  private loadSeq: number = 0;
  private favToastTimer: number = -1;

  aboutToAppear(): void {
    const first: CollectionEntry = { kind: this.kind, id: this.entryId, name: this.name };
    this.stack = [first];
    this.depth = this.stack.length;
    this.loadTop();
  }

  aboutToDisappear(): void {
    if (this.favToastTimer >= 0) { clearTimeout(this.favToastTimer); }
  }

  // ---------------- 内部导航栈 ----------------

  private top(): CollectionEntry {
    return this.stack[this.stack.length - 1];
  }

  /** 系统返回转发：栈里还有上一层就弹内层（关浮层由 NativeRoot 自己处理） */
  private onBackSignal(): void {
    this.popEntry();
  }

  private popEntry(): void {
    if (this.stack.length <= 1) { return; }
    this.stack.pop();
    this.depth = this.stack.length;
    this.loadTop();
  }

  /** 内部跳转：专辑卡 / 相似歌手 chip → 压栈并加载 */
  private pushEntry(kind: string, id: string, name: string): void {
    const e: CollectionEntry = { kind: kind, id: id, name: name };
    this.stack.push(e);
    this.depth = this.stack.length;
    this.loadTop();
  }

  private kindLabel(): string {
    const k = this.top().kind;
    if (k === 'toplist') { return '排行榜'; }
    if (k === 'playlist') { return '歌单'; }
    if (k === 'artist') { return '歌手'; }
    return '专辑';
  }

  private isArtist(): boolean {
    return this.top().kind === 'artist';
  }

  // ---------------- 数据加载 ----------------

  private async loadTop(): Promise<void> {
    const e = this.top();
    const mySeq = ++this.loadSeq;
    this.loading = true;
    this.err = '';
    this.degradedText = '';
    this.notice = '';
    this.title = '';
    this.subtitle = '';
    this.description = '';
    this.cover = '';
    this.tracks = [];
    this.albums = [];
    this.simiArtists = [];
    this.albumCompany = '';
    this.descExpanded = false;
    this.songPage = 1;
    this.albumPage = 1;
    this.songBatch = 1;
    this.albumBatch = 1;
    this.songsHasMore = false;
    this.albumsHasMore = false;
    this.songsLoadingMore = false;
    this.albumsLoadingMore = false;
    this.albumsLoading = false;
    this.simiLoading = false;
    this.singerName = '';
    this.allFavorited = false;
    this.favToast = '';
    const api = APIClient.shared();
    try {
      if (e.kind === 'toplist') {
        const res = await api.toplistDetail(e.id, 200);
        if (mySeq !== this.loadSeq) { return; }
        this.title = res.topInfo === null ? '排行榜' : res.topInfo.name;
        this.subtitle = res.topInfo === null || res.topInfo.updateFrequency === undefined
          ? '' : res.topInfo.updateFrequency;
        this.cover = res.topInfo === null ? '' : res.topInfo.picUrl;
        this.tracks = res.tracks;
      } else if (e.kind === 'playlist') {
        const res = await api.qqPlaylist(e.id);
        if (mySeq !== this.loadSeq) { return; }
        this.title = res.playlist.name;
        const creator = res.playlist.creator === null ? '' : res.playlist.creator.nickname;
        this.subtitle = `${formatCount(res.playlist.playCount)} 次播放 · ${creator.length > 0 ? creator : 'QQ 音乐'}`;
        this.description = res.playlist.description;
        this.cover = res.playlist.picUrl.length > 0 ? res.playlist.picUrl : res.playlist.coverImgUrl;
        this.tracks = res.tracks;
      } else if (e.kind === 'album') {
        const res = await api.albumDetail(e.id);
        if (mySeq !== this.loadSeq) { return; }
        this.title = res.album.name;
        this.albumCompany = res.album.company === undefined ? '' : res.album.company;
        const parts: string[] = [];
        const an = artistNamesLine(res.album.artists ?? []);
        if (an.length > 0) { parts.push(an); }
        if (this.albumCompany.length > 0) { parts.push(this.albumCompany); }
        this.subtitle = parts.join(' · ');
        this.description = res.album.description === undefined ? '' : res.album.description;
        this.cover = res.album.picUrl;
        this.tracks = res.songs;
        this.notice = res.notice === null ? '' : res.notice;
      } else {
        // 歌手：名字随入口带上，省一次上游详情请求
        this.singerName = e.name;
        const res = await api.artistSongs(e.id, this.singerName, BATCH_SIZE, 1);
        if (mySeq !== this.loadSeq) { return; }
        this.title = res.name.length > 0 ? res.name : this.singerName;
        this.subtitle = '热门歌曲';
        this.cover = pickArtistAvatar(res.songs, e.id, this.singerName);
        this.tracks = res.songs;
        this.songsHasMore = res.hasMore;
        if (res.degraded !== null && res.songs.length === 0) {
          const msg = res.degraded.message === undefined ? '' : res.degraded.message;
          this.degradedText = msg.length > 0 ? msg : 'QQ 音乐检索被限流，请稍后重试';
        }
        // 专辑 / 相似歌手：补充内容，各自独立兜错，失败就当这一节不存在
        this.loadArtistAlbums(mySeq);
        this.loadSimilarArtists(mySeq);
      }
      if (mySeq !== this.loadSeq) { return; }
      await this.refreshFavState();
    } catch (err) {
      if (mySeq !== this.loadSeq) { return; }
      this.err = Copy.describeError(err);
      hilog.warn(0x0000, TAG, '集合详情加载失败: kind=%{public}s id=%{public}s err=%{public}s',
        e.kind, e.id, this.err);
    } finally {
      if (mySeq === this.loadSeq) {
        this.loading = false;
      }
    }
  }

  /** 歌手专辑第 1 批（补充内容：拿不到就当这一节不存在） */
  private async loadArtistAlbums(seq: number): Promise<void> {
    this.albumsLoading = true;
    this.albums = [];
    this.albumsHasMore = false;
    try {
      const res = await APIClient.shared().artistAlbums(this.top().id, this.singerName, BATCH_SIZE, 1);
      if (seq !== this.loadSeq) { return; }
      this.albums = res.albums;
      this.albumBatch = 1;
      this.albumsHasMore = res.hasMore;
    } catch (e) {
      if (seq === this.loadSeq) { this.albums = []; }
    } finally {
      if (seq === this.loadSeq) { this.albumsLoading = false; }
    }
  }

  /** 相似歌手（补充内容的补充：静默兜错，为空整节不出现） */
  private async loadSimilarArtists(seq: number): Promise<void> {
    this.simiLoading = true;
    this.simiArtists = [];
    try {
      const res = await APIClient.shared().similarArtists(this.top().id, this.singerName);
      if (seq !== this.loadSeq) { return; }
      this.simiArtists = res.artists;
    } catch (e) {
      if (seq === this.loadSeq) { this.simiArtists = []; }
    } finally {
      if (seq === this.loadSeq) { this.simiLoading = false; }
    }
  }

  // ---------------- 歌手页分页（web Collection.vue 同款：批量取、本地翻页、页码动态增长） ----------------

  private songPages(): number {
    return Math.max(1, Math.ceil(this.tracks.length / SONGS_PER_PAGE));
  }

  private albumPages(): number {
    return Math.max(1, Math.ceil(this.albums.length / ALBUMS_PER_PAGE));
  }

  /** 实际渲染的曲目：歌手页只渲染当前页，其余一页到底 */
  private shownTracks(): Track[] {
    if (!this.isArtist()) { return this.tracks; }
    const start = (this.songPage - 1) * SONGS_PER_PAGE;
    const out: Track[] = [];
    for (let i = start; i < this.tracks.length && out.length < SONGS_PER_PAGE; i++) {
      out.push(this.tracks[i]);
    }
    return out;
  }

  /** 分页时的绝对序号基准（让「第 21 首」真的是第 21 首） */
  private songIndexBase(): number {
    return this.isArtist() ? (this.songPage - 1) * SONGS_PER_PAGE : 0;
  }

  private pagedAlbums(): Album[] {
    const start = (this.albumPage - 1) * ALBUMS_PER_PAGE;
    const out: Album[] = [];
    for (let i = start; i < this.albums.length && out.length < ALBUMS_PER_PAGE; i++) {
      out.push(this.albums[i]);
    }
    return out;
  }

  /** 页码序列：页数多时只留首尾与当前附近，中间用 -1 占位（web pageNumbers 的 'gap'） */
  private pageNumbers(current: number, total: number): number[] {
    if (total <= 7) {
      const out: number[] = [];
      for (let i = 1; i <= total; i++) { out.push(i); }
      return out;
    }
    const out: number[] = [1];
    const from = Math.max(2, current - 1);
    const to = Math.min(total - 1, current + 1);
    if (from > 2) { out.push(-1); }
    for (let i = from; i <= to; i++) { out.push(i); }
    if (to < total - 1) { out.push(-1); }
    out.push(total);
    return out;
  }

  private pad2(n: number): string {
    return n < 10 ? '0' + n.toString() : n.toString();
  }

  /** 点「下一页」：还有本地页就翻页，已到末页且上游还有就去取下一批 */
  private nextSongPage(): void {
    if (this.songPage < this.songPages()) {
      this.songPage += 1;
      return;
    }
    this.loadMoreSongs();
  }

  private nextAlbumPage(): void {
    if (this.albumPage < this.albumPages()) {
      this.albumPage += 1;
      return;
    }
    this.loadMoreAlbums();
  }

  /** 取下一批歌曲（追加按 id 去重：搜索分页不保证不重叠） */
  private async loadMoreSongs(): Promise<void> {
    if (this.songsLoadingMore || !this.songsHasMore) { return; }
    if (this.songBatch >= MAX_BATCH) {
      this.songsHasMore = false;
      return;
    }
    this.songsLoadingMore = true;
    const mySeq = this.loadSeq;
    try {
      const next = this.songBatch + 1;
      const res = await APIClient.shared().artistSongs(this.top().id, this.singerName, BATCH_SIZE, next);
      if (mySeq !== this.loadSeq) { return; }
      this.songBatch = next;
      const seen = new Set<string>();
      for (let i = 0; i < this.tracks.length; i++) { seen.add(this.tracks[i].id); }
      const fresh: Track[] = [];
      for (let i = 0; i < res.songs.length; i++) {
        if (!seen.has(res.songs[i].id)) { fresh.push(res.songs[i]); }
      }
      if (fresh.length > 0) {
        const pagesBefore = this.songPages();
        this.tracks = this.tracks.concat(fresh);
        this.songPage = Math.min(this.songPages(), pagesBefore + 1);
        this.refreshFavState();
      }
      // 上游说有更多、但过滤后一条没新增时也要收手，否则空转
      this.songsHasMore = res.hasMore && fresh.length > 0 && next < MAX_BATCH;
    } catch (e) {
      if (mySeq === this.loadSeq) { this.songsHasMore = false; }
    } finally {
      if (mySeq === this.loadSeq) { this.songsLoadingMore = false; }
    }
  }

  /** 装填整列：把歌手页剩余批次全部拉完（入队前调用，队列 = 整个列表对齐 web playQueue 语义） */
  private async ensureAllSongsLoaded(): Promise<void> {
    while (this.songsHasMore && this.songBatch < MAX_BATCH) {
      const batchBefore = this.songBatch;
      await this.loadMoreSongs();
      // 并发守卫/上游失败让 loadMoreSongs 收手没推进时退出，避免空转
      if (this.songBatch === batchBefore) { break; }
    }
  }

  /** 取下一批专辑 */
  private async loadMoreAlbums(): Promise<void> {
    if (this.albumsLoadingMore || !this.albumsHasMore) { return; }
    if (this.albumBatch >= MAX_BATCH) {
      this.albumsHasMore = false;
      return;
    }
    this.albumsLoadingMore = true;
    const mySeq = this.loadSeq;
    try {
      const next = this.albumBatch + 1;
      const res = await APIClient.shared().artistAlbums(this.top().id, this.singerName, BATCH_SIZE, next);
      if (mySeq !== this.loadSeq) { return; }
      this.albumBatch = next;
      const seen = new Set<string>();
      for (let i = 0; i < this.albums.length; i++) { seen.add(this.albums[i].id); }
      const fresh: Album[] = [];
      for (let i = 0; i < res.albums.length; i++) {
        if (!seen.has(res.albums[i].id)) { fresh.push(res.albums[i]); }
      }
      if (fresh.length > 0) {
        const pagesBefore = this.albumPages();
        this.albums = this.albums.concat(fresh);
        this.albumPage = Math.min(this.albumPages(), pagesBefore + 1);
      }
      this.albumsHasMore = res.hasMore && fresh.length > 0 && next < MAX_BATCH;
    } catch (e) {
      if (mySeq === this.loadSeq) { this.albumsHasMore = false; }
    } finally {
      if (mySeq === this.loadSeq) { this.albumsLoadingMore = false; }
    }
  }

  // ---------------- 播放与收藏 ----------------

  /** 播放全部（从第 0 首；令牌失败降级空令牌，缓存曲走 fd://） */
  private async playAll(): Promise<void> {
    await this.playAt(0);
  }

  private async playAt(absoluteIndex: number): Promise<void> {
    if (this.queueFilling) { return; }
    if (absoluteIndex < 0 || absoluteIndex >= this.tracks.length) { return; }
    // 歌手页上游还有批次没拉：先整列装填再入队（tracks 只追加，点中的下标不变）
    if (this.isArtist() && this.songsHasMore) {
      this.queueFilling = true;
      try {
        await this.ensureAllSongsLoaded();
      } finally {
        this.queueFilling = false;
      }
      if (absoluteIndex >= this.tracks.length) { return; }
    }
    let token = '';
    try {
      token = (await APIClient.shared().streamSessionToken()).token;
    } catch (e) {
      hilog.warn(0x0000, TAG, '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      await MediaPlayerCore.shared().setQueue(this.tracks, absoluteIndex, token, this.kindLabel());
    } catch (e) {
      this.err = Copy.describeError(e);
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

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
    this.recalcAllFav();
  }

  private recalcAllFav(): void {
    let all = this.tracks.length > 0;
    for (let i = 0; i < this.tracks.length; i++) {
      if (!this.hasFav(this.tracks[i].id)) { all = false; break; }
    }
    this.allFavorited = all;
  }

  private async refreshFavState(): Promise<void> {
    if (this.tracks.length === 0) {
      this.allFavorited = false;
      return;
    }
    const ids: string[] = [];
    for (let i = 0; i < this.tracks.length; i++) { ids.push(this.tracks[i].id); }
    try {
      this.favIds = await APIClient.shared().favoredIds(ids);
    } catch (e) {
      // 拉不到标记只是不染色，不打断浏览
    }
    this.recalcAllFav();
  }

  /** 行右滑：乐观翻转 + 服务端落地，失败回滚 + toast */
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
        hilog.warn(0x0000, TAG, 'toast 显示失败: %{public}s', JSON.stringify(toastErr));
      }
      return false;
    }
  }

  /** 收藏全部（web favoriteAll：批量回写 + 内联结果提示） */
  private async favoriteAll(): Promise<void> {
    if (this.favoriting || this.tracks.length === 0) { return; }
    this.favoriting = true;
    this.favToast = '';
    try {
      const added = await APIClient.shared().importFavorites(this.tracks);
      this.favToast = added > 0 ? `已收藏 ${added} 首` : '全部已在收藏中';
      AppState.shared().bumpFavRev();
      await this.refreshFavState();
    } catch (e) {
      this.favToast = '收藏失败，请重试';
    } finally {
      this.favoriting = false;
      if (this.favToastTimer >= 0) { clearTimeout(this.favToastTimer); }
      this.favToastTimer = setTimeout(() => { this.favToast = ''; }, 3000);
    }
  }

  // ---------------- 空态文案（分来源说，notice 优先） ----------------

  private emptyTitle(): string {
    return this.top().kind === 'album' ? '这张专辑暂不可播放' : '这里还没有曲目';
  }

  private emptyHint(): string {
    if (this.notice.length > 0) { return this.notice; }
    const k = this.top().kind;
    if (k === 'album') { return '上游没有返回曲目，可能是尚未发行或曲目正在调整。'; }
    if (k === 'playlist') { return '上游返回了空列表，这个歌单可能已下架。'; }
    if (k === 'toplist') { return '暂时取不到榜单曲目，稍后重试。'; }
    return '没有检索到这位歌手的曲目。';
  }

  /** 介绍是否真的长到需要「展开」（web 按 DOM 实测溢出，此处按长度近似） */
  private descOverflow(): boolean {
    return this.description.length > DESC_CLAMP_CHARS;
  }

  // ---------------- UI ----------------

  /** 顶沿内高光（web neu-raised 的 inset hi 等价物） */
  @Builder
  topSheen() {
    Row()
      .height(Dim.hairline)
      .width('100%')
      .backgroundColor(Tokens.hi)
      .position({ x: 0, y: 0 })
  }

  /** 顶部返回钮：栈里还有上一层弹内层，否则关浮层 */
  @Builder
  backButton() {
    Row() {
      WebIcon(WebIconName.CHEVRON_LEFT, Dim.iconMd, Tokens.text1)
    }
    .width(Dim.btnBar)
    .height(Dim.btnBar)
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .borderRadius(Dim.radiusPill)
    .border({ width: Dim.hairline, color: Tokens.line })
    .backgroundColor(Tokens.panel)
    .accessibilityText(this.stack.length > 1 ? '返回上一层' : '关闭')
    .onClick(() => {
      if (this.stack.length > 1) {
        this.popEntry();
      } else {
        this.onClose();
      }
    })
  }

  /** 播放全部（web .play-all：accent 底 + 深字 + 描边） */
  @Builder
  playAllButton() {
    Row({ space: Dim.s2 }) {
      WebIcon(WebIconName.PLAY, Dim.iconSm, Tokens.badgeInk)
      Text(this.queueFilling ? '装载中…' : '播放全部')
        .fontSize(Dim.fsBody)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.badgeInk)
    }
    .padding({ left: Dim.s4, right: Dim.s4 })
    .constraintSize({ minHeight: Dim.btnBar })
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .borderRadius(Dim.radiusMd)
    .backgroundColor(Tokens.accent)
    .border({ width: Dim.hairline, color: Tokens.accent })
    .accessibilityText(this.queueFilling ? '装载中' : '播放全部')
    .onClick(() => {
      if (!this.queueFilling) { this.playAll(); }
    })
  }

  /** 收藏全部（web .fav-all：panel 底 + 描边 + 顶沿高光；全部已收藏时 accent 字） */
  @Builder
  favAllButton() {
    Row({ space: Dim.s2 }) {
      WebIcon(this.allFavorited ? WebIconName.HEART_FILLED : WebIconName.HEART, Dim.iconSm,
        this.allFavorited ? Tokens.accent : Tokens.text1)
      Text(this.favoriting ? '收藏中…' : this.allFavorited ? '已全部收藏' : '收藏全部')
        .fontSize(Dim.fsBody)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.allFavorited ? Tokens.accent : Tokens.text1)
    }
    .padding({ left: Dim.s4, right: Dim.s4 })
    .constraintSize({ minHeight: Dim.btnBar })
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .borderRadius(Dim.radiusMd)
    .backgroundColor(Tokens.panel)
    .border({ width: Dim.hairline, color: Tokens.line })
    .opacity(this.favoriting || this.allFavorited ? 0.55 : 1)
    .accessibilityText('收藏全部')
    .onClick(() => {
      if (!this.favoriting && !this.allFavorited) { this.favoriteAll(); }
    })
  }

  /** 分页圆钮（web NeuIconButton chevron） */
  @Builder
  pagerArrow(iconName: string, label: string, enabled: boolean, onTap: () => void) {
    Row() {
      WebIcon(iconName, Dim.iconMd, enabled ? Tokens.text1 : Tokens.text2)
    }
    .width(Dim.btnMd)
    .height(Dim.btnMd)
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .borderRadius(Dim.radiusPill)
    .border({ width: Dim.hairline, color: Tokens.line })
    .backgroundColor(Tokens.panel)
    .opacity(enabled ? 1 : 0.5)
    .accessibilityText(label)
    .onClick(() => {
      if (enabled) { onTap(); }
    })
  }

  /** 曲目行列表（普通 ForEach：页面整体在 Scroll 里，与 web v-for 同构） */
  @Builder
  trackRows() {
    ForEach(this.shownTracks(), (t: Track, i: number) => {
      TrackItem({
        track: t,
        index: this.songIndexBase() + i + 1,
        isFav: this.hasFav(t.id),
        showDur: true,
        onSwipeToggle: (): Promise<boolean> => this.toggleFav(t),
        onTap: (): void => { this.playAt(this.songIndexBase() + i); }
      })
    }, (t: Track) => t.id)
  }

  /** 歌手页分页条（web .pager：圆钮 + 页码 + 加载更多 + 圆钮） */
  @Builder
  songsPager() {
    Row({ space: Dim.s2 }) {
      this.pagerArrow(WebIconName.CHEVRON_LEFT, '上一页歌曲', this.songPage > 1, () => {
        this.songPage = Math.max(1, this.songPage - 1);
      })
      ForEach(this.pageNumbers(this.songPage, this.songPages()), (p: number) => {
        if (p === -1) {
          Text('…').fontSize(Dim.fsBody).fontColor(Tokens.text2)
        } else {
          Text(this.pad2(p))
            .fontSize(Dim.fsBody)
            .fontColor(p === this.songPage ? Tokens.accent : Tokens.text2)
            .fontWeight(p === this.songPage ? FontWeight.Medium : FontWeight.Normal)
            .constraintSize({ minWidth: Dim.btnSm })
            .textAlign(TextAlign.Center)
            .accessibilityText(`第 ${p} 页歌曲`)
            .onClick(() => { this.songPage = p; })
        }
      }, (p: number) => p.toString())
      if (this.songsHasMore) {
        Text(this.songsLoadingMore ? '加载中' : '加载更多')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.accentText)
          .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s1, bottom: Dim.s1 })
          .borderRadius(Dim.radiusMd)
          .border({ width: Dim.hairline, color: Tokens.line })
          .backgroundColor(Tokens.panel)
          .accessibilityText('加载更多歌曲')
          .onClick(() => { this.loadMoreSongs(); })
      }
      this.pagerArrow(WebIconName.CHEVRON_RIGHT, '下一页歌曲',
        this.songPage < this.songPages() || this.songsHasMore, () => {
          this.nextSongPage();
        })
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .padding({ top: Dim.s4, bottom: Dim.s4 })
  }

  /** 专辑分页条（歌手页专辑网格下方） */
  @Builder
  albumsPager() {
    Row({ space: Dim.s2 }) {
      this.pagerArrow(WebIconName.CHEVRON_LEFT, '上一页专辑', this.albumPage > 1, () => {
        this.albumPage = Math.max(1, this.albumPage - 1);
      })
      ForEach(this.pageNumbers(this.albumPage, this.albumPages()), (p: number) => {
        if (p === -1) {
          Text('…').fontSize(Dim.fsBody).fontColor(Tokens.text2)
        } else {
          Text(this.pad2(p))
            .fontSize(Dim.fsBody)
            .fontColor(p === this.albumPage ? Tokens.accent : Tokens.text2)
            .fontWeight(p === this.albumPage ? FontWeight.Medium : FontWeight.Normal)
            .constraintSize({ minWidth: Dim.btnSm })
            .textAlign(TextAlign.Center)
            .accessibilityText(`第 ${p} 页专辑`)
            .onClick(() => { this.albumPage = p; })
        }
      }, (p: number) => p.toString())
      if (this.albumsHasMore) {
        Text(this.albumsLoadingMore ? '加载中' : '加载更多')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.accentText)
          .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s1, bottom: Dim.s1 })
          .borderRadius(Dim.radiusMd)
          .border({ width: Dim.hairline, color: Tokens.line })
          .backgroundColor(Tokens.panel)
          .accessibilityText('加载更多专辑')
          .onClick(() => { this.loadMoreAlbums(); })
      }
      this.pagerArrow(WebIconName.CHEVRON_RIGHT, '下一页专辑',
        this.albumPage < this.albumPages() || this.albumsHasMore, () => {
          this.nextAlbumPage();
        })
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .padding({ top: Dim.s4, bottom: Dim.s4 })
  }

  /**
   * 封面卡（web `CoverCard.vue`）：1:1 封面 + 发丝线 + 顶沿内高光 +
   * 标题两行 + 副行单行。circle = 歌手圆头像。
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
    // layoutWeight(1) 才是 web minmax(136px,1fr) 的半宽自适应等价物。
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .accessibilityText(title)
    .onClick(() => { onTap(); })
  }

  /** 紧凑专辑网格（用户裁定 4 列）：卡片复用 coverCard，仅列数与间距收紧 */
  @Builder
  albumGrid() {
    Column({ space: Dim.s3 }) {
      ForEach(this.gridPairs(this.pagedAlbums()), (pair: Album[], pi: number) => {
        Row({ space: Dim.s2 }) {
          ForEach(pair, (a: Album, ai: number) => {
            this.coverCard(a.picUrl, a.name, albumArtistLine(a), false, () => {
              this.pushEntry('album', a.id, a.name);
            })
          }, (a: Album, ai: number) => a.id)
          // 不足 4 张的行补占位，保持前几张宽度稳定
          ForEach(this.padSlots(pair.length), (n: number) => {
            Column().layoutWeight(1)
          }, (n: number) => 'pad' + n.toString())
        }
        .width('100%')
      }, (pair: Album[], pi: number) => pi.toString() + '-' + pair.length.toString() + '-' + (pair.length > 0 ? pair[0].id : ''))
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4 })
  }

  /** 不足一整行的空位数（1..ALBUM_GRID_COLS-1 → 对应占位数；整行返回 0 个） */
  private padSlots(count: number): number[] {
    const n = (ALBUM_GRID_COLS - (count % ALBUM_GRID_COLS)) % ALBUM_GRID_COLS;
    const out: number[] = [];
    for (let i = 0; i < n; i++) { out.push(i); }
    return out;
  }

  /** 把一维数组切成 N 列行（网格布局辅助） */
  private gridPairs(list: Album[]): Album[][] {
    const rows: Album[][] = [];
    for (let i = 0; i < list.length; i += ALBUM_GRID_COLS) {
      const pair: Album[] = [list[i]];
      for (let j = 1; j < ALBUM_GRID_COLS && i + j < list.length; j++) {
        pair.push(list[i + j]);
      }
      rows.push(pair);
    }
    return rows;
  }

  build() {
    Column() {
      // 顶部返回行（避让区由外层 padding 处理）
      Row() {
        this.backButton()
      }
      .width('100%')
      .padding({ left: Dim.s3 })

      Scroll() {
        Column() {
          // ---- 头部（web ≤767px：居中列布局） ----
          Column({ space: Dim.s2 }) {
            Image(this.cover.length > 0 ? this.cover : $r('app.media.app_icon'))
              .width(HEAD_ART)
              .height(HEAD_ART)
              .borderRadius(Dim.radiusMd)
              .border({ width: Dim.hairline, color: Tokens.line })
              .objectFit(ImageFit.Cover)
              .backgroundColor(Tokens.panel2)
            Text(this.kindLabel())
              .fontSize(Dim.fsCaption)
              .letterSpacing(Dim.s0)
              .fontColor(Tokens.text2)
            Text(this.title.length > 0 ? this.title : '未找到')
              .fontSize(Dim.fsDisplay)
              .fontWeight(FontWeight.Bold)
              .fontColor(Tokens.text1)
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .textAlign(TextAlign.Center)
            if (this.subtitle.length > 0) {
              Text(this.subtitle)
                .fontSize(Dim.fsBody)
                .fontColor(Tokens.text2)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .textAlign(TextAlign.Center)
            }
            if (!this.isArtist() && this.tracks.length > 0) {
              Text(`${this.tracks.length} 首`)
                .fontSize(Dim.fsBody)
                .fontColor(Tokens.text2)
            }
          }
          .width('100%')
          .alignItems(HorizontalAlign.Center)
          .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s2 })

          // ---- 播放全部 / 收藏全部（有曲目才出现） ----
          if (!this.loading && this.tracks.length > 0) {
            Row({ space: Dim.s3 }) {
              this.playAllButton()
              this.favAllButton()
            }
            .padding({ top: Dim.s2, bottom: Dim.s2 })
            .justifyContent(FlexAlign.Center)
            if (this.favToast.length > 0) {
              Text(this.favToast)
                .fontSize(Dim.fsCaption)
                .fontWeight(FontWeight.Medium)
                .fontColor(Tokens.accent)
                .padding({ bottom: Dim.s2 })
            }
          }

          // ---- 介绍折叠框（折叠必须配展开入口；短文案不挂钮） ----
          if (this.description.length > 0 && !this.loading) {
            Column({ space: Dim.s2 }) {
              Text(this.description)
                .fontSize(Dim.fsBody)
                .fontColor(Tokens.text2)
                .lineHeight(DESC_LINE_H)
                .maxLines(this.descExpanded ? 100 : DESC_CLAMP_LINES)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s3, bottom: Dim.s3 })
                .borderRadius(Dim.radiusMd)
                .border({ width: Dim.hairline, color: Tokens.line })
                .backgroundColor(Tokens.panel2)
              if (this.descOverflow()) {
                Text(this.descExpanded ? '收起' : '展开完整介绍')
                  .fontSize(Dim.fsCaption)
                  .letterSpacing(Dim.s0)
                  .fontColor(Tokens.accentText)
                  .padding({ top: Dim.s1, bottom: Dim.s1 })
                  .constraintSize({ minHeight: Dim.touchMin })
                  .accessibilityText(this.descExpanded ? '收起介绍' : '展开完整介绍')
                  .onClick(() => { this.descExpanded = !this.descExpanded; })
              }
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3 })
          }

          // ---- 歌手专辑（补充内容：独立请求、独立兜错，失败整节不出现） ----
          if (this.isArtist() && (this.albumsLoading || this.albums.length > 0)) {
            Column({ space: Dim.s3 }) {
              Text('专辑')
                .fontSize(Dim.fsHeadline)
                .fontWeight(FontWeight.Bold)
                .fontColor(Tokens.text1)
                .width('100%')
              if (this.albumsLoading) {
                Row() {
                  LoadingProgress().width(Dim.iconMd).height(Dim.iconMd)
                }
                .width('100%')
                .padding({ top: Dim.s4, bottom: Dim.s4 })
                .justifyContent(FlexAlign.Center)
              } else {
                this.albumGrid()
                if (this.albumPages() > 1 || this.albumsHasMore) {
                  this.albumsPager()
                }
              }
            }
            .width('100%')
            .padding({ top: Dim.s5 })
          }

          // ---- 曲目区 ----
          if (this.loading) {
            SkeletonList()
          } else if (this.err.length > 0) {
            Column({ space: Dim.s3 }) {
              Text(this.err).fontSize(Dim.fsBody).fontColor('#E5484D')
              WebButton({
                labelStr: '重试',
                sizeKind: NeuBtnSize.MD,
                onTap: () => { this.loadTop(); }
              })
            }
            .width('100%')
            .padding({ top: Dim.s6, bottom: Dim.s6 })
            .justifyContent(FlexAlign.Center)
          } else if (this.degradedText.length > 0) {
            Column({ space: Dim.s2 }) {
              Text(this.degradedText)
                .fontSize(Dim.fsBody)
                .fontColor(Tokens.accent)
                .textAlign(TextAlign.Center)
                .padding({ left: Dim.s6, right: Dim.s6 })
              Text('稍等一下再试，不是歌单本身有问题')
                .fontSize(Dim.fsMinor)
                .fontColor(Tokens.text2)
            }
            .width('100%')
            .padding({ top: Dim.s6, bottom: Dim.s6 })
          } else if (this.tracks.length === 0) {
            // 空曲目：标题分来源 + notice 优先（EmptyState 自带 layoutWeight，不能进 Scroll）
            Column({ space: Dim.s2 }) {
              Text(this.emptyTitle())
                .fontSize(Dim.fsBody)
                .fontColor(Tokens.text1)
              Text(this.emptyHint())
                .fontSize(Dim.fsCaption)
                .fontColor(Tokens.text2)
                .textAlign(TextAlign.Center)
            }
            .width('100%')
            .alignItems(HorizontalAlign.Center)
            .padding({ left: Dim.s5, right: Dim.s5, top: Dim.s6, bottom: Dim.s6 })
          } else {
            Column() {
              this.trackRows()
            }
            .width('100%')
            .padding({ top: Dim.s3 })
            if (this.isArtist() && (this.songPages() > 1 || this.songsHasMore)) {
              this.songsPager()
            }
          }

          // ---- 相似歌手（补充内容的补充：为空整节不出现） ----
          if (this.isArtist() && (this.simiLoading || this.simiArtists.length > 0)) {
            Column({ space: Dim.s3 }) {
              Text('相似歌手')
                .fontSize(Dim.fsHeadline)
                .fontWeight(FontWeight.Bold)
                .fontColor(Tokens.text1)
                .width('100%')
              if (this.simiLoading) {
                Row() {
                  LoadingProgress().width(Dim.iconMd).height(Dim.iconMd)
                }
                .padding({ top: Dim.s2, bottom: Dim.s2 })
              } else {
                Flex({ wrap: FlexWrap.Wrap }) {
                  ForEach(this.simiArtists, (a: SimiArtist) => {
                    Text(a.name)
                      .fontSize(Dim.fsBody)
                      .fontColor(Tokens.text1)
                      .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s2, bottom: Dim.s2 })
                      .borderRadius(Dim.radiusRow)
                      .border({ width: Dim.hairline, color: Tokens.line })
                      .backgroundColor(Tokens.panel)
                      .margin({ right: Dim.s3, bottom: Dim.s3 })
                      .accessibilityText(`查看相似歌手 ${a.name}`)
                      .onClick(() => { this.pushEntry('artist', a.id, a.name); })
                  }, (a: SimiArtist) => a.id)
                }
                .width('100%')
              }
            }
            .width('100%')
            .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s5 })
          }

          // 底部留白（滚动到底不贴边）
          Column().height(Dim.s6)
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    // 避让区由 NativeRoot 壳层 padding 统一处理（本页已收进内容区，勿再叠加）
    .padding({ top: Dim.s2, bottom: Dim.s4 })
    .backgroundColor(Tokens.bg)
  }
}
