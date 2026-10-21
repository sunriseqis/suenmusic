import { hilog } from '@kit.PerformanceAnalysisKit';
import { APIClient, ApiError } from '../core/APIClient';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { FavoriteItem, Track } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { TrackItem } from './TrackItem';

const TAG = 'SuenMusic_Fav';
const PAGE_LIMIT = 50;

/**
 * 收藏页：游标分页列表 + 取消收藏 + 点击播放。
 *
 * 服务端按 `createdAt` 倒序，游标是 `(createdAt, trackId)` 复合结构，
 * `nextCursor` 为空即到底。取消收藏幂等，删完本地立即移除、总数 -1。
 * 点歌 = 把收藏列表换成播放队列（`setQueue`），与首页同一入口。
 */
@Component
export struct FavoritesPage {
  @State items: FavoriteItem[] = [];
  @State total: number = 0;
  @State loading: boolean = false;
  @State loadingMore: boolean = false;
  @State err: string = '';

  private nextCursor: string = '';
  private reachedEnd: boolean = false;

  aboutToAppear(): void { this.load(); }

  private async load(): Promise<void> {
    if (this.loading) { return; }
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
    } catch (e) {
      this.err = (e as ApiError).message === undefined ? '加载失败' : (e as ApiError).message;
    } finally {
      this.loading = false;
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
      this.err = (e as ApiError).message === undefined ? '加载失败' : (e as ApiError).message;
    } finally {
      this.loadingMore = false;
    }
  }

  private async unfavorite(index: number): Promise<void> {
    const item = this.items[index];
    if (item === undefined) { return; }
    try {
      await APIClient.shared().removeFavorite(item.trackId);
      // 服务端幂等（删不存在的也 200），本地立即移除
      const left: FavoriteItem[] = [];
      for (let i = 0; i < this.items.length; i++) {
        if (i !== index) { left.push(this.items[i]); }
      }
      this.items = left;
      this.total = Math.max(0, this.total - 1);
    } catch (e) {
      this.err = (e as ApiError).message === undefined ? '取消收藏失败' : (e as ApiError).message;
      hilog.warn(0x0000, TAG, '取消收藏失败: %{public}s', JSON.stringify(e));
    }
  }

  /** 收藏列表 → 播放队列（快照里没有 track 的条目不参与播放） */
  private async playAt(index: number): Promise<void> {
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
      await MediaPlayerCore.shared().setQueue(list, pos, token);
    } catch (e) {
      this.err = '无法装载音源：' + ((e as ApiError).message ?? '');
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  @Builder
  header() {
    Row() {
      Text('我的收藏').fontSize(16).fontWeight(FontWeight.Medium).fontColor(Tokens.text1)
      Blank()
      Text(`共 ${this.total} 首`).fontSize(12).fontColor(Tokens.text2)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 4 })
  }

  @Builder
  listFooter() {
    Row() {
      if (this.loadingMore) {
        LoadingProgress().width(20).height(20)
      } else if (this.err.length > 0) {
        // 翻页失败：给人话 + 可手动重试
        Text(this.err)
          .fontSize(12).fontColor('#E5484D')
          .padding({ top: 12, bottom: 12 })
          .onClick(() => { this.loadMore(); })
      } else if (!this.reachedEnd) {
        Text('加载更多')
          .fontSize(12).fontColor(Tokens.text2)
          .padding({ top: 12, bottom: 12 })
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
        Row() { LoadingProgress().width(28).height(28) }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
      } else if (this.err.length > 0 && this.items.length === 0) {
        Column({ space: 10 }) {
          Text(this.err).fontSize(13).fontColor('#E5484D')
          Button('重试').onClick(() => { this.load(); })
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (this.items.length === 0) {
        Column() {
          Text('还没有收藏')
            .fontSize(13).fontColor(Tokens.text2)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List({ space: 0 }) {
          ForEach(this.items, (item: FavoriteItem, i: number) => {
            ListItem() {
              if (item.track !== undefined) {
                TrackItem({
                  track: item.track,
                  actionIcon: $r('app.media.card_heart_filled'),
                  actionColor: Tokens.accent,
                  onAction: () => { this.unfavorite(i); },
                  onTap: () => { this.playAt(i); }
                })
              } else {
                // 快照缺曲目的兜底行：还能显示 id 并允许取消收藏
                Row() {
                  Text(item.trackId)
                    .fontSize(14).fontColor(Tokens.text2).maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .layoutWeight(1)
                  Image($r('app.media.card_heart_filled'))
                    .width(22).height(22)
                    .fillColor(Tokens.accent)
                    .onClick(() => { this.unfavorite(i); })
                }
                .width('100%')
                .height(56)
                .padding({ left: 16, right: 16 })
              }
            }
          }, (item: FavoriteItem) => item.trackId + ':' + item.createdAt.toString())
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
