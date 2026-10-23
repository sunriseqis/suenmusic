/**
 * 歌词（S3；T4 增加翻译双语行；S4 §四懒加载 + §五统一空态）。
 *
 * 解析器复用 `common/NowPlaying.ets` 的 `parseLyricLines` / `activeLyricIndex` ——
 * 桌面卡片的滚动歌词用的是同一份实现，**不要在页面里再写一套**（两份解析必然漂移）。
 *
 * 歌词按曲目缓存到内存：一首歌来回切不该反复打服务端（服务端本身也有
 * `Cache-Control: private, max-age=86400`，但省一次往返总是好的）。
 * T4 起缓存同时存原文行与对齐后的翻译行（`LyricDoc`），开关翻译不重新拉取。
 * S4 起行列表走 `LazyForEach`（长歌词 800 行也只挂可见区）：
 * 「当前行」高亮进行数据（`LyricRow.active`），逐行 `onDataChange` 精确刷新。
 */

import { APIClient } from '../core/APIClient';
import { LyricResult } from '../core/Models';
import { MediaPlayerCore, K_TRACKID, K_POS } from '../core/MediaPlayerCore';
import { LyricLine, parseLyricLines, activeLyricIndex } from '../common/NowPlaying';
import { Tokens } from '../common/Tokens';
import { Copy } from '../common/Copy';
import { WebButton, NeuBtnSize } from '../common/WebButtons';
import { Dim } from '../common/Dimension';
import { LyricRow, LyricRowSource } from '../common/TrackSources';
import { EmptyState } from './EmptyState';
import { K_LYRIC_TRANS } from '../viewmodel/AppState';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'SuenMusic_Lyric';
const DOMAIN = 0x0000;

/** 一首曲目解析后的完整歌词：原文行 + 对齐到每行的翻译（空串 = 该行无翻译） */
interface LyricDoc {
  lines: LyricLine[];
  trans: string[];
}

/** 曲目 id → 解析好的歌词（模块级缓存，跨页面实例共享） */
const LYRIC_CACHE: Map<string, LyricDoc> = new Map<string, LyricDoc>();
/** 缓存条数上限：长会话里换很多歌也不会无限涨 */
const CACHE_LIMIT = 60;
/** 翻译行与原文行的时间戳容差（毫秒）：两套 LRC 的时间标签必有细微出入 */
const TRANS_ALIGN_TOLERANCE_MS = 300;

/**
 * 翻译对齐：把 tlyric 的时间行贴到原文行上。
 * 两边都按时间升序，双指针一次扫完：|Δt| ≤ 300ms 视为同一行；
 * 命中不前移翻译指针（相邻原文行可能共享同一条翻译）。
 */
function alignTranslation(lines: LyricLine[], transLines: LyricLine[]): string[] {
  const out: string[] = [];
  let j = 0;
  for (let i = 0; i < lines.length; i++) {
    let text = '';
    while (j < transLines.length && transLines[j].timeMs < lines[i].timeMs - TRANS_ALIGN_TOLERANCE_MS) {
      j++;
    }
    if (j < transLines.length
      && Math.abs(transLines[j].timeMs - lines[i].timeMs) <= TRANS_ALIGN_TOLERANCE_MS) {
      text = transLines[j].text;
    }
    out.push(text);
  }
  return out;
}

/** 缓存写入（带上限淘汰） */
function cachePut(id: string, doc: LyricDoc): void {
  if (LYRIC_CACHE.size >= CACHE_LIMIT) {
    // 不用 keys().next().value（ArkTS 下是 any）：forEach 找最早写入的键淘汰
    let oldestKey: string = '';
    LYRIC_CACHE.forEach((value: LyricDoc, key: string) => {
      if (oldestKey.length === 0) { oldestKey = key; }
    });
    if (oldestKey.length > 0) { LYRIC_CACHE.delete(oldestKey); }
  }
  LYRIC_CACHE.set(id, doc);
}

/**
 * 取一首的完整歌词（缓存优先，未命中拉服务端并解析+对齐翻译）。
 * 模块级导出：PlayerPage 歌词 peek 在歌词面板未打开时也走这里预热（T10 批次 F）。
 */
export async function fetchLyricDoc(id: string): Promise<LyricDoc | null> {
  const cached = LYRIC_CACHE.get(id);
  if (cached !== undefined) { return cached; }
  try {
    const r: LyricResult = await APIClient.shared().lyric(id);
    const raw = r.lrc === undefined || r.lrc.lyric === undefined ? '' : r.lrc.lyric;
    const rawTrans = r.tlyric === undefined || r.tlyric.lyric === undefined ? '' : r.tlyric.lyric;
    const parsed = parseLyricLines(raw);
    const doc: LyricDoc = {
      lines: parsed,
      trans: alignTranslation(parsed, parseLyricLines(rawTrans))
    };
    cachePut(id, doc);
    return doc;
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '歌词加载失败 %{public}s: %{public}s', id, JSON.stringify(e));
    return null;
  }
}

/** 歌词 peek 结果：当前行附近 3 行 + 当前行相对下标（-1 = 无歌词/未加载） */
export interface LyricPeek {
  lines: LyricLine[];
  activeIndex: number;
}

/** 取当前行附近 3 行（web FullPlayer lyric-peek 同口径）：面板未开时 PlayerPage 底部预览用 */
export function peekLyric(id: string, posMs: number): LyricPeek {
  const empty: LyricPeek = { lines: [], activeIndex: -1 };
  if (id.length === 0) { return empty; }
  const doc = LYRIC_CACHE.get(id);
  if (doc === undefined || doc.lines.length === 0) { return empty; }
  const i = activeLyricIndex(doc.lines, posMs);
  const from = Math.max(0, i - 1);
  const to = Math.min(doc.lines.length - 1, i + 1);
  const out: LyricLine[] = [];
  for (let k = from; k <= to; k++) {
    out.push(doc.lines[k]);
  }
  return { lines: out, activeIndex: i - from };
}

