/**
 * LazyForEach 数据源（S4 §四：首页新歌 / 搜索结果 / 收藏页 / 歌词改懒加载）。
 *
 * 页面的 @State 数组仍是唯一真相（合并 / 剪枝 / 翻页逻辑一概不动），
 * 这里只是它的**渲染投影**：数据每次变化后页面调 `reload()` 整组同步，
 * 单行收藏标记变化用 `setFav()` 走 `onDataChange` 精确刷新（避免整表重挂）。
 */
import { Track, FavoriteItem } from '../core/Models';
import { LyricLine } from './NowPlaying';

/** 曲目行：曲目 + 行内随收藏交互变化的表现层状态（`no` = 显示序号，1 起） */
export class TrackRow {
  readonly track: Track;
  fav: boolean;
  no: number;

  constructor(track: Track, fav: boolean, no: number) {
    this.track = track;
    this.fav = fav;
    this.no = no;
  }
}

/** 歌词行：原文 + 翻译 + 当前行高亮（时间标签做键） */
export class LyricRow {
  readonly line: LyricLine;
  readonly trans: string;
  active: boolean;

  constructor(line: LyricLine, trans: string, active: boolean) {
    this.line = line;
    this.trans = trans;
    this.active = active;
  }
}

/** IDataSource 公共底座：监听器管理 + 整组 reload */
class BaseSource<T> implements IDataSource {
  protected items: T[] = [];
  protected listeners: DataChangeListener[] = [];

  totalCount(): number {
    return this.items.length;
  }

  getData(index: number): T {
    return this.items[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    this.listeners.push(listener);
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const left: DataChangeListener[] = [];
    for (let i = 0; i < this.listeners.length; i++) {
      if (this.listeners[i] !== listener) {
        left.push(this.listeners[i]);
      }
    }
    this.listeners = left;
  }

  /** 整组替换（页面数据结构变化后的全量投影） */
  reload(items: T[]): void {
    this.items = items;
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].onDataReloaded();
    }
  }

  protected notifyChange(index: number): void {
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].onDataChange(index);
    }
  }
}

/** 首页 / 搜索的曲目行数据源（支持单行收藏标记精确刷新） */
export class TrackRowSource extends BaseSource<TrackRow> {
  setFav(trackId: string, fav: boolean): void {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].track.id === trackId) {
        if (this.items[i].fav !== fav) {
          this.items[i].fav = fav;
          this.notifyChange(i);
        }
        return;
      }
    }
  }
}

/** 收藏页数据源（行 = FavoriteItem；整组 reload 即可，收藏态恒为 true） */
export class FavRowSource extends BaseSource<FavoriteItem> {
}

/** 歌词数据源（支持"当前行"高亮的单行刷新，避免每秒重挂可见区） */
export class LyricRowSource extends BaseSource<LyricRow> {
  setActive(index: number, active: boolean): void {
    if (index < 0 || index >= this.items.length) {
      return;
    }
    if (this.items[index].active !== active) {
      this.items[index].active = active;
      this.notifyChange(index);
    }
  }
}
