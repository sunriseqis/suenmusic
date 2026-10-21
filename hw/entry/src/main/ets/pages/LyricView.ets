/**
 * 歌词（S3）。
 *
 * 解析器复用 `common/NowPlaying.ets` 的 `parseLyricLines` / `activeLyricIndex` ——
 * 桌面卡片的滚动歌词用的是同一份实现，**不要在页面里再写一套**（两份解析必然漂移）。
 *
 * 歌词按曲目缓存到内存：一首歌来回切不该反复打服务端（服务端本身也有
 * `Cache-Control: private, max-age=86400`，但省一次往返总是好的）。
 */

import { APIClient } from '../core/APIClient';
import { LyricResult } from '../core/Models';
import { MediaPlayerCore, K_TRACKID, K_POS } from '../core/MediaPlayerCore';
import { LyricLine, parseLyricLines, activeLyricIndex } from '../common/NowPlaying';
import { Tokens } from '../common/Tokens';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'SuenMusic_Lyric';
const DOMAIN = 0x0000;

/** 曲目 id → 解析好的歌词行（模块级缓存，跨页面实例共享） */
const LYRIC_CACHE: Map<string, LyricLine[]> = new Map<string, LyricLine[]>();
/** 缓存条数上限：长会话里换很多歌也不会无限涨 */
const CACHE_LIMIT = 60;

@Component
export struct LyricView {
  @StorageLink(K_TRACKID) @Watch('onTrackChanged') trackId: string = '';
  @StorageLink(K_POS) @Watch('onPositionChanged') positionMs: number = 0;

  @State lines: LyricLine[] = [];
  @State activeIndex: number = -1;
  /** idle | loading | ready | empty | error */
  @State status: string = 'idle';
  @State errText: string = '';

  private scroller: Scroller = new Scroller();
  /** 当前正在加载的曲目（切歌时用它丢弃过期结果） */
  private loadingId: string = '';

  aboutToAppear(): void {
    this.onTrackChanged();
  }

  onTrackChanged(): void {
    const id = this.trackId;
    if (id.length === 0) {
      this.status = 'idle';
      this.lines = [];
      this.activeIndex = -1;
      return;
    }
    const cached = LYRIC_CACHE.get(id);
    if (cached !== undefined) {
      this.apply(id, cached);
      return;
    }
    this.load(id);
  }

  private async load(id: string): Promise<void> {
    this.loadingId = id;
    this.status = 'loading';
    this.errText = '';
    try {
      const r: LyricResult = await APIClient.shared().lyric(id);
      const raw = r.lrc === undefined || r.lrc.lyric === undefined ? '' : r.lrc.lyric;
      const parsed = parseLyricLines(raw);
      if (LYRIC_CACHE.size >= CACHE_LIMIT) {
        // 不用 keys().next().value（ArkTS 下是 any）：forEach 找最早写入的键淘汰
        let oldestKey: string = '';
        LYRIC_CACHE.forEach((value: LyricLine[], key: string) => {
          if (oldestKey.length === 0) { oldestKey = key; }
        });
        if (oldestKey.length > 0) { LYRIC_CACHE.delete(oldestKey); }
      }
      LYRIC_CACHE.set(id, parsed);
      // 期间切歌了 → 丢弃这次结果，别把上一首的歌词盖到新曲目上
      if (this.loadingId !== id || this.trackId !== id) { return; }
      this.apply(id, parsed);
    } catch (e) {
      if (this.loadingId !== id || this.trackId !== id) { return; }
      this.status = 'error';
      this.errText = '歌词加载失败';
      hilog.warn(DOMAIN, TAG, '歌词加载失败 %{public}s: %{public}s', id, JSON.stringify(e));
    }
  }

  private apply(id: string, parsed: LyricLine[]): void {
    this.lines = parsed;
    if (parsed.length === 0) {
      this.status = 'empty';
      this.activeIndex = -1;
      return;
    }
    this.status = 'ready';
    this.activeIndex = activeLyricIndex(parsed, this.positionMs);
    this.scrollToActive(false);
  }

  onPositionChanged(): void {
    if (this.lines.length === 0) { return; }
    const idx = activeLyricIndex(this.lines, this.positionMs);
    if (idx === this.activeIndex) { return; }
    this.activeIndex = idx;
    this.scrollToActive(true);
  }

  private scrollToActive(smooth: boolean): void {
    const idx = this.activeIndex;
    if (idx < 0 || idx >= this.lines.length) { return; }
    try {
      this.scroller.scrollToIndex(idx, smooth, ScrollAlign.CENTER);
    } catch (e) {
      // 列表还没布局完时会抛，忽略即可（下一拍 positionMs 变化还会再滚）
    }
  }

  build() {
    Column() {
      if (this.status === 'idle') {
        Text('暂无播放中的曲目').fontSize(13).fontColor(Tokens.text2)
      } else if (this.status === 'loading') {
        LoadingProgress().width(28).height(28)
      } else if (this.status === 'empty') {
        Text('这首歌暂无歌词').fontSize(13).fontColor(Tokens.text2)
      } else if (this.status === 'error') {
        Column({ space: 8 }) {
          Text(this.errText).fontSize(13).fontColor('#E5484D')
          Button('重试').height(32).fontSize(12)
            .backgroundColor(Tokens.panel2).fontColor(Tokens.text1)
            .onClick(() => { this.onTrackChanged(); })
        }
      } else {
        List({ scroller: this.scroller, space: 0 }) {
          // 上下留白：让第一行/最后一行也能滚到中间（Blank 不能直接进 ListItem，用空 Column 占位）
          ListItem() { Column().height(120) }
          ForEach(this.lines, (line: LyricLine, i: number) => {
            ListItem() {
              Text(line.text)
                .fontSize(i === this.activeIndex ? 18 : 15)
                .fontWeight(i === this.activeIndex ? FontWeight.Medium : FontWeight.Normal)
                .fontColor(i === this.activeIndex ? Tokens.accent : Tokens.text2)
                .textAlign(TextAlign.Center)
                .width('100%')
                .padding({ left: 24, right: 24, top: 8, bottom: 8 })
                .onClick(() => {
                  // 点歌词跳转：对齐 Web 端行为
                  MediaPlayerCore.shared().seek(Math.max(0, line.timeMs));
                })
            }
          }, (line: LyricLine, i: number) => i + '_' + line.timeMs)
          ListItem() { Column().height(160) }
        }
        .width('100%')
        .height('100%')
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }
}
