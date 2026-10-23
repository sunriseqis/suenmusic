/**
 * 离线缓存页（T10 收官第 ⑩ 条重造，2026-10-23 验收二次裁定）。
 *
 * **设计意图**：缓存是「后台静默下载、用户无需管理」的设施 ——
 * 播放过的歌自动落到 filesDir（`http.requestInStream` 流式通道，零系统通知），
 * 超配额自动按最久未使用淘汰。用户唯一关心的只有两件事：**占了多少、一键清空**。
 *
 * 验收二次裁定（2026-10-23）：用量卡 + 进度条布局错乱，全部移除 ——
 * 一行纯文本「缓存：已使用 X 上限 Y」+ 清空按钮，仅此而已。
 * web 端同口径（web 缓存只给用量与清空，不给逐条管理）。
 */

import { OfflineCache } from '../core/OfflineCache';
import { Tokens } from '../common/Tokens';
import { Dim } from '../common/Dimension';
import { WebButton, NeuBtnVariant, NeuBtnSize } from '../common/WebButtons';

@Component
export struct CachePage {
  @State used: number = 0;
  @State quota: number = 0;
  /** 缓存曲目数（清空按钮与说明行用） */
  @State count: number = 0;

  onClose: () => void = () => {};

  aboutToAppear(): void {
    this.refresh();
  }

  private refresh(): void {
    const cache = OfflineCache.shared();
    this.used = cache.usedBytes();
    this.quota = cache.quotaBytes();
    this.count = cache.listEntries().length;
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

  private confirmClear(): void {
    this.getUIContext().showAlertDialog({
      title: '清空离线缓存',
      message: '将删除全部 ' + this.count + ' 首缓存（正在播放的除外），释放约 '
        + this.fmtBytes(this.used) + ' 空间。之后播放会重新联网下载。',
      primaryButton: {
        value: '取消',
        action: (): void => {}
      },
      secondaryButton: {
        value: '清空',
        action: (): void => {
          OfflineCache.shared().clearAll();
          this.refresh();
        }
      }
    });
  }

  build() {
    Column() {
      // 头：返回 + 标题
      Row() {
        WebButton({
          labelStr: '返回',
          sizeKind: NeuBtnSize.MD,
          onTap: () => { this.onClose(); }
        })
          .accessibilityText('返回上一页')
        Blank()
        Text('离线缓存')
          .fontSize(Dim.fsSection)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text1)
      }
      .width('100%')
      .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s2, bottom: Dim.s2 })
      .alignItems(VerticalAlign.Center)

      // 用量：一行纯文本（验收口径「缓存：已使用 X 上限 Y」，无卡片无进度条）
      Text('缓存：已使用 ' + this.fmtBytes(this.used) + '　上限 ' + this.fmtBytes(this.quota))
        .fontSize(Dim.fsSub)
        .fontColor(Tokens.text1)
        .width('100%')
        .textAlign(TextAlign.Center)
        .padding({ top: Dim.s4, bottom: Dim.s1 })

      // 设计意图说明（为什么没有逐条管理）：一行小字足矣
      Text('播放过的歌曲会在后台自动缓存，无需手动管理；超过配额会自动清理最久未听的')
        .fontSize(Dim.fsCaption)
        .fontColor(Tokens.text2)
        .textAlign(TextAlign.Center)
        .padding({ left: Dim.s6, right: Dim.s6, top: Dim.s1, bottom: Dim.s1 })

      // 清空（唯一的管理动作；web `.v-danger` 同款透明底红字）
      WebButton({
        labelStr: '清空全部',
        variantKind: NeuBtnVariant.DANGER,
        sizeKind: NeuBtnSize.LG,
        blockFlag: true,
        disabledFlag: this.count === 0,
        onTap: () => { this.confirmClear(); }
      })
        .accessibilityText('清空全部离线缓存')
        .margin({ left: Dim.s5, right: Dim.s5, top: Dim.s4, bottom: Dim.s3 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    // 避让区由 NativeRoot 壳层 padding 统一处理（本页已收进内容区，勿再叠加）
  }
}
