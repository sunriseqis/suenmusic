/**
 * 离线缓存面板（S3 增量 3；S4 打磨：尺寸令牌/热区/无障碍）。
 *
 * 顶部：已用/配额 + 进度条；中部：已缓存曲目（曲名/歌手/大小/缓存时间）；
 * 单条删除（正在播放的会被 OfflineCache 拒绝并提示「正在播放，已跳过」）；
 * 底部「清空全部」二次确认并显示将释放多少空间。
 */

import { OfflineCache, CacheEntryInfo } from '../core/OfflineCache';
import { Tokens } from '../common/Tokens';
import { Dim } from '../common/Dimension';

@Component
export struct CachePage {
  @StorageProp('topAvoidHeight') topAvoidHeight: number = 0;
  @StorageProp('bottomAvoidHeight') bottomAvoidHeight: number = 0;
  @State entries: CacheEntryInfo[] = [];
  @State used: number = 0;
  @State quota: number = 0;
  @State notice: string = '';

  onClose: () => void = () => {};

  /** 避让区 px → vp（走 UIContext 实例方法，全局 px2vp 已弃用） */
  private avoidVp(px: number): number {
    return this.getUIContext().px2vp(px);
  }

  aboutToAppear(): void {
    this.refresh();
  }

  private refresh(): void {
    const cache = OfflineCache.shared();
    this.entries = cache.listEntries();
    this.used = cache.usedBytes();
    this.quota = cache.quotaBytes();
  }

  private fmtBytes(b: number): string {
    const gb: number = 1024 * 1024 * 1024;
    const mb: number = 1024 * 1024;
    if (b >= gb) {
      return (b / gb).toFixed(2) + ' GB';
    }
    if (b >= mb) {
      return (b / mb).toFixed(1) + ' MB';
    }
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  private fmtTime(ms: number): string {
    const d = new Date(ms);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hh = d.getHours();
    const mm = d.getMinutes();
    return d.getFullYear() + '-' + (month < 10 ? '0' : '') + month
      + '-' + (day < 10 ? '0' : '') + day
      + ' ' + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  /** 旧缓存没有旁挂曲名时回退显示 trackId */
  private displayName(e: CacheEntryInfo): string {
    return e.name !== undefined && e.name.length > 0 ? e.name : e.trackId;
  }

  private removeEntry(e: CacheEntryInfo): void {
    const ok = OfflineCache.shared().remove(e.trackId);
    if (!ok) {
      this.notice = '正在播放，已跳过';
    } else {
      this.notice = '已删除《' + this.displayName(e) + '》';
    }
    this.refresh();
  }

  private confirmClear(): void {
    this.getUIContext().showAlertDialog({
      title: '清空全部缓存',
      message: '将删除除正在播放外的全部 ' + this.entries.length + ' 首缓存，释放约 '
        + this.fmtBytes(this.used) + ' 空间。删除后再次播放会重新联网下载。',
      primaryButton: {
        value: '取消',
        action: (): void => {}
      },
      secondaryButton: {
        value: '清空',
        action: (): void => {
          const n = OfflineCache.shared().clearAll();
          this.notice = '已清空 ' + n + ' 首';
          this.refresh();
        }
      }
    });
  }

  @Builder
  entryRow(e: CacheEntryInfo) {
    Row({ space: Dim.s2 }) {
      Column({ space: Dim.s1 }) {
        Text(this.displayName(e))
          .fontSize(Dim.fsSub)
          .fontColor(Tokens.text1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text((e.artist ?? '') + ' · ' + this.fmtBytes(e.bytes) + ' · ' + this.fmtTime(e.savedAt))
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.text2)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      // 删除键：可点区域扩到 44vp（S4 §三，原来 28vp 太小）
      Button('删除')
        .height(Dim.touchMin)
        .fontSize(Dim.fsMinor)
        .backgroundColor(Tokens.panel2)
        .fontColor('#E5484D')
        .accessibilityText(`删除缓存 ${this.displayName(e)}`)
        .onClick(() => { this.removeEntry(e); })
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s2, bottom: Dim.s2 })
    .margin({ left: Dim.s3, right: Dim.s3, top: Dim.s2 })
    .borderRadius(Dim.radiusMd)
    .backgroundColor(Tokens.panel)
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .height(Dim.touchMin)
          .fontSize(Dim.fsBody)
          .backgroundColor(Tokens.panel)
          .fontColor(Tokens.text1)
          .accessibilityText('返回上一页')
          .onClick(() => { this.onClose(); })
        Blank()
        Text('离线缓存')
          .fontSize(Dim.fsSection)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text1)
      }
      .width('100%')
      .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s2, bottom: Dim.s2 })

      Column({ space: Dim.s2 }) {
        Row() {
          Text('已用 ' + this.fmtBytes(this.used)).fontSize(Dim.fsMinor).fontColor(Tokens.text2)
          Blank()
          Text('配额 ' + this.fmtBytes(this.quota)).fontSize(Dim.fsMinor).fontColor(Tokens.text2)
        }
        .width('100%')

        Progress({
          value: this.used,
          total: Math.max(1, this.quota),
          type: ProgressType.Linear
        })
          .color(Tokens.accent)
      }
      .width('100%')
      .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s2, bottom: Dim.s2 })

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(Dim.fsMinor)
          .fontColor(Tokens.accent)
          .width('100%')
          .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s0, bottom: Dim.s0 })
      }

      if (this.entries.length === 0) {
        Column({ space: Dim.s2 }) {
          Text('还没有缓存曲目').fontSize(Dim.fsSub).fontColor(Tokens.text2)
          Text('播放过的歌曲会自动缓存到这里').fontSize(Dim.fsCaption).fontColor(Tokens.text2)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List() {
          ForEach(this.entries, (e: CacheEntryInfo) => {
            ListItem() {
              this.entryRow(e)
            }
          }, (e: CacheEntryInfo) => e.trackId)
        }
        .width('100%')
        .layoutWeight(1)
      }

      Button('清空全部（' + this.fmtBytes(this.used) + '）')
        .width('90%')
        .height(Dim.touchMin)
        .fontSize(Dim.fsSub)
        .backgroundColor(Tokens.panel2)
        .fontColor('#E5484D')
        .enabled(this.entries.length > 0)
        .accessibilityText('清空全部离线缓存')
        .margin({ top: Dim.s2, bottom: Dim.s3 })
        .onClick(() => { this.confirmClear(); })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .padding({
      top: this.avoidVp(this.topAvoidHeight),
      bottom: this.avoidVp(this.bottomAvoidHeight)
    })
  }
}
