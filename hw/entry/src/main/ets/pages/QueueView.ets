/**
 * 播放队列（S3；S4 热区/空态打磨）。
 *
 * 数据源是 `MediaPlayerCore` 的**快照**（UI 不持有真相）：队列每次变化
 * （装载/切歌/增删/拖拽）都会自增 `K_QUEUE_VERSION`，本组件靠 `@Watch` 重取。
 *
 * 为什么不让 UI 直接改 `queue` 数组：播放状态机的 owner 只能是内核。
 * 一旦 UI 也能改数组，就会出现"界面顺序变了但播放器还按旧序接续"。
 */

import { MediaPlayerCore, K_QUEUE_VERSION, K_INDEX } from '../core/MediaPlayerCore';
import { Track, artistLine } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { Copy } from '../common/Copy';
import { Dim } from '../common/Dimension';
import { EmptyState } from './EmptyState';

@Component
export struct QueueView {
  @StorageLink(K_QUEUE_VERSION) @Watch('onQueueChanged') queueVersion: number = 0;
  @StorageLink(K_INDEX) currentIndex: number = -1;
  @State items: Track[] = [];

  aboutToAppear(): void {
    this.refresh();
  }

  onQueueChanged(): void {
    this.refresh();
  }

  private refresh(): void {
    this.items = MediaPlayerCore.shared().getQueueSnapshot();
  }

  /** 拖拽时跟随手指的那块浮层（不能叫 dragPreview —— 撞 ArkUI 内置属性 .dragPreview()） */
  @Builder
  dragItemPopup(index: number) {
    Row({ space: Dim.s2 }) {
      Text(this.items[index].name)
        .fontSize(Dim.fsSub)
        .fontColor(Tokens.text1)
        .maxLines(1)
        .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s2, bottom: Dim.s2 })
    }
    .backgroundColor(Tokens.panel2)
    .borderRadius(Dim.radiusRow)
  }

  build() {
    Column() {
      Row() {
        Text('播放队列').fontSize(Dim.fsTitle).fontColor(Tokens.text1).fontWeight(FontWeight.Medium)
        Blank()
        Text(`${this.items.length} 首`).fontSize(Dim.fsCaption).fontColor(Tokens.text2)
      }
      .width('100%')
      .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s2 })

      if (this.items.length === 0) {
        // 队列空：统一空态（S4 §五）
        EmptyState({
          title: Copy.emptyQueueTitle,
          subtitle: Copy.emptyQueueSub
        })
      } else {
        List({ space: 0 }) {
          ForEach(this.items, (item: Track, i: number) => {
            ListItem() {
              Row({ space: Dim.s2 }) {
                Text(`${i + 1}`)
                  .fontSize(Dim.fsCaption)
                  .fontColor(i === this.currentIndex ? Tokens.accent : Tokens.text2)
                  .width(Dim.seqW)
                  .textAlign(TextAlign.Center)

                Column({ space: Dim.s0 }) {
                  Text(item.name)
                    .fontSize(Dim.fsSub)
                    .fontColor(i === this.currentIndex ? Tokens.accent : Tokens.text1)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(artistLine(item))
                    .fontSize(Dim.fsCaption)
                    .fontColor(Tokens.text2)
                    .maxLines(1)
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)

                if (i === this.currentIndex) {
                  Text('播放中').fontSize(Dim.fsCaption).fontColor(Tokens.accent)
                }
                // 删除键：可点区域扩到 44vp（S4 §三 touchMin，原来 28vp 太小）
                Button('删除')
                  .height(Dim.touchMin)
                  .fontSize(Dim.fsCaption)
                  .backgroundColor(Tokens.panel2)
                  .fontColor(Tokens.text2)
                  .accessibilityText(`从队列删除 ${item.name}`)
                  .onClick(() => {
                    MediaPlayerCore.shared().removeAt(i);
                  })
              }
              .width('100%')
              .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s2, bottom: Dim.s2 })
              .backgroundColor(i === this.currentIndex ? Tokens.panel : Tokens.bg)
              .onClick(() => {
                MediaPlayerCore.shared().jumpTo(i, true);
              })
            }
          }, (item: Track, i: number) => item.id + '_' + i)
        }
        .width('100%')
        .layoutWeight(1)
        .divider({ strokeWidth: 1, color: Tokens.line })
        /**
         * 拖拽排序。`onItemDrop` 里只把两个下标丢给内核，
         * 由内核负责「移动 + 当前下标修正 + 版本自增」。
         */
        .onItemDragStart((event: ItemDragInfo, itemIndex: number) => {
          return this.dragItemPopup(itemIndex);
        })
        .onItemDrop((event: ItemDragInfo, itemIndex: number,
          insertIndex: number, isSuccess: boolean) => {
          if (!isSuccess || itemIndex === insertIndex) { return; }
          MediaPlayerCore.shared().moveItem(itemIndex, insertIndex);
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
