import { hilog } from '@kit.PerformanceAnalysisKit';
import { APIClient, ApiError } from '../core/APIClient';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { FavoriteItem, Track, artistLine } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { Copy, parseAiHeader } from '../common/Copy';
import { Dim } from '../common/Dimension';
import { FavRowSource } from '../common/TrackSources';
import { TrackItem } from './TrackItem';
import { NeuInput } from './NeuInput';
import { EmptyState } from './EmptyState';
import { SkeletonList } from './SkeletonList';
import { WebButton, NeuBtnSize } from '../common/WebButtons';
import { AppState, K_FAV_REV, K_FAV_KEYWORD } from '../viewmodel/AppState';

const TAG = 'SuenMusic_Fav';
const PAGE_LIMIT = 50;
/** AI 摘要拆不出主标题时的回退页名（web Favorites.vue parseAiHeader 默认值同款） */
const HEADER_DEFAULT_TITLE = '收藏曲目';

/**
 * 收藏页：游标分页列表 + 收藏内本地搜索 + 取消收藏 + 点击播放 + 下拉刷新。
 *
 * T10 批次 E（对齐 web `Favorites.vue` 移动断点）：
 * - 头部 = AI 摘要两级标题（`/api/favorites` 首页的 `summary` → parseAiHeader
 *   拆主标题/副题；没有摘要回退「收藏曲目」+ 行内总数小字，web `.title .cnt` 同构）。
 * - 收藏内搜索：纯本地过滤（歌名/歌手/专辑，忽略大小写），不发请求。
 *   关键词一非空就后台把剩余分页全部拉完（web 是全量装载后过滤，`MAX_PAGES` 循环），
 *   否则会拿已装载的部分误报「没有匹配」。
 * - no-match 态：有关键词、有收藏、全部拉完仍一条不中 → 文案 + 「清除搜索」钮。
 * - 返回手势先清关键词再退出：关键词走 AppStorage（K_FAV_KEYWORD），NativeRoot
 *   onBackPress 在收藏 Tab 上读到非空先清它（web registerBackHandler 同语义）。
 * - 行序号 = 过滤后列表的 1 起序号（web `:index="i + 1"`）。
 *
 * 服务端按 `createdAt` 倒序，游标是 `(createdAt, trackId)` 复合结构，
 * `nextCursor` 为空即到底。取消收藏幂等，删完本地立即移除、总数 -1。
 * 点歌 = 把收藏列表换成播放队列（`setQueue`），与首页同一入口。
 * 长列表懒加载（S4 §四）：数据真相仍是 `this.items`，`rows` 是「关键词过滤后的」渲染投影。
 */
@Component
export struct FavoritesPage {
  @State items: FavoriteItem[] = [];
  @State total: number = 0;
  @State loading: boolean = false;
  @State loadingMore: boolean = false;
  @State err: string = '';
  /** 下拉刷新状态（Refresh 两向绑定） */
  @State refreshing: boolean = false;
  /** 收藏的 AI 摘要（首页分页才返回；空串 = 没有，头部回退默认形态） */
  @State aiSummary: string = '';
  /** 其他页面收藏/取消成功后版本号 +1 → 立即重拉首页数据（本页自己的取消走本地剪枝） */
  @StorageProp(K_FAV_REV) @Watch('onFavRevChange') favRev: number = 0;
  /** 收藏内搜索关键词：AppStorage 通道（NativeRoot 返回手势共享清空），本地过滤即时生效 */
  @StorageLink(K_FAV_KEYWORD) @Watch('onKeywordChange') keyword: string = '';

  /** LazyForEach 渲染投影（数据真相仍是 this.items，投影时叠加关键词过滤） */
  private rows: FavRowSource = new FavRowSource();
  private nextCursor: string = '';
  private reachedEnd: boolean = false;
  /** ensureAllLoaded 的轮次票：新一轮启动后旧循环立即让位（关键词变化/刷新重拉时） */
  private allLoadTicket: number = 0;

  aboutToAppear(): void { this.load(); }

  /** 搜索/每日/首页右滑收藏后切回本页：不用杀进程就能看到新曲目 */
  onFavRevChange(): void {
    this.load();
  }

