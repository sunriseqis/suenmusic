/**
 * 播放队列（S3）。
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
    Row({ space: 8 }) {
      Text(this.items[index].name)
        .fontSize(14)
        .fontColor(Tokens.text1)
        .maxLines(1)
        .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    }
    .backgroundColor(Tokens.panel2)
    .borderRadius(8)
  }

  build() {
    Column() {
      Row() {
        Text('播放队列').fontSize(15).fontColor(Tokens.text1).fontWeight(FontWeight.Medium)
        Blank()
        Text(`${this.items.length} 首`).fontSize(11).fontColor(Tokens.text2)
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      if (this.items.length === 0) {
        Column() {
          Text('队列是空的').fontSize(13).fontColor(Tokens.text2)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List({ space: 0 }) {
          ForEach(this.items, (item: Track, i: number) => {
            ListItem() {
              Row({ space: 10 }) {
                Text(`${i + 1}`)
                  .fontSize(11)
                  .fontColor(i === this.currentIndex ? Tokens.accent : Tokens.text2)
                  .width(22)
                  .textAlign(TextAlign.Center)

                Column({ space: 2 }) {
                  Text(item.name)
                    .fontSize(14)
                    .fontColor(i === this.currentIndex ? Tokens.accent : Tokens.text1)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(artistLine(item))
                    .fontSize(11)
                    .fontColor(Tokens.text2)
                    .maxLines(1)
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)

                if (i === this.currentIndex) {
                  Text('播放中').fontSize(10).fontColor(Tokens.accent)
                }
                Button('删除')
                  .height(28)
                  .fontSize(11)
                  .backgroundColor(Tokens.panel2)
                  .fontColor(Tokens.text2)
                  .onClick(() => {
                    MediaPlayerCore.shared().removeAt(i);
                  })
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 10, bottom: 10 })
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