@Component
export struct LyricView {
  @StorageLink(K_TRACKID) @Watch('onTrackChanged') trackId: string = '';
  @StorageLink(K_POS) @Watch('onPositionChanged') positionMs: number = 0;
  /** 显示歌词翻译（设置页开关，AppStorage 通道，默认开）；切换后整组重挂（懒加载行不感知 @StorageProp） */
  @StorageProp(K_LYRIC_TRANS) @Watch('onTransChanged') lyricTrans: boolean = true;

  @State lines: LyricLine[] = [];
  @State trans: string[] = [];
  @State activeIndex: number = -1;
  /** idle | loading | ready | empty | error */
  @State status: string = 'idle';
  @State errText: string = '';

  /** LazyForEach 渲染投影（原文行 + 翻译 + 当前行高亮，全在进行数据里） */
  private rows: LyricRowSource = new LyricRowSource();
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
      this.trans = [];
      this.activeIndex = -1;
      this.syncRows();
      return;
    }
    const cached = LYRIC_CACHE.get(id);
    if (cached !== undefined) {
      this.apply(id, cached);
      return;
    }
    this.load(id);
  }

  /** 翻译开关切换：懒加载行不感知 @StorageProp，整组重挂一次 */
  onTransChanged(): void {
    this.syncRows();
  }

  private async load(id: string): Promise<void> {
    this.loadingId = id;
    this.status = 'loading';
    this.errText = '';
    const doc = await fetchLyricDoc(id);
    // 期间切歌了 → 丢弃这次结果，别把上一首的歌词盖到新曲目上
    if (this.loadingId !== id || this.trackId !== id) { return; }
    if (doc === null) {
      this.status = 'error';
      this.errText = '歌词加载失败';
      return;
    }
    this.apply(id, doc);
  }

  private apply(id: string, doc: LyricDoc): void {
    this.lines = doc.lines;
    this.trans = doc.trans;
    if (doc.lines.length === 0) {
      this.status = 'empty';
      this.activeIndex = -1;
      this.syncRows();
      return;
    }
    this.status = 'ready';
    this.activeIndex = activeLyricIndex(doc.lines, this.positionMs);
    this.syncRows();
    this.scrollToActive(false);
  }

  /** lines + trans + activeIndex → LazyForEach 投影（切歌/翻译开关后整组同步） */
  private syncRows(): void {
    const rows: LyricRow[] = [];
    for (let i = 0; i < this.lines.length; i++) {
      rows.push(new LyricRow(this.lines[i], i < this.trans.length ? this.trans[i] : '', i === this.activeIndex));
    }
    this.rows.reload(rows);
  }

  onPositionChanged(): void {
    if (this.lines.length === 0) { return; }
    const idx = activeLyricIndex(this.lines, this.positionMs);
    if (idx === this.activeIndex) { return; }
    const prev = this.activeIndex;
    this.activeIndex = idx;
    // 当前行高亮：懒加载行只认行数据，逐行精确刷新（不整组重挂，避免滚动闪烁）
    this.rows.setActive(prev, false);
    this.rows.setActive(idx, true);
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
        Text('暂无播放中的曲目').fontSize(Dim.fsBody).fontColor(Tokens.text2)
      } else if (this.status === 'loading') {
        LoadingProgress().width(Dim.iconXl).height(Dim.iconXl)
      } else if (this.status === 'empty') {
        // 无歌词：统一空态（S4 §五，不带图标）
        EmptyState({ title: Copy.emptyLyricTitle })
      } else if (this.status === 'error') {
        Column({ space: Dim.s2 }) {
          Text(this.errText).fontSize(Dim.fsBody).fontColor('#E5484D')
          WebButton({
            labelStr: '重试',
            sizeKind: NeuBtnSize.SM,
            onTap: () => { this.onTrackChanged(); }
          })
        }
      } else {
        List({ scroller: this.scroller, space: 0 }) {
          // 上下留白：让第一行/最后一行也能滚到中间（Blank 不能直接进 ListItem，用空 Column 占位）
          ListItem() { Column().height(Dim.lyricPadTop) }
          // 长歌词懒加载（S4 §四）：只挂可见区附近的行
          LazyForEach(this.rows, (row: LyricRow) => {
            ListItem() {
              Column() {
                Text(row.line.text)
                  .fontSize(row.active ? Dim.fsHeadline : Dim.fsTitle)
                  .fontWeight(row.active ? FontWeight.Medium : FontWeight.Normal)
                  .fontColor(row.active ? Tokens.accent : Tokens.text2)
                  .textAlign(TextAlign.Center)
                  .width('100%')
                if (this.lyricTrans && row.trans.length > 0) {
                  // 翻译行：text2、字号比原文行小一档（T4 规格）
                  Text(row.trans)
                    .fontSize(row.active ? Dim.fsTitle : Dim.fsMinor)
                    .fontColor(Tokens.text2)
                    .textAlign(TextAlign.Center)
                    .width('100%')
                    .padding({ top: Dim.s0 })
                }
              }
              .alignItems(HorizontalAlign.Center)
              .width('100%')
              .padding({ left: Dim.s5, right: Dim.s5, top: Dim.s2, bottom: Dim.s2 })
              .onClick(() => {
                // 点歌词跳转：对齐 Web 端行为
                MediaPlayerCore.shared().seek(Math.max(0, row.line.timeMs));
              })
            }
          }, (row: LyricRow, i: number) => i + '_' + row.line.timeMs)
          ListItem() { Column().height(Dim.lyricPadBottom) }
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