  /** 关键词变化：投影立即重算；非空且没拉到底 → 后台把剩余分页全部拉完再判定 no-match */
  onKeywordChange(): void {
    this.syncRows();
    if (this.keyword.trim().length > 0 && !this.reachedEnd) {
      void this.ensureAllLoaded();
    }
  }

  // ---------------- 头部（AI 摘要 → 主标题 + 副题，web parseAiHeader 同口径） ----------------

  private headerTitle(): string {
    if (this.items.length === 0 || this.aiSummary.length === 0) {
      return HEADER_DEFAULT_TITLE;
    }
    return parseAiHeader(this.aiSummary, HEADER_DEFAULT_TITLE).title;
  }

  private headerSub(): string {
    if (this.items.length === 0 || this.aiSummary.length === 0) {
      return '';
    }
    return parseAiHeader(this.aiSummary, HEADER_DEFAULT_TITLE).sub;
  }

  // ---------------- 收藏内搜索（纯本地过滤：歌名 / 歌手 / 专辑，忽略大小写） ----------------

  /** 关键词过滤后的列表；快照缺曲目的兜底行不参与匹配（web items 全是完整曲目） */
  private filteredItems(): FavoriteItem[] {
    const k = this.keyword.trim().toLowerCase();
    if (k.length === 0) {
      return this.items;
    }
    const out: FavoriteItem[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const t = it.track;
      if (t === undefined) { continue; }
      if (t.name.toLowerCase().includes(k)
        || artistLine(t).toLowerCase().includes(k)
        || t.al.name.toLowerCase().includes(k)) {
        out.push(it);
      }
    }
    return out;
  }

  /** 有关键词、有收藏，但一条都没匹配上（须等全部拉完，避免拿部分数据误报） */
  private isNoMatch(): boolean {
    return !this.loading && this.err.length === 0 && this.items.length > 0
      && this.keyword.trim().length > 0
      && this.filteredItems().length === 0 && this.reachedEnd;
  }

  /**
   * 把剩余分页全部拉完（web 装载循环的等价物，只是在有搜索意图时才做）。
   * loadMore 自带并发/游标守卫；err 中断循环（页脚有重试入口），轮次票防旧循环复活。
   */
  private async ensureAllLoaded(): Promise<void> {
    const ticket = ++this.allLoadTicket;
    while (!this.reachedEnd && this.err.length === 0 && this.loading === false) {
      // 页脚装载在途：等它落地再继续，避免 loadMore 并发守卫直接 return 造成空转
      if (this.loadingMore) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 120); });
        continue;
      }
      await this.loadMore();
      if (ticket !== this.allLoadTicket) { return; }
    }
  }

  /** this.items → LazyForEach 投影（叠加关键词过滤；数据每次变化后同步） */
  private syncRows(): void {
    this.rows.reload(this.filteredItems());
  }

  private async load(): Promise<void> {
    if (this.loading) { return; }
    // 新一轮首页数据：旧的全量装载循环让位
    this.allLoadTicket++;
    this.loading = true;
    this.err = '';
    this.nextCursor = '';
    this.reachedEnd = false;
    try {
      const page = await APIClient.shared().favorites(PAGE_LIMIT, '');
      this.items = page.items;
      this.total = page.total;
      // 服务端到底时返回 nextCursor: null（routes/favorites.ts:66），undefined 防不住 null
      this.nextCursor = page.nextCursor ?? '';
      this.reachedEnd = this.nextCursor.length === 0;
      // AI 摘要只有首页分页返回（web Favorites.vue load() 第一页取 res.summary）
      this.aiSummary = page.summary ?? '';
    } catch (e) {
      this.err = Copy.describeError(e);
    } finally {
      this.loading = false;
      this.refreshing = false;
      this.syncRows();
    }
  }

  private async loadMore(): Promise<void> {
    if (this.loading || this.loadingMore || this.reachedEnd || this.nextCursor.length === 0) { return; }
    this.loadingMore = true;
    try {
      const page = await APIClient.shared().favorites(PAGE_LIMIT, this.nextCursor);
      const known = new Set<string>();
      for (let i = 0; i < this.items.length; i++) { known.add(this.items[i].trackId); }
      const merged: FavoriteItem[] = [];
      for (let i = 0; i < this.items.length; i++) { merged.push(this.items[i]); }
      for (let i = 0; i < page.items.length; i++) {
        if (!known.has(page.items[i].trackId)) { merged.push(page.items[i]); }
      }
      this.items = merged;
      this.total = page.total;
      this.nextCursor = page.nextCursor ?? '';
      this.reachedEnd = this.nextCursor.length === 0;
    } catch (e) {
      this.err = Copy.describeError(e);
    } finally {
      this.loadingMore = false;
      this.syncRows();
    }
  }

  /** 右滑取消收藏：按 trackId 定位（右滑动画期间行还在列表里，用索引会点错行）。
    *  返回 true = 已落地（本地已剪行）；false = 失败（行由 TrackItem 弹回 + toast） */
  private async unfavorite(trackId: string): Promise<boolean> {
    let index = -1;
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].trackId === trackId) { index = i; break; }
    }
    const item = index < 0 ? undefined : this.items[index];
    if (item === undefined) { return true; }
    try {
      await APIClient.shared().removeFavorite(item.trackId);
      // 服务端幂等（删不存在的也 200），本地立即移除
      const left: FavoriteItem[] = [];
      for (let i = 0; i < this.items.length; i++) {
        if (i !== index) { left.push(this.items[i]); }
      }
      this.items = left;
      this.total = Math.max(0, this.total - 1);
      this.syncRows();
      return true;
    } catch (e) {
      const msg = (e as ApiError).message;
      try {
        this.getUIContext().getPromptAction().showToast({
          message: msg === undefined ? Copy.favOpFailed : msg,
          duration: 2000
        });
      } catch (toastErr) {
        hilog.warn(0x0000, TAG, 'toast 显示失败: %{public}s', JSON.stringify(toastErr));
      }
      hilog.warn(0x0000, TAG, '取消收藏失败: %{public}s', JSON.stringify(e));
      return false;
    }
  }

  /** 收藏列表 → 播放队列（快照里没有 track 的条目不参与播放）。
    *  按 trackId 定位：前面的行被右滑剪掉后，构建时闭包里的索引会过期 */
  private async playAt(trackId: string): Promise<void> {
    if (this.loading) { return; }
    // 队列装满：没拉到底先整列装填（items 只追加，按 trackId 定位不受影响）
    if (!this.reachedEnd) {
      await this.ensureAllLoaded();
    }
    let index = -1;
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].trackId === trackId) { index = i; break; }
    }
    if (index < 0) { return; }
    const list: Track[] = [];
    const playableAt: number[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const t = this.items[i].track;
      if (t !== undefined) {
        list.push(t);
        playableAt.push(i);
      }
    }
    const pos = playableAt.indexOf(index);
    if (pos < 0 || list.length === 0) { return; }
    let token = '';
    try {
      token = (await APIClient.shared().streamSessionToken()).token;
    } catch (e) {
      hilog.warn(0x0000, TAG, '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      await MediaPlayerCore.shared().setQueue(list, pos, token, '收藏');
    } catch (e) {
      this.err = Copy.describeError(e);
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  // ---------------- UI ----------------

  /** 头部：AI 摘要主标题（拆不出 = 默认页名 + 行内总数小字）+ 副题小字（web .head-info） */
  @Builder
  header() {
    Column({ space: Dim.s1 }) {
      Row() {
        Text(this.headerTitle())
          .fontSize(Dim.fsDisplay)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text1)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        // 行内总数：只在默认页名下露出（web .cnt 的 v-if 同款；AI 标题时 web 也藏）
        if (this.headerTitle() === HEADER_DEFAULT_TITLE && this.total > 0) {
          Text(this.total.toString())
            .fontSize(Dim.fsBody)
            .fontColor(Tokens.text2)
            .margin({ left: Dim.s2 })
            .alignSelf(ItemAlign.End)
        }
      }
      .alignItems(VerticalAlign.Bottom)
      if (this.headerSub().length > 0) {
        Text(this.headerSub())
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.text2)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s1 })
  }

  /** 收藏内搜索行（web .search-row：加载成功且有收藏才露出；本地过滤不发请求） */
  @Builder
  searchRow() {
    Row() {
      NeuInput({
        content: this.keyword,
        placeholder: '搜索歌名 / 歌手 / 专辑',
        searchIcon: true
      })
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s1, bottom: Dim.s1 })
  }

  /** no-match 态（web .empty：文案 + 清除搜索钮） */
  @Builder
  noMatch() {
    Column({ space: Dim.s3 }) {
      Text(`没有匹配「${this.keyword.trim()}」的歌曲。`)
        .fontSize(Dim.fsBody)
        .fontColor(Tokens.text2)
      WebButton({
        labelStr: '清除搜索',
        sizeKind: NeuBtnSize.MD,
        onTap: () => { this.keyword = ''; }
      })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  listFooter() {
    Row() {
      if (this.loadingMore) {
        LoadingProgress().width(Dim.iconMd).height(Dim.iconMd)
      } else if (this.err.length > 0) {
        // 翻页失败：给人话 + 可手动重试
        Text(this.err)
          .fontSize(Dim.fsMinor).fontColor('#E5484D')
          .padding({ top: Dim.s3, bottom: Dim.s3 })
          .onClick(() => { this.loadMore(); })
      } else if (!this.reachedEnd) {
        Text('加载更多')
          .fontSize(Dim.fsMinor).fontColor(Tokens.text2)
          .padding({ top: Dim.s3, bottom: Dim.s3 })
          .onClick(() => { this.loadMore(); })
      }
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
  }

  build() {
    Column() {
      this.header()
      if (this.loading && this.items.length === 0) {
        // 首次加载：骨架屏替代转圈（S4 §六）
        SkeletonList()
      } else if (this.err.length > 0 && this.items.length === 0) {
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
      } else if (this.items.length === 0) {
        // 空收藏：统一空态（S4 §五）
        EmptyState({
          icon: $r('sys.symbol.heart'),
          title: Copy.emptyFavTitle,
          subtitle: Copy.emptyFavSub
        })
      } else {
        this.searchRow()
        if (this.isNoMatch()) {
          this.noMatch()
        } else {
          // 下拉刷新（S4 §10.3）：默认参数、默认阻尼
          Refresh({ refreshing: $$this.refreshing }) {
            List({ space: 0 }) {
              LazyForEach(this.rows, (item: FavoriteItem, index: number) => {
                ListItem() {
                  if (item.track !== undefined) {
                    // 收藏页：每行都是收藏 —— 右滑 = 取消收藏且行滑出消失（web swipeRemoveOnUnfavorite）。
                    // 行内不再放红心（web 移动端同样隐藏红心列，收藏入口就是右滑）
                    TrackItem({
                      track: item.track,
                      index: index + 1,
                      isFav: true,
                      markFav: false,
                      showDur: true,
                      swipeRemoveOnUnfavorite: true,
                      onSwipeToggle: () => this.unfavorite(item.trackId),
                      onTap: () => { this.playAt(item.trackId); }
                    })
                  } else {
                    // 快照缺曲目的兜底行：还能显示 id 并允许取消收藏
                    Row() {
                      Text(item.trackId)
                        .fontSize(Dim.fsSub).fontColor(Tokens.text2).maxLines(1)
                        .textOverflow({ overflow: TextOverflow.Ellipsis })
                        .layoutWeight(1)
                      Image($r('app.media.card_heart_filled'))
                        .width(Dim.iconLg).height(Dim.iconLg)
                        .fillColor(Tokens.accent)
                        .accessibilityText('取消收藏')
                        .onClick(() => { this.unfavorite(item.trackId); })
                    }
                    .width('100%')
                    .height(Dim.rowHeight)
                    .padding({ left: Dim.s4, right: Dim.s4 })
                  }
                }
              }, (item: FavoriteItem) => item.trackId)
              ListItem() { this.listFooter() }
            }
            .width('100%')
            .layoutWeight(1)
            .onReachEnd(() => {
              // 关键词空 = 正常浏览翻页；关键词非空 = ensureAllLoaded 循环在拉，这里不重复触发
              if (this.keyword.trim().length === 0) { this.loadMore(); }
            })
          }
          .onRefreshing(() => { this.load(); })
          .layoutWeight(1)
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
